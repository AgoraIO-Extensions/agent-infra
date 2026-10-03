import { createHash, randomUUID } from "node:crypto";
import {
	type ConversationDispatchExecutionStatusV1,
	parseTaskAuthorizationBoundaryV1,
	type TaskAuthorizationBoundaryV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

/** Immutable, body-free facts from the original Platform producer transaction. */
export interface LegacyTaskMetadataV1 {
	readonly executionId: string;
	readonly conversationId: string;
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly turnId: string;
	readonly sessionGeneration: number;
	readonly agentAuthorizationRevision: string;
	readonly modelConfigurationRevision: number | null;
	readonly modelOptionId: string | null;
	readonly reasoningLevel: string | null;
	readonly acceptedAt: string;
	readonly acceptanceAuditId: string;
	readonly traceId: string;
	readonly requestId: string;
	readonly idempotencyRecordId: string;
	readonly commandType: "message" | "regenerate";
	readonly requestDigest: string;
}

export interface LegacyTaskProducerEvidenceV1 {
	readonly schemaVersion: 1;
	readonly evidenceReference: string;
	readonly producerRevision: string;
	readonly metadataDigest: string;
	readonly principal: { readonly kind: "user"; readonly id: string };
	/** Must come from the historical acceptance snapshot, never today's roles. */
	readonly originalBoundary: TaskAuthorizationBoundaryV1 | null;
	/** Original Host operation digest, NOT the Platform command idempotency digest. */
	readonly originalOperationDigest: string;
	readonly hostSessionRef: string;
}

export type LegacyTaskProducerVerifierV1 = (input: {
	readonly evidenceReference: string;
	readonly metadata: LegacyTaskMetadataV1;
	readonly metadataDigest: string;
}) => Promise<unknown | null>;

export class LegacyTaskMigrationError extends Error {
	constructor() {
		super("Legacy task authorization evidence is unavailable");
	}
}

type Transaction = postgres.TransactionSql;
type JsonValue = Parameters<ReturnType<typeof postgres>["json"]>[0];

function fail(): never {
	throw new LegacyTaskMigrationError();
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 2048;
}

function executionStatus(
	value: unknown,
): ConversationDispatchExecutionStatusV1 {
	if (
		value !== "submitted" &&
		value !== "processing" &&
		value !== "unknown" &&
		value !== "completed" &&
		value !== "failed" &&
		value !== "cancelled"
	)
		fail();
	return value;
}

function object(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) fail();
	const record = input as Record<string, unknown>;
	if (
		Object.keys(record).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(record, key))
	)
		fail();
	return record;
}

function canonical(input: unknown): unknown {
	if (Array.isArray(input)) return input.map(canonical);
	if (!input || typeof input !== "object") return input;
	return Object.fromEntries(
		Object.entries(input)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [key, canonical(value)]),
	);
}

function digest(input: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(input)))
		.digest("hex");
}

function parseEvidence(
	input: unknown,
	metadata: LegacyTaskMetadataV1,
): LegacyTaskProducerEvidenceV1 {
	const value = object(input, [
		"schemaVersion",
		"evidenceReference",
		"producerRevision",
		"metadataDigest",
		"principal",
		"originalBoundary",
		"originalOperationDigest",
		"hostSessionRef",
	]);
	const principal = object(value.principal, ["kind", "id"]);
	if (
		value.schemaVersion !== 1 ||
		!text(value.evidenceReference) ||
		!text(value.producerRevision) ||
		!text(value.hostSessionRef) ||
		value.metadataDigest !== digest(metadata) ||
		principal.kind !== "user" ||
		principal.id !== metadata.actorId ||
		typeof value.originalOperationDigest !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(value.originalOperationDigest)
	)
		fail();
	const boundary =
		value.originalBoundary === null
			? null
			: parseTaskAuthorizationBoundaryV1(value.originalBoundary);
	if (
		boundary &&
		(boundary.principal.kind !== "user" ||
			boundary.principal.id !== principal.id ||
			boundary.agentId !== metadata.agentId ||
			boundary.channelId !== metadata.channelId ||
			boundary.agentAuthorizationRevision !==
				metadata.agentAuthorizationRevision)
	)
		fail();
	return {
		schemaVersion: 1,
		evidenceReference: value.evidenceReference,
		producerRevision: value.producerRevision,
		metadataDigest: value.metadataDigest as string,
		principal: { kind: "user", id: metadata.actorId },
		originalBoundary: boundary,
		originalOperationDigest: value.originalOperationDigest,
		hostSessionRef: value.hostSessionRef,
	};
}

async function readHistoricalState(
	transaction: Transaction,
	executionId: string,
) {
	const rows = await transaction<
		{
			execution_id: string;
			conversation_id: string;
			agent_id: string;
			actor_id: string;
			channel_id: string;
			turn_id: string;
			session_generation: string;
			authorization_revision: string;
			model_configuration_revision: string | null;
			model_option_id: string | null;
			reasoning_level: string | null;
			created_at: Date;
			status: string;
			last_runtime_cursor: string | null;
			delivery_fence: string;
			current_generation: string;
			host_session_ref: string | null;
		}[]
	>`
		select execution.execution_id, execution.conversation_id, execution.agent_id, execution.actor_id,
			execution.channel_id, execution.turn_id, execution.session_generation, execution.authorization_revision,
			execution.model_configuration_revision, execution.model_option_id, execution.reasoning_level,
			execution.created_at, execution.status, execution.last_runtime_cursor, execution.delivery_fence,
			conversation.session_generation current_generation, conversation.host_session_ref
		from platform.conversation_executions execution
		join platform.conversations conversation on conversation.id = execution.conversation_id
			and conversation.agent_id = execution.agent_id and conversation.actor_id = execution.actor_id
			and conversation.channel_id = execution.channel_id
		where execution.execution_id = ${executionId}
	`;
	const [row] = rows;
	if (!row) return null;
	const audits = await transaction<
		{
			id: string;
			action: string;
			trace_id: string;
			request_id: string;
			occurred_at: Date;
		}[]
	>`
		select id, action, trace_id, request_id, occurred_at from platform.conversation_audit_events
		where execution_id = ${executionId} and conversation_id = ${row.conversation_id}
			and agent_id = ${row.agent_id} and actor_id = ${row.actor_id}
			and action in ('conversation.message.accepted', 'conversation.regeneration.accepted')
	`;
	const [audit] = audits;
	if (
		audits.length !== 1 ||
		!audit ||
		audit.occurred_at.getTime() !== row.created_at.getTime()
	)
		return null;
	const commandType =
		audit.action === "conversation.message.accepted" ? "message" : "regenerate";
	const records = await transaction<{ id: string; request_digest: string }[]>`
		select id, request_digest from platform.idempotency_records
		where scope_type = 'conversation' and scope_id = ${row.conversation_id} and actor_id = ${row.actor_id}
			and command_type = ${commandType} and status = 'completed'
			and result->>'executionId' = ${executionId} and result->>'schemaVersion' = '1'
			and result->>'status' = 'submitted' and created_at = ${row.created_at}
	`;
	const [record] = records;
	if (
		records.length !== 1 ||
		!record ||
		!/^[a-f0-9]{64}$/.test(record.request_digest)
	)
		return null;
	const metadata: LegacyTaskMetadataV1 = {
		executionId: row.execution_id,
		conversationId: row.conversation_id,
		agentId: row.agent_id,
		actorId: row.actor_id,
		channelId: row.channel_id,
		turnId: row.turn_id,
		sessionGeneration: Number(row.session_generation),
		agentAuthorizationRevision: row.authorization_revision,
		modelConfigurationRevision:
			row.model_configuration_revision === null
				? null
				: Number(row.model_configuration_revision),
		modelOptionId: row.model_option_id,
		reasoningLevel: row.reasoning_level,
		acceptedAt: row.created_at.toISOString(),
		acceptanceAuditId: audit.id,
		traceId: audit.trace_id,
		requestId: audit.request_id,
		idempotencyRecordId: record.id,
		commandType,
		requestDigest: record.request_digest,
	};
	return {
		metadata,
		status: executionStatus(row.status),
		runtimeCursor: row.last_runtime_cursor,
		deliveryFence: Number(row.delivery_fence),
		currentGeneration: Number(row.current_generation),
		currentHostSessionRef: row.host_session_ref,
	};
}

/**
 * Protected deployment migration; deliberately has no HTTP adapter or default verifier.
 * The verifier must authenticate a known producer version and its immutable historical
 * evidence, including original identity kind, scope, and Host digest. Merely echoing
 * supplied metadata, recognizing an actor_id, or querying current roles is insufficient.
 */
export class PostgresLegacyTaskAuthorizationMigrationV1 {
	readonly #client;
	readonly #verify: LegacyTaskProducerVerifierV1;

	constructor(options: {
		databaseUrl: string;
		verifyProducerEvidence: LegacyTaskProducerVerifierV1;
	}) {
		if (typeof options.verifyProducerEvidence !== "function") fail();
		this.#client = postgres(options.databaseUrl, { max: 3 });
		this.#verify = options.verifyProducerEvidence;
	}

	async migrate(input: {
		executionId: string;
		evidenceReference: string;
		migrationId: string;
	}) {
		try {
			if (
				![input.executionId, input.evidenceReference, input.migrationId].every(
					text,
				)
			)
				fail();
			const initial = await this.#client.begin(
				"isolation level repeatable read read only",
				(transaction) => readHistoricalState(transaction, input.executionId),
			);
			if (!initial) return { outcome: "unproven" as const };
			// Verify outside the locking transaction; recheck the immutable facts under locks.
			const verified = await this.#verify({
				evidenceReference: input.evidenceReference,
				metadata: structuredClone(initial.metadata),
				metadataDigest: digest(initial.metadata),
			});
			if (verified === null) return { outcome: "unproven" as const };
			const evidence = parseEvidence(verified, initial.metadata);
			if (evidence.evidenceReference !== input.evidenceReference) fail();
			return await this.#client.begin(async (transaction) => {
				await transaction`select set_config('lock_timeout', '5s', true)`;
				await transaction`select conversation.id from platform.conversations conversation join platform.conversation_executions execution on execution.conversation_id = conversation.id where execution.execution_id = ${input.executionId} for update of conversation`;
				await transaction`select execution_id from platform.conversation_executions where execution_id = ${input.executionId} for update`;
				await transaction`select id from platform.conversation_audit_events where execution_id = ${input.executionId} for share`;
				await transaction`select id from platform.idempotency_records where id = ${initial.metadata.idempotencyRecordId} for share`;
				const state = await readHistoricalState(transaction, input.executionId);
				if (
					!state ||
					digest(state.metadata) !== evidence.metadataDigest ||
					(state.currentGeneration === state.metadata.sessionGeneration &&
						state.currentHostSessionRef !== evidence.hostSessionRef)
				)
					fail();
				const { metadata } = state;
				const details = {
					schemaVersion: 1,
					migrationId: input.migrationId,
					evidence,
				};
				const prior = await transaction<
					{
						id: string;
						details: unknown;
						actor_type: string;
						actor_id: string;
						outcome: string;
						agent_id: string;
						trace_id: string;
						request_id: string;
					}[]
				>`
					select id, details, actor_type, actor_id, outcome, agent_id, trace_id, request_id from platform.audit_events where action = 'task.legacy_principal.migrated'
					and target_type = 'execution' and target_id = ${input.executionId}
				`;
				const [authorization] = await transaction<
					{ id: string; boundary: unknown }[]
				>`select id, boundary from platform.task_authorization_records where execution_id = ${input.executionId}`;
				const [previous] = prior;
				if (previous) {
					if (
						prior.length !== 1 ||
						previous.actor_type !== "system" ||
						previous.actor_id !== "platform_legacy_migration" ||
						previous.outcome !== "succeeded" ||
						previous.agent_id !== metadata.agentId ||
						previous.trace_id !== metadata.traceId ||
						previous.request_id !== metadata.requestId ||
						digest(previous.details) !== digest(details)
					)
						fail();
					if (evidence.originalBoundary) {
						if (
							!authorization ||
							digest(
								parseTaskAuthorizationBoundaryV1(authorization.boundary),
							) !== digest(evidence.originalBoundary)
						)
							fail();
						await requireAcceptanceAudit(
							transaction,
							metadata,
							authorization.id,
							previous.id,
						);
					} else if (authorization) fail();
					return {
						outcome: "replayed" as const,
						migrationRecordId: previous.id,
						authorizationRecordId: authorization?.id ?? null,
					};
				}
				if (authorization) fail();
				const migrationRecordId = randomUUID();
				let authorizationRecordId: string | null = null;
				if (evidence.originalBoundary) {
					authorizationRecordId = randomUUID();
					await transaction`insert into platform.task_authorization_records (id, execution_id, boundary)
						values (${authorizationRecordId}, ${input.executionId}, ${transaction.json(evidence.originalBoundary as unknown as JsonValue)})`;
					await transaction`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
						values (${randomUUID()}, ${metadata.traceId}, 'user', ${evidence.principal.id}, 'task.authorization.accepted', 'execution', ${input.executionId}, 'succeeded', ${metadata.requestId}, ${metadata.agentId}, ${transaction.json({ authorizationRecordId, migrationRecordId, identityRevision: evidence.originalBoundary.identityRevision, agentAuthorizationRevision: evidence.originalBoundary.agentAuthorizationRevision })})`;
				}
				await transaction`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
					values (${migrationRecordId}, ${metadata.traceId}, 'system', 'platform_legacy_migration', 'task.legacy_principal.migrated', 'execution', ${input.executionId}, 'succeeded', ${metadata.requestId}, ${metadata.agentId}, ${transaction.json(details as unknown as JsonValue)})`;
				return {
					outcome: "migrated" as const,
					migrationRecordId,
					authorizationRecordId,
				};
			});
		} catch {
			fail();
		}
	}

	/** Control metadata only; this never establishes business authorization. */
	readLegacyControlRecovery(executionId: string) {
		return readLegacyControlRecovery(this.#client, executionId);
	}

	async close(): Promise<void> {
		await this.#client.end();
	}
}

async function requireAcceptanceAudit(
	transaction: Transaction,
	metadata: LegacyTaskMetadataV1,
	authorizationRecordId: string,
	migrationRecordId: string,
) {
	const audits =
		await transaction`select id from platform.audit_events where action = 'task.authorization.accepted'
		and target_type = 'execution' and target_id = ${metadata.executionId} and actor_type = 'user' and actor_id = ${metadata.actorId}
		and agent_id = ${metadata.agentId} and trace_id = ${metadata.traceId} and request_id = ${metadata.requestId} and outcome = 'succeeded'
		and details->>'authorizationRecordId' = ${authorizationRecordId} and details->>'migrationRecordId' = ${migrationRecordId}`;
	if (audits.length !== 1) fail();
}

/** Read-only deployment/Worker dependency; no verifier or migration mutation is exposed. */
export class PostgresLegacyTaskRecoveryReaderV1 {
	readonly #client;
	constructor(options: { databaseUrl: string }) {
		this.#client = postgres(options.databaseUrl, { max: 3 });
	}
	readLegacyControlRecovery(executionId: string) {
		return readLegacyControlRecovery(this.#client, executionId);
	}
	async close(): Promise<void> {
		await this.#client.end();
	}
}

async function readLegacyControlRecovery(
	client: ReturnType<typeof postgres>,
	executionId: string,
) {
	try {
		if (!text(executionId)) fail();
		return await client.begin(
			"isolation level repeatable read read only",
			async (transaction) => {
				return readLegacyControlRecoveryInTransaction(transaction, executionId);
			},
		);
	} catch {
		fail();
	}
}

export async function readLegacyControlRecoveryInTransaction(
	transaction: postgres.TransactionSql,
	executionId: string,
) {
	const state = await readHistoricalState(transaction, executionId);
	if (!state) return null;
	const records = await transaction<{ id: string; details: unknown }[]>`
					select id, details from platform.audit_events where action = 'task.legacy_principal.migrated'
					and target_type = 'execution' and target_id = ${executionId} and actor_type = 'system'
					and actor_id = 'platform_legacy_migration' and outcome = 'succeeded'
					and agent_id = ${state.metadata.agentId} and trace_id = ${state.metadata.traceId} and request_id = ${state.metadata.requestId}
				`;
	const [record] = records;
	if (!record) return null;
	if (records.length !== 1) fail();
	const details = object(record.details, [
		"schemaVersion",
		"migrationId",
		"evidence",
	]);
	if (details.schemaVersion !== 1 || !text(details.migrationId)) fail();
	const evidence = parseEvidence(details.evidence, state.metadata);
	if (
		state.currentGeneration === state.metadata.sessionGeneration &&
		evidence.hostSessionRef !== state.currentHostSessionRef
	)
		fail();
	const [deployment] = await transaction<
		{ configuration_revision: string; workload: unknown }[]
	>`
						select agent.current_configuration_revision configuration_revision, workload.state workload
						from platform.agents agent left join platform.workload_reconciliations workload on workload.agent_id = agent.id
						where agent.id = ${state.metadata.agentId}
					`;
	const workload = deployment
		? decodePersistedWorkloadStateV1(
				deployment.workload,
				state.metadata.agentId,
			)
		: null;
	return {
		configurationRevision: deployment
			? Number(deployment.configuration_revision)
			: null,
		workload: workload && !workload.legacy ? workload.state : null,
		migrationRecordId: record.id,
		migrationId: details.migrationId,
		originalPrincipal: evidence.principal,
		agentId: state.metadata.agentId,
		conversationId: state.metadata.conversationId,
		executionId,
		turnId: state.metadata.turnId,
		channelId: state.metadata.channelId,
		sessionGeneration: state.metadata.sessionGeneration,
		hostSessionRef: evidence.hostSessionRef,
		originalOperationDigest: evidence.originalOperationDigest,
		executionStatus: state.status,
		runtimeCursor: state.runtimeCursor,
		deliveryFence: state.deliveryFence,
	};
}
