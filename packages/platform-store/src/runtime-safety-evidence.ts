import { createHash, randomUUID } from "node:crypto";

import {
	type RuntimePersistedSafetyEvidenceV1,
	RuntimePersistedSafetyEvidenceV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	type RuntimeSafetyEvidenceReadAuditV1,
	runtimeSafetyEvidenceReadAuditV1,
} from "@agent-infra/platform-core";

import postgres from "./observed-postgres.js";

/** Key order independent; the stored digest identifies the exact accepted record. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [
					key,
					canonical((value as Record<string, unknown>)[key]),
				]),
		);
	return value;
}

export function runtimeSafetyEvidenceDigestV1(
	record: RuntimePersistedSafetyEvidenceV1,
): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(record)))
		.digest("hex");
}

/**
 * Engineering Spec §18.5.1: append-only Platform record of Worker-validated safety evidence.
 * It is never joined into conversation events, history or SSE.
 */
export class PostgresRuntimeSafetyEvidenceStoreV1 {
	readonly #client: ReturnType<typeof postgres>;

	constructor(input: { readonly databaseUrl: string }) {
		this.#client = postgres(input.databaseUrl, { max: 2 });
	}

	async recordOnce(
		value: RuntimePersistedSafetyEvidenceV1,
	): Promise<
		"recorded" | "duplicate" | "challenge_replay" | "evidence_conflict"
	> {
		const record = RuntimePersistedSafetyEvidenceV1Schema.parse(value);
		const digest = runtimeSafetyEvidenceDigestV1(record);
		const { binding } = record;
		const inserted = await this.#client<{ evidence_id: string }[]>`
			insert into platform.runtime_safety_evidence (
				evidence_id, kind, code, agent_id, conversation_id, execution_id,
				challenge_ref, record, record_sha256
			) values (
				${binding.evidenceId}, ${record.kind}, ${record.code}, ${binding.agentId},
				${binding.conversationId}, ${binding.executionId}, ${binding.challengeRef},
				${this.#client.json(canonical(record) as postgres.JSONValue)}, ${digest}
			)
			on conflict do nothing
			returning evidence_id
		`;
		if (inserted.length === 1) return "recorded";
		const [existing] = await this.#client<{ record_sha256: string }[]>`
			select record_sha256 from platform.runtime_safety_evidence
			where evidence_id = ${binding.evidenceId}
		`;
		if (!existing) return "challenge_replay";
		return existing.record_sha256 === digest
			? "duplicate"
			: "evidence_conflict";
	}

	/**
	 * Reads one record of the given Execution. The caller has already confirmed the current
	 * read permission and confirms it again before responding (§18.5.1 读取).
	 */
	async read(input: {
		readonly conversationId: string;
		readonly executionId: string;
		readonly evidenceId: string;
	}): Promise<RuntimePersistedSafetyEvidenceV1 | undefined> {
		const [row] = await this.#client<
			{ record: unknown; record_sha256: string }[]
		>`
			select record, record_sha256 from platform.runtime_safety_evidence
			where evidence_id = ${input.evidenceId}
				and conversation_id = ${input.conversationId}
				and execution_id = ${input.executionId}
		`;
		if (!row) return undefined;
		const record = RuntimePersistedSafetyEvidenceV1Schema.parse(row.record);
		if (runtimeSafetyEvidenceDigestV1(record) !== row.record_sha256)
			throw new Error("RUNTIME_SAFETY_EVIDENCE_DIGEST_MISMATCH");
		return record;
	}

	/**
	 * Engineering Spec §18.3: the necessary audit of one evidence read, written before the API
	 * responds. A failure propagates, so the read never answers 200 without its audit. Only the
	 * trusted subject, the confirmed original scope and the fixed result are stored.
	 */
	async recordReadAudit(
		event: RuntimeSafetyEvidenceReadAuditV1,
	): Promise<void> {
		const audit = runtimeSafetyEvidenceReadAuditV1(
			event.outcome === "succeeded" && event.target
				? { ...event, outcome: "succeeded", target: event.target }
				: {
						...event,
						outcome: event.outcome === "failed" ? "failed" : "rejected",
					},
		);
		const details = audit.target
			? {
					schemaVersion: 1,
					conversationId: audit.target.conversationId,
					executionId: audit.target.executionId,
				}
			: { schemaVersion: 1, reason: audit.reason };
		await this.#client`
			insert into platform.audit_events (
				id, trace_id, request_id, actor_type, actor_id, action, target_type, target_id,
				outcome, agent_id, details
			) values (
				${randomUUID()}, ${audit.traceId}, ${audit.requestId}, ${audit.principal.kind},
				${audit.principal.id}, ${audit.action}, 'runtime_evidence',
				${audit.target?.evidenceRef ?? "unconfirmed"}, ${audit.outcome},
				${audit.target?.agentId ?? null}, ${this.#client.json(details as postgres.JSONValue)}
			)
		`;
	}

	async close(): Promise<void> {
		await this.#client.end({ timeout: 5 });
	}
}
