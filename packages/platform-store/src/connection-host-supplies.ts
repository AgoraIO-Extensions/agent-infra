import postgres from "./observed-postgres.js";

type SupplyIdentity = { agentId: string; associationRevision: number };
type SupplyReceipt = { ref: string; revision: string };

/** Local supply facts only. Reconciliation never retrieves a credential or calls Connection. */
export class PostgresConnectionHostSupplyStoreV1 {
	readonly #sql: ReturnType<typeof postgres>;
	constructor(databaseUrl: string) {
		this.#sql = postgres(databaseUrl, { max: 2 });
	}

	async reserve(scope: SupplyIdentity, systemFingerprint: string) {
		const [inserted] = await this.#sql`
			insert into platform.connection_host_supplies (agent_id, association_revision, system_fingerprint, state)
			select agent_id, association_revision, ${systemFingerprint}, 'writing'
			from platform.connection_manual_associations
			where agent_id = ${scope.agentId} and association_revision = ${scope.associationRevision}
			for share
			on conflict do nothing returning agent_id
		`;
		if (inserted) return { state: "reserved" as const };
		const [row] = await this.#sql<SupplyReceipt[]>`
			select s.ref, s.revision from platform.connection_host_supplies s
			join platform.connection_manual_associations m using (agent_id, association_revision)
			where s.agent_id = ${scope.agentId} and s.association_revision = ${scope.associationRevision}
				and s.system_fingerprint = ${systemFingerprint} and s.state = 'available'
		`;
		return row
			? { state: "available" as const, receipt: row }
			: { state: "unavailable" as const };
	}

	async publish(scope: SupplyIdentity, receipt: SupplyReceipt) {
		const [row] = await this.#sql`
			update platform.connection_host_supplies s
			set state = 'available', ref = ${receipt.ref}, revision = ${receipt.revision}, updated_at = clock_timestamp()
			from platform.connection_manual_associations m
			where s.agent_id = ${scope.agentId} and s.association_revision = ${scope.associationRevision}
				and s.state = 'writing' and m.agent_id = s.agent_id and m.association_revision = s.association_revision
			returning s.agent_id
		`;
		return row !== undefined;
	}

	async fence(scope: SupplyIdentity) {
		await this.#sql`
			update platform.connection_host_supplies
			set state = 'cleanup_pending', updated_at = clock_timestamp()
			where agent_id = ${scope.agentId} and association_revision = ${scope.associationRevision}
				and state in ('writing', 'available')
		`;
	}

	async cleanupResult(
		scope: SupplyIdentity,
		outcome: "closed" | "cleanup_unknown",
	) {
		await this.#sql`
			update platform.connection_host_supplies
			set state = ${outcome}, updated_at = clock_timestamp()
			where agent_id = ${scope.agentId} and association_revision = ${scope.associationRevision}
				and state in ('cleanup_pending', 'cleanup_unknown')
		`;
	}

	/** Claim one original revision. The Host's idempotent local fence may safely be retried. */
	async claimCleanup(): Promise<SupplyIdentity | undefined> {
		const [row] = await this.#sql<
			{ agent_id: string; association_revision: string }[]
		>`
			with candidate as (
				select agent_id, association_revision from platform.connection_host_supplies
				where state = 'cleanup_pending'
					or (state = 'cleanup_unknown' and updated_at < clock_timestamp() - interval '30 seconds')
					or (state = 'writing' and updated_at < clock_timestamp() - interval '5 minutes')
				order by updated_at, agent_id, association_revision
				limit 1 for update skip locked
			)
			update platform.connection_host_supplies s set state = 'cleanup_unknown', updated_at = clock_timestamp()
			from candidate
			where s.agent_id = candidate.agent_id and s.association_revision = candidate.association_revision
			returning s.agent_id, s.association_revision
		`;
		return (
			row && {
				agentId: row.agent_id,
				associationRevision: Number(row.association_revision),
			}
		);
	}

	close() {
		return this.#sql.end();
	}
}
