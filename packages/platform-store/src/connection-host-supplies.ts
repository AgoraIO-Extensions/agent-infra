import { randomUUID } from "node:crypto";
import postgres from "./observed-postgres.js";

type SupplyIdentity = { agentId: string; associationRevision: number };
type SupplyAttempt = SupplyIdentity & { attemptId: string };
type SupplyReceipt = { ref: string; revision: string };
type SupplyApproval = {
	systemFingerprint: string;
	source: { ref: string; revision: string };
};
type SupplyRow = {
	attempt_id: string;
	system_fingerprint: string;
	approval_source_ref: string;
	approval_source_revision: string;
	state: string;
	ref: string | null;
	revision: string | null;
};

/** Local supply facts. The prepare caller owns the protected Host operations. */
export class PostgresConnectionHostSupplyStoreV1 {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(databaseUrl: string) {
		this.#sql = postgres(databaseUrl, { max: 2 });
	}

	async reserve(scope: SupplyIdentity, approval: SupplyApproval) {
		return this.#sql.begin(async (sql) => {
			const [association] = await sql`
				select agent_id from platform.connection_manual_associations
				where agent_id = ${scope.agentId} and association_revision = ${scope.associationRevision}
				for update
			`;
			if (!association) return { state: "unavailable" as const };
			const [row] = await sql<SupplyRow[]>`
				select attempt_id, system_fingerprint, approval_source_ref, approval_source_revision, state, ref, revision
				from platform.connection_host_supplies
				where agent_id = ${scope.agentId} and association_revision = ${scope.associationRevision}
				for update
			`;
			if (row && row.state !== "closed") {
				const sameApproval =
					row.system_fingerprint === approval.systemFingerprint &&
					row.approval_source_ref === approval.source.ref &&
					row.approval_source_revision === approval.source.revision;
				if (
					sameApproval &&
					row.state === "available" &&
					row.ref &&
					row.revision
				)
					return {
						state: "available" as const,
						attempt: { ...scope, attemptId: row.attempt_id },
						receipt: { ref: row.ref, revision: row.revision },
					};
				if (
					!sameApproval &&
					(row.state === "available" || row.state === "writing")
				) {
					await sql`
						update platform.connection_host_supplies
						set state = 'cleanup_pending', updated_at = clock_timestamp()
						where agent_id = ${scope.agentId} and association_revision = ${scope.associationRevision}
					`;
				}
				return { state: "unavailable" as const };
			}
			const attemptId = randomUUID();
			await sql`
				insert into platform.connection_host_supplies
					(agent_id, association_revision, attempt_id, system_fingerprint, approval_source_ref, approval_source_revision, state)
				values (${scope.agentId}, ${scope.associationRevision}, ${attemptId},
					${approval.systemFingerprint}, ${approval.source.ref}, ${approval.source.revision}, 'writing')
				on conflict (agent_id, association_revision) do update
				set attempt_id = excluded.attempt_id, system_fingerprint = excluded.system_fingerprint,
					approval_source_ref = excluded.approval_source_ref, approval_source_revision = excluded.approval_source_revision,
					state = 'writing', ref = null, revision = null, updated_at = clock_timestamp()
			`;
			return { state: "reserved" as const, attempt: { ...scope, attemptId } };
		});
	}

	async publish(attempt: SupplyAttempt, receipt: SupplyReceipt) {
		const [row] = await this.#sql`
			update platform.connection_host_supplies s
			set state = 'available', ref = ${receipt.ref}, revision = ${receipt.revision}, updated_at = clock_timestamp()
			from platform.connection_manual_associations m
			where s.agent_id = ${attempt.agentId} and s.association_revision = ${attempt.associationRevision}
				and s.attempt_id = ${attempt.attemptId} and s.state = 'writing'
				and m.agent_id = s.agent_id and m.association_revision = s.association_revision
			returning s.agent_id
		`;
		return row !== undefined;
	}

	/** Close the original attempt in Store before contacting the receiver. */
	async fence(attempt: SupplyAttempt) {
		const [row] = await this.#sql`
			update platform.connection_host_supplies
			set state = 'cleanup_pending', updated_at = clock_timestamp()
			where agent_id = ${attempt.agentId} and association_revision = ${attempt.associationRevision}
				and attempt_id = ${attempt.attemptId}
				and state in ('writing', 'available', 'cleanup_pending', 'cleanup_unknown')
			returning agent_id
		`;
		return row !== undefined;
	}

	async cleanupResult(
		attempt: SupplyAttempt,
		outcome: "closed" | "cleanup_unknown",
	) {
		const [row] = await this.#sql`
			update platform.connection_host_supplies
			set state = ${outcome}, updated_at = clock_timestamp()
			where agent_id = ${attempt.agentId} and association_revision = ${attempt.associationRevision}
				and attempt_id = ${attempt.attemptId}
				and state in ('cleanup_pending', 'cleanup_unknown')
			returning agent_id
		`;
		return row !== undefined;
	}

	/** Includes supplies orphaned by an older application that did not enqueue cleanup. */
	async claimCleanup(): Promise<SupplyAttempt | undefined> {
		const [row] = await this.#sql<
			{ agent_id: string; association_revision: string; attempt_id: string }[]
		>`
			with candidate as (
				select s.agent_id, s.association_revision from platform.connection_host_supplies s
				where s.state = 'cleanup_pending'
					or (s.state = 'cleanup_unknown' and s.updated_at < clock_timestamp() - interval '30 seconds')
					or (s.state = 'writing' and s.updated_at < clock_timestamp() - interval '5 minutes')
					or (s.state in ('available', 'writing') and not exists (
						select 1 from platform.connection_manual_associations m
						where m.agent_id = s.agent_id and m.association_revision = s.association_revision
					))
				order by s.updated_at, s.agent_id, s.association_revision
				limit 1 for update skip locked
			)
			update platform.connection_host_supplies s set state = 'cleanup_unknown', updated_at = clock_timestamp()
			from candidate
			where s.agent_id = candidate.agent_id and s.association_revision = candidate.association_revision
			returning s.agent_id, s.association_revision, s.attempt_id
		`;
		return (
			row && {
				agentId: row.agent_id,
				associationRevision: Number(row.association_revision),
				attemptId: row.attempt_id,
			}
		);
	}

	close() {
		return this.#sql.end();
	}
}
