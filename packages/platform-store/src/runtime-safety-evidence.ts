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

/** The committed original binding of one Execution (see `readOriginalScope`). */
export interface RuntimeSafetyEvidenceOriginalScopeV1 {
	readonly agentId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly principal: {
		readonly kind: "user" | "application";
		readonly id: string;
	};
	readonly authorizationRecordId: string;
	readonly authorizationRevision: string;
	readonly revoked: boolean;
	readonly sessionGeneration: number;
	readonly executionDeliveryFence: number;
	readonly sandbox: {
		readonly ref: string;
		readonly resourceFence: number;
		readonly podUid: string;
		readonly executorEpoch?: string;
		readonly configurationRevision: number;
		readonly imageDigest: string;
	};
	readonly operations: readonly {
		readonly ref: string;
		readonly attemptRef: string;
	}[];
}

/** Evidence never makes a business write wait: a busy row leaves the entry in the Host log. */
const evidenceLockTimeout = "200ms";

/**
 * Engineering Spec §18.5.1: append-only Platform record of Worker-validated safety evidence.
 * It is never joined into conversation events, history or SSE.
 */
export class PostgresRuntimeSafetyEvidenceStoreV1 {
	readonly #client: ReturnType<typeof postgres>;

	constructor(input: { readonly databaseUrl: string }) {
		this.#client = postgres(input.databaseUrl, { max: 2 });
	}

	/**
	 * Stores one Worker-admitted record if, in the same transaction, the Execution's committed
	 * original binding still matches it (#4358 S1). The authorization, Execution and Session
	 * Sandbox rows are read `FOR SHARE`, so a revocation or a generation/fence change either
	 * commits first and the record is refused, or waits until the record is stored. The Host
	 * configuration and image come from the Sandbox's verified policy, never the Agent's
	 * current configuration. A record already stored identically stays a duplicate.
	 */
	async recordOnce(
		value: RuntimePersistedSafetyEvidenceV1,
	): Promise<
		| "recorded"
		| "duplicate"
		| "challenge_replay"
		| "evidence_conflict"
		| "revoked"
		| "stale_binding"
		| "scope_mismatch"
	> {
		const record = RuntimePersistedSafetyEvidenceV1Schema.parse(value);
		const digest = runtimeSafetyEvidenceDigestV1(record);
		const { binding } = record;
		return this.#client.begin(async (transaction) => {
			// A lock timeout fails this evidence write (retried on the next drain) instead of
			// ever holding or aborting a business transaction on the same rows.
			await transaction`select set_config('lock_timeout', ${evidenceLockTimeout}, true)`;
			const existing = async () => {
				const [row] = await transaction<{ record_sha256: string }[]>`
					select record_sha256 from platform.runtime_safety_evidence
					where evidence_id = ${binding.evidenceId}
				`;
				return row;
			};
			const issue = await originalBindingIssue(transaction, binding);
			if (issue) {
				const stored = await existing();
				return stored?.record_sha256 === digest ? "duplicate" : issue;
			}
			const inserted = await transaction<{ evidence_id: string }[]>`
				insert into platform.runtime_safety_evidence (
					evidence_id, kind, code, agent_id, conversation_id, execution_id,
					challenge_ref, record, record_sha256
				) values (
					${binding.evidenceId}, ${record.kind}, ${record.code}, ${binding.agentId},
					${binding.conversationId}, ${binding.executionId}, ${binding.challengeRef},
					${transaction.json(canonical(record) as postgres.JSONValue)}, ${digest}
				)
				on conflict do nothing
				returning evidence_id
			`;
			if (inserted.length === 1) return "recorded";
			const stored = await existing();
			if (!stored) return "challenge_replay";
			return stored.record_sha256 === digest
				? "duplicate"
				: "evidence_conflict";
		});
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

	/**
	 * The original operation/attempt pairs of one Execution, as its committed Runtime operation
	 * facts recorded them. Evidence may bind only to one of these (§18.5.1 共同绑定).
	 */
	async readExecutionOperationAttempts(input: {
		readonly conversationId: string;
		readonly executionId: string;
	}): Promise<
		readonly { readonly ref: string; readonly attemptRef: string }[]
	> {
		const rows = await this.#client<
			{ operation_ref: unknown; attempt_ref: unknown }[]
		>`
			select distinct
				event_payload->'fact'->>'operationRef' as operation_ref,
				event_payload->'fact'->>'attemptRef' as attempt_ref
			from platform.conversation_events
			where conversation_id = ${input.conversationId}
				and execution_id = ${input.executionId}
				and source = 'runtime'
				and event_type = 'execution.operation'
			limit 4096
		`;
		return rows.flatMap((row) =>
			typeof row.operation_ref === "string" &&
			row.operation_ref &&
			typeof row.attempt_ref === "string" &&
			row.attempt_ref
				? [{ ref: row.operation_ref, attemptRef: row.attempt_ref }]
				: [],
		);
	}

	/**
	 * The committed original binding of one Execution of the Conversation, for the Worker's
	 * per-record scope (#4367): the Execution, its task authorization and original subject, and
	 * the Session Sandbox's verified policy and observed Pod. Undefined when any of them is not
	 * committed, so the record stays unconfirmed in the Host log.
	 */
	async readOriginalScope(input: {
		readonly conversationId: string;
		readonly executionId: string;
	}): Promise<RuntimeSafetyEvidenceOriginalScopeV1 | undefined> {
		const [row] = await this.#client<
			{
				agent_id: string;
				session_generation: string;
				delivery_fence: string;
				authorization_revision: string;
				sandbox_id: string;
				authorization_record_id: string;
				revoked: boolean;
				principal: unknown;
				resource_fence: string;
				resource_policy: unknown;
				resource_observation: unknown;
			}[]
		>`
			select e.agent_id, e.session_generation::text, e.delivery_fence::text,
				e.authorization_revision, e.sandbox_id, a.id as authorization_record_id,
				a.revoked_at is not null as revoked, a.boundary->'principal' as principal,
				s.resource_fence::text, s.resource_policy, s.resource_observation
			from platform.conversation_executions e
			join platform.task_authorization_records a on a.execution_id = e.execution_id
			join platform.session_sandbox_allocations s
				on s.sandbox_id = e.sandbox_id and s.conversation_id = e.conversation_id
			where e.execution_id = ${input.executionId}
				and e.conversation_id = ${input.conversationId}
		`;
		const principal = row?.principal as
			| { kind?: unknown; id?: unknown }
			| null
			| undefined;
		const policy = row?.resource_policy as
			| { configurationRevision?: unknown; imageDigest?: unknown }
			| null
			| undefined;
		const podUid = row ? sandboxPodUid(row.resource_observation) : undefined;
		if (
			!row ||
			(principal?.kind !== "user" && principal?.kind !== "application") ||
			typeof principal.id !== "string" ||
			!principal.id ||
			typeof policy?.configurationRevision !== "number" ||
			typeof policy.imageDigest !== "string" ||
			!podUid
		)
			return undefined;
		const executorEpoch = sandboxEpoch(row.resource_observation);
		return {
			agentId: row.agent_id,
			conversationId: input.conversationId,
			executionId: input.executionId,
			principal: { kind: principal.kind, id: principal.id },
			authorizationRecordId: row.authorization_record_id,
			authorizationRevision: row.authorization_revision,
			revoked: row.revoked,
			sessionGeneration: Number(row.session_generation),
			executionDeliveryFence: Number(row.delivery_fence),
			sandbox: {
				ref: row.sandbox_id,
				resourceFence: Number(row.resource_fence),
				podUid,
				...(executorEpoch === undefined ? {} : { executorEpoch }),
				configurationRevision: policy.configurationRevision,
				imageDigest: policy.imageDigest,
			},
			operations: await this.readExecutionOperationAttempts(input),
		};
	}

	async close(): Promise<void> {
		await this.#client.end({ timeout: 5 });
	}
}

type Transaction = postgres.TransactionSql;

function sandboxPodUid(observation: unknown): string | undefined {
	if (!observation || typeof observation !== "object") return undefined;
	const value = observation as {
		executorInstance?: { podUid?: unknown };
		resources?: unknown;
	};
	if (typeof value.executorInstance?.podUid === "string")
		return value.executorInstance.podUid;
	if (!Array.isArray(value.resources)) return undefined;
	const pod = value.resources.find(
		(entry) =>
			entry &&
			typeof entry === "object" &&
			(entry as { kind?: unknown }).kind === "Pod",
	) as { uid?: unknown } | undefined;
	return typeof pod?.uid === "string" ? pod.uid : undefined;
}

function sandboxEpoch(observation: unknown): string | undefined {
	if (!observation || typeof observation !== "object") return undefined;
	const epoch = (observation as { executorInstance?: { epoch?: unknown } })
		.executorInstance?.epoch;
	return typeof epoch === "string" ? epoch : undefined;
}

/** Compares a record's binding with the Execution's committed original binding. */
async function originalBindingIssue(
	transaction: Transaction,
	binding: RuntimePersistedSafetyEvidenceV1["binding"],
): Promise<"revoked" | "stale_binding" | "scope_mismatch" | undefined> {
	const [execution] = await transaction<
		{
			conversation_id: string;
			agent_id: string;
			session_generation: string;
			delivery_fence: string;
			authorization_revision: string;
			sandbox_id: string | null;
		}[]
	>`
		select conversation_id, agent_id, session_generation::text, delivery_fence::text,
			authorization_revision, sandbox_id
		from platform.conversation_executions
		where execution_id = ${binding.executionId}
		for share
	`;
	if (
		!execution ||
		execution.conversation_id !== binding.conversationId ||
		execution.agent_id !== binding.agentId ||
		!binding.authorization ||
		execution.authorization_revision !== binding.authorization.revision
	)
		return "scope_mismatch";
	const [authorization] = await transaction<{ id: string; revoked: boolean }[]>`
		select id, revoked_at is not null as revoked
		from platform.task_authorization_records
		where execution_id = ${binding.executionId}
		for share
	`;
	if (!authorization || authorization.id !== binding.authorization.recordId)
		return "scope_mismatch";
	if (authorization.revoked) return "revoked";
	if (
		execution.session_generation !== String(binding.sessionGeneration) ||
		execution.delivery_fence !== String(binding.executionDeliveryFence) ||
		execution.sandbox_id !== binding.sandbox.ref
	)
		return "stale_binding";
	const [sandbox] = await transaction<
		{
			session_generation: string;
			resource_fence: string;
			resource_policy: unknown;
			resource_observation: unknown;
		}[]
	>`
		select session_generation::text, resource_fence::text, resource_policy,
			resource_observation
		from platform.session_sandbox_allocations
		where sandbox_id = ${binding.sandbox.ref}
			and conversation_id = ${binding.conversationId}
		for share
	`;
	const policy = sandbox?.resource_policy as
		| { configurationRevision?: unknown; imageDigest?: unknown }
		| null
		| undefined;
	if (
		!sandbox ||
		sandbox.session_generation !== String(binding.sessionGeneration) ||
		sandbox.resource_fence !== String(binding.sandbox.resourceFence) ||
		sandboxPodUid(sandbox.resource_observation) !== binding.sandbox.podUid ||
		sandboxEpoch(sandbox.resource_observation) !==
			binding.sandbox.executorEpoch ||
		typeof policy?.configurationRevision !== "number" ||
		String(policy.configurationRevision) !==
			binding.host.configurationRevision ||
		policy.imageDigest !== binding.host.imageDigest
	)
		return "stale_binding";
	return undefined;
}
