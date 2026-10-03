import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
	type ApiPrincipalV1,
	type ConversationOperationFactV2,
	captureTaskAuthorizationBoundaryV1,
	type PersonalApiCredentialErrorCodeV1,
	PersonalApiCredentialErrorV1,
	type PlatformAuditQueryActionV1,
	type PlatformAuditQueryDenialReasonV1,
	type PlatformAuditQueryInputV1,
	type PlatformAuditQueryResultV1,
	type PlatformAuditQueryScopeV1,
	PlatformAuditScopeErrorV1,
	type PlatformExecutionAuditBindingV1,
	parsePersonalApiCredentialIssuanceV1,
	parsePlatformAuditQueryInputV1,
	parsePlatformAuditQueryScopeV1,
	platformAuditQueryActionsV1,
	platformAuditQueryResultsV1,
	projectPlatformAuditQueryDenialV1,
	projectPlatformAuditQueryRecordV1,
	projectPlatformAuditQuerySummaryV1,
	projectPlatformOperationAuditV1,
	projectPlatformTaskAuditSummaryV1,
	requirePlatformExecutionAuditBindingV1,
	type TaskApiAuditInputV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readAgentManagementState } from "./agent-management.js";
import { resolveApiAuditCredentialIdentityV1 } from "./api-audit-identity.js";
import {
	type AuditRow,
	decodePlatformAuditRowV1,
	type PlatformAuditProjectionV1,
} from "./audit.js";

export interface ScopedPlatformAuditProjectionV1 {
	readonly schemaVersion: 1;
	readonly auditId: string;
	readonly action: PlatformAuditQueryActionV1;
	readonly actor: PlatformAuditProjectionV1["actor"];
	readonly subject: {
		readonly kind:
			| PlatformAuditProjectionV1["subject"]["kind"]
			| "api_credential";
		readonly subjectId: string;
	};
	readonly result: PlatformAuditQueryResultV1;
	readonly summary: string;
	readonly taskApi: Pick<
		TaskApiAuditInputV1,
		"operation" | "phase" | "reason" | "subscriptionId"
	> | null;
	readonly occurredAt: Date;
	readonly traceId: string;
	readonly requestId: string | null;
	readonly agentId: string | null;
	readonly conversationId: string | null;
	readonly executionId: string | null;
	readonly authorizationRecordId: string | null;
	readonly originalPrincipal: ApiPrincipalV1 | null;
	readonly executor: "platform_worker" | null;
	readonly operation: {
		readonly eventId: string;
		readonly fact: ConversationOperationFactV2;
	} | null;
}

export interface ScopedPlatformAuditPageV1 {
	readonly items: readonly ScopedPlatformAuditProjectionV1[];
	readonly nextCursor: string | null;
}

export interface ScopedPlatformAuditRequestMetadataV1 {
	readonly requestId: string;
	readonly traceId: string;
}

type Transaction = postgres.TransactionSql;
type Row = AuditRow & {
	source: "platform" | "conversation";
	conversationId: string | null;
	executionId: string | null;
	result: PlatformAuditQueryResultV1;
	channelId: string | null;
	executionActorId: string | null;
	executionAgentId: string | null;
	authorizationRecordId: string | null;
	boundary: unknown;
	acceptedActorType: string | null;
	acceptedActorId: string | null;
	acceptedExecutionId: string | null;
	acceptedAgentId: string | null;
	acceptedAuthorizationRecordId: string | null;
	acceptanceCount: number | null;
	boundConversationId: string | null;
	requestId: string | null;
	agentId: string | null;
};

function deny(): never {
	throw new PlatformAuditScopeErrorV1("access_denied");
}

function boundedText(input: unknown): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		!input.includes("\0") &&
		String.prototype.isWellFormed.call(input) &&
		Buffer.byteLength(input, "utf8") <= 1024
	);
}

function fingerprint(
	scope: PlatformAuditQueryScopeV1,
	input: PlatformAuditQueryInputV1,
) {
	return createHash("sha256")
		.update(JSON.stringify([scope, input.filters, input.limit]))
		.digest("hex");
}

function encodeCursor(key: string, row: Row): string {
	return Buffer.from(
		JSON.stringify([1, key, row.source, row.auditId]),
	).toString("base64url");
}

function decodeCursor(
	value: string,
	key: string,
): readonly ["platform" | "conversation", string] {
	try {
		if (value.length > 4096) deny();
		const parsed: unknown = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		);
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 4 ||
			parsed[0] !== 1 ||
			parsed[1] !== key ||
			(parsed[2] !== "platform" && parsed[2] !== "conversation") ||
			typeof parsed[3] !== "string" ||
			parsed[3].trim() === "" ||
			Buffer.from(JSON.stringify(parsed)).toString("base64url") !== value
		)
			deny();
		return [parsed[2], parsed[3]];
	} catch {
		deny();
	}
}

/** Filtering happens before pagination. The same CTE is used for pages, details and anchors. */
function candidates(
	transaction: Transaction,
	scope: PlatformAuditQueryScopeV1,
	query: PlatformAuditQueryInputV1,
) {
	const filters = query.filters;
	const confirmedBinding = transaction`
		accepted.acceptance_count = 1 and accepted.actor_id = e.actor_id and accepted.agent_id = e.agent_id
		and accepted.details ->> 'authorizationRecordId' = r.id
		and accepted.actor_type = r.boundary -> 'principal' ->> 'kind'
		and accepted.actor_id = r.boundary -> 'principal' ->> 'id'
		and r.boundary ->> 'agentId' = e.agent_id and r.boundary ->> 'channelId' = e.channel_id`;
	const currentAccess =
		scope.kind === "administrator"
			? transaction`true`
			: scope.credential || scope.principal.kind === "application"
				? transaction`exists (select 1 from platform.agent_principal_grants g
				where g.agent_id = agent.id and g.principal_type = ${scope.principal.kind}
					and g.principal_id = ${scope.principal.id} and g.grant_type = 'use'
					and g.revoked_at is null and g.authorization_revision = agent.authorization_revision)`
				: transaction`(exists (select 1 from platform.agent_owners o where o.agent_id = agent.id and o.owner_id = ${scope.principal.id})
				or exists (select 1 from platform.agent_availability av where av.agent_id = agent.id
					and ((av.target_type = 'user' and av.target_id = ${scope.principal.id})
						or (av.target_type = 'organization' and av.target_id = any(${[...(scope.user?.organizationIds ?? [])]}::text[])))))`;
	const executionOwnership =
		scope.kind === "administrator"
			? transaction`true`
			: transaction`
		r.boundary -> 'principal' ->> 'kind' = ${scope.principal.kind}
		and r.boundary -> 'principal' ->> 'id' = ${scope.principal.id}
		and r.boundary ->> 'agentId' = e.agent_id and r.boundary ->> 'channelId' = e.channel_id
		and r.boundary -> 'principal' ->> 'id' = e.actor_id
		and ${confirmedBinding}
		and accepted.actor_type = ${scope.principal.kind}
		and accepted.actor_id = ${scope.principal.id}
		and a."agentId" = e.agent_id
		and (a.source <> 'conversation' or (a."conversationId" = e.conversation_id and a."actorId" = e.actor_id))
		and (a.source = 'conversation' or (a."actorType" = ${scope.principal.kind} and a."actorId" = ${scope.principal.id})
			or (a."actorType" = 'system' and a.action in ('task.status.changed', 'task.control.created', 'execution.operation.observed')))
		and ((${scope.principal.kind} = 'user' and e.channel_id not like 'api:%') or e.channel_id = ${`api:${scope.principal.kind}`})
		and agent.authorization_revision is not null
		and exists (select 1 from platform.agent_applications application where application.agent_id = e.agent_id)
		and ${currentAccess}`;
	// A trusted pre-admission API attempt has no Execution binding. Keep its
	// own Agent-target metadata visible without inventing that association.
	const ownership =
		scope.kind === "administrator"
			? transaction`true`
			: transaction`(
		${executionOwnership} or (
			a.source = 'platform' and a.action = 'task.api.access' and a."targetType" = 'agent'
			and a."actorType" = ${scope.principal.kind} and a."actorId" = ${scope.principal.id}
			and a.details ->> 'schemaVersion' = '1' and a.details ->> 'operation' = 'submit'
			and a.details ->> 'phase' = 'access' and a.details -> 'target' ->> 'kind' = 'agent'
			and a.details -> 'target' ->> 'agentId' = a."agentId" and a."targetId" = a."agentId"
			and agent.authorization_revision is not null
			and exists (select 1 from platform.agent_applications application where application.agent_id = agent.id)
			and ${currentAccess}
		)
	)`;
	return transaction`
		with records as (
			select 'platform'::text as source, id as "auditId", trace_id as "traceId", request_id as "requestId",
				actor_type as "actorType", actor_id as "actorId", action, target_type as "targetType", target_id as "targetId",
				outcome, agent_id as "agentId", occurred_at as "occurredAt", details,
				case when target_type = 'execution' then target_id else null end as "executionId",
				null::text as "conversationId",
				case when action = 'execution.operation.observed' then coalesce(details -> 'fact' ->> 'phase', 'unknown')
					when action = 'task.status.changed' then coalesce(details ->> 'status', 'unknown')
					when action in ('task.authorization.accepted','task.control.created') and outcome = 'succeeded' then 'accepted'
					else outcome::text end as result
			from platform.audit_events
			union all
			select 'conversation', id, trace_id, request_id, 'unknown', actor_id, action,
				case when execution_id is null then 'conversation' else 'execution' end,
				coalesce(execution_id, conversation_id), 'succeeded', agent_id, occurred_at, details, execution_id, conversation_id,
				case when action in ('conversation.task.accepted','conversation.message.accepted','conversation.regeneration.accepted','conversation.stop.accepted') then 'accepted'
					when action in ('conversation.model_selection.updated','conversation.model_selection.fell_back') then 'succeeded'
					else 'unknown' end
			from platform.conversation_audit_events
		), controlled as (
			select a.*, coalesce(a."conversationId", e.conversation_id) as "boundConversationId",
				e.actor_id as "executionActorId", e.agent_id as "executionAgentId", e.channel_id as "channelId",
				r.id as "authorizationRecordId", r.boundary,
				accepted.actor_type as "acceptedActorType", accepted.actor_id as "acceptedActorId",
				accepted.target_id as "acceptedExecutionId", accepted.agent_id as "acceptedAgentId",
				accepted.details ->> 'authorizationRecordId' as "acceptedAuthorizationRecordId",
				accepted.acceptance_count::int as "acceptanceCount"
			from records a
			left join platform.conversation_executions e on e.execution_id = a."executionId"
			left join platform.agents agent on agent.id = coalesce(e.agent_id, a."agentId")
			left join platform.task_authorization_records r on r.execution_id = e.execution_id
			left join lateral (
				select ac.*, count(*) over() as acceptance_count from platform.audit_events ac
				where ac.action = 'task.authorization.accepted' and ac.outcome = 'succeeded'
					and ac.target_type = 'execution' and ac.target_id = r.execution_id
				limit 1
			) accepted on true
			where ${ownership}
				and (${filters.from ?? null}::timestamptz is null or a."occurredAt" >= ${filters.from ?? null}::timestamptz)
				and (${filters.until ?? null}::timestamptz is null or a."occurredAt" < ${filters.until ?? null}::timestamptz)
				and (${filters.agentId ?? null}::text is null or a."agentId" = ${filters.agentId ?? null})
				and (${filters.executionId ?? null}::text is null or a."executionId" = ${filters.executionId ?? null})
				and (${filters.action ?? null}::text is null or a.action = ${filters.action ?? null})
				and (${filters.result ?? null}::text is null or a.result = ${filters.result ?? null})
				and (${filters.principal?.kind ?? null}::text is null or
					((case when ${confirmedBinding} then accepted.actor_type else a."actorType" end) = ${filters.principal?.kind ?? null}
						and (case when ${confirmedBinding} then accepted.actor_id else a."actorId" end) = ${filters.principal?.id ?? null}))
				and (r.id is null or accepted.acceptance_count is null or accepted.acceptance_count <> 1
					or accepted.details ->> 'authorizationRecordId' = r.id)
		)`;
}

function executionBinding(row: Row): PlatformExecutionAuditBindingV1 | null {
	if (
		row.acceptanceCount !== 1 ||
		!row.executionId ||
		!row.authorizationRecordId ||
		!row.executionAgentId ||
		!row.executionActorId ||
		!row.channelId ||
		!row.acceptedActorId ||
		!row.acceptedExecutionId ||
		!row.acceptedAgentId ||
		!row.acceptedAuthorizationRecordId ||
		(row.acceptedActorType !== "user" &&
			row.acceptedActorType !== "application")
	)
		return null;
	return {
		executionId: row.executionId,
		agentId: row.executionAgentId,
		actorId: row.executionActorId,
		channelId: row.channelId,
		authorizationRecordId: row.authorizationRecordId,
		boundary: row.boundary,
		acceptedActor: { kind: row.acceptedActorType, id: row.acceptedActorId },
		acceptedExecutionId: row.acceptedExecutionId,
		acceptedAgentId: row.acceptedAgentId,
		acceptedAuthorizationRecordId: row.acceptedAuthorizationRecordId,
	};
}

const executionActions = new Set([
	"relay_key.personal.read",
	"relay_key.personal.replace",
	"relay_key.personal.revoke",
	"task.authorization.accepted",
	"task.status.changed",
	"task.control.created",
	"execution.operation.observed",
	"conversation.task.accepted",
	"conversation.message.accepted",
	"conversation.regeneration.accepted",
	"conversation.stop.accepted",
	"conversation.model_selection.updated",
	"conversation.model_selection.fell_back",
	"conversation.task.status",
	"audit.query.completed",
	"audit.query.failed",
]);

function credentialMetadataSummary(
	row: Row,
	scope: PlatformAuditQueryScopeV1,
): string {
	if (
		scope.kind !== "administrator" ||
		row.source !== "platform" ||
		row.targetType !== "api_credential" ||
		row.targetId !== "unknown" ||
		row.agentId !== null ||
		row.executionId !== null ||
		row.conversationId !== null ||
		row.requestId === null ||
		row.result !== row.outcome ||
		!(
			row.actorType === "user" ||
			(row.actorType === "unknown" && row.actorId === "unknown")
		) ||
		typeof row.details !== "object" ||
		row.details === null ||
		Array.isArray(row.details)
	)
		throw new PlatformAuditScopeErrorV1("unavailable");
	const details = row.details as Record<string, unknown>;
	if (row.outcome === "succeeded") {
		const ids = details.returnedCredentialIds;
		if (
			row.actorType !== "user" ||
			Object.keys(details).length !== 1 ||
			!Array.isArray(ids) ||
			ids.length > 100 ||
			!ids.every(boundedText) ||
			new Set(ids).size !== ids.length
		)
			throw new PlatformAuditScopeErrorV1("unavailable");
		return row.action;
	}
	return credentialRefusalSummary(row, details);
}

function credentialRefusalSummary(
	row: Row,
	details: Record<string, unknown>,
): string {
	if (
		Object.keys(details).length !== 1 ||
		!(
			[
				"invalid_input",
				"authentication_required",
				"forbidden",
				"not_found",
				"idempotency_conflict",
				"unavailable",
			] satisfies readonly PersonalApiCredentialErrorCodeV1[]
		).some((reason) => reason === details.reason) ||
		row.outcome !== (details.reason === "unavailable" ? "failed" : "rejected")
	)
		throw new PlatformAuditScopeErrorV1("unavailable");
	return `${row.action}: reason=${details.reason}`;
}

function credentialMutationSummary(
	row: Row,
	scope: PlatformAuditQueryScopeV1,
): string {
	if (
		scope.kind !== "administrator" ||
		row.source !== "platform" ||
		row.targetType !== "api_credential" ||
		row.requestId === null ||
		row.agentId !== null ||
		row.executionId !== null ||
		row.conversationId !== null ||
		row.result !== row.outcome ||
		!(
			row.actorType === "user" ||
			(row.actorType === "unknown" &&
				row.actorId === "unknown" &&
				row.targetId === "unknown")
		) ||
		typeof row.details !== "object" ||
		row.details === null ||
		Array.isArray(row.details)
	)
		throw new PlatformAuditScopeErrorV1("unavailable");
	const details = row.details as Record<string, unknown>;
	if (row.outcome !== "succeeded")
		return credentialRefusalSummary(row, details);
	if (row.actorType !== "user" || row.targetId === "unknown")
		throw new PlatformAuditScopeErrorV1("unavailable");
	try {
		parsePersonalApiCredentialIssuanceV1(details);
	} catch {
		throw new PlatformAuditScopeErrorV1("unavailable");
	}
	return row.action;
}

function project(
	row: Row,
	scope: PlatformAuditQueryScopeV1,
): ScopedPlatformAuditProjectionV1 {
	if (
		!platformAuditQueryActionsV1.some((action) => action === row.action) ||
		!platformAuditQueryResultsV1.some((result) => result === row.result)
	)
		throw new PlatformAuditScopeErrorV1("unavailable");
	if (
		row.action === "task.status.changed" &&
		![
			"waiting",
			"submitted",
			"processing",
			"completed",
			"failed",
			"cancelled",
			"unknown",
		].includes(row.result)
	)
		throw new PlatformAuditScopeErrorV1("unavailable");
	const binding = executionBinding(row);
	if (
		binding &&
		(row.agentId !== binding.agentId ||
			(row.source === "conversation" && row.actorId !== binding.actorId))
	)
		throw new PlatformAuditScopeErrorV1("unavailable");
	let originalPrincipal: ApiPrincipalV1 | null = null;
	if (binding)
		originalPrincipal = requirePlatformExecutionAuditBindingV1(binding, scope);
	else if (
		scope.kind === "execution" &&
		!(
			row.source === "platform" &&
			row.action === "task.api.access" &&
			row.targetType === "agent" &&
			row.agentId === row.targetId &&
			row.actorType === scope.principal.kind &&
			row.actorId === scope.principal.id
		)
	)
		deny();
	const metadataSummary =
		row.action === "api.credential.metadata.read"
			? credentialMetadataSummary(row, scope)
			: null;
	const mutationSummary =
		row.action === "api.credential.issued" ||
		row.action === "api.credential.revoked" ||
		row.action === "api.credential.narrowed"
			? credentialMutationSummary(row, scope)
			: null;
	const legacy =
		executionActions.has(row.action) ||
		metadataSummary !== null ||
		mutationSummary !== null
			? null
			: decodePlatformAuditRowV1(row);
	// The legacy decoder has already validated exact Task API metadata and its
	// agreement with the trusted actor, target and result columns.
	const taskDetails =
		row.action.startsWith("task.api.") && legacy
			? (row.details as TaskApiAuditInputV1)
			: null;
	const taskApi = taskDetails
		? {
				operation: taskDetails.operation,
				phase: taskDetails.phase,
				reason: taskDetails.reason,
				...(taskDetails.subscriptionId
					? { subscriptionId: taskDetails.subscriptionId }
					: {}),
			}
		: null;
	let actor: PlatformAuditProjectionV1["actor"] = legacy?.actor ?? {
		kind: ["user", "application", "system"].includes(row.actorType)
			? (row.actorType as "user" | "application" | "system")
			: "unknown",
		actorId: ["user", "application", "system"].includes(row.actorType)
			? row.actorId
			: "unknown",
	};
	if (row.source === "conversation" && originalPrincipal)
		actor = {
			kind: originalPrincipal.kind,
			actorId: originalPrincipal.id,
		};
	let executor: ScopedPlatformAuditProjectionV1["executor"] =
		row.actorType === "system" &&
		["task.status.changed", "task.control.created"].includes(row.action)
			? "platform_worker"
			: null;
	if (row.action === "conversation.task.status") {
		actor = { kind: "system", actorId: "platform_worker" };
		executor = "platform_worker";
	}
	let result = row.result;
	let operation: ScopedPlatformAuditProjectionV1["operation"] = null;
	if (row.action === "execution.operation.observed") {
		if (!binding) throw new PlatformAuditScopeErrorV1("unavailable");
		const projected = projectPlatformOperationAuditV1(
			row.details,
			binding,
			scope,
		);
		result = projected.result;
		const fact =
			projected.fact.kind === "tool" && projected.fact.connection
				? {
						...projected.fact,
						connection: {
							serviceRef: projected.fact.connection.serviceRef,
							...(projected.fact.connection.callRef
								? { callRef: projected.fact.connection.callRef }
								: {}),
							verification: "unverified" as const,
							reason: "authorization_unavailable" as const,
						},
					}
				: projected.fact;
		operation = { eventId: projected.eventId, fact };
		executor = projected.executor;
	}
	if (
		!Number.isFinite(row.occurredAt.getTime()) ||
		![row.auditId, row.traceId, row.actorId, row.targetId].every(boundedText) ||
		![
			row.requestId,
			row.agentId,
			row.conversationId,
			row.executionId,
			binding?.authorizationRecordId ?? null,
		].every((value) => value === null || boundedText(value)) ||
		(metadataSummary === null &&
			mutationSummary === null &&
			![
				"agent_application",
				"agent",
				"secret",
				"secret_key",
				"grant",
				"unknown",
				"conversation",
				"execution",
				"configuration",
			].includes(row.targetType))
	)
		throw new PlatformAuditScopeErrorV1("unavailable");
	const summary =
		legacy?.summary ??
		metadataSummary ??
		mutationSummary ??
		(row.action === "audit.query.completed" ||
		row.action === "audit.query.failed"
			? projectPlatformAuditQuerySummaryV1(row.action, row.details)
			: row.action === "task.control.created" ||
					row.action === "task.status.changed"
				? projectPlatformTaskAuditSummaryV1(row.action, row.details)
				: row.action);
	if (
		(row.action === "audit.query.completed" ||
			row.action === "audit.query.failed") &&
		row.outcome !== (row.details as { result: unknown }).result
	)
		throw new PlatformAuditScopeErrorV1("unavailable");
	return {
		schemaVersion: 1,
		auditId: row.auditId,
		action: row.action as PlatformAuditQueryActionV1,
		actor,
		subject:
			legacy?.subject ??
			(metadataSummary !== null
				? { kind: "unknown", subjectId: "unknown" }
				: {
						kind:
							row.targetType === "api_credential" && row.targetId === "unknown"
								? "unknown"
								: (row.targetType as ScopedPlatformAuditProjectionV1["subject"]["kind"]),
						subjectId: row.targetId,
					}),
		result,
		summary,
		taskApi,
		occurredAt: new Date(row.occurredAt),
		traceId: row.traceId,
		requestId: row.requestId,
		agentId: row.agentId,
		conversationId: row.conversationId,
		executionId: row.executionId,
		authorizationRecordId: binding?.authorizationRecordId ?? null,
		originalPrincipal,
		executor,
		operation,
	};
}

/** API material is transient and never enters Core scope, cursor or audit data. */
type ScopedAuditQueryIdentityV1 =
	| PlatformAuditQueryScopeV1
	| {
			readonly kind: "api-credential";
			readonly material: string;
			readonly userDirectory: TaskUserDirectoryV1 | undefined;
	  };

export class PostgresScopedPlatformAuditQueryV1 {
	readonly #client;
	readonly #managementClient;
	readonly #managementDatabase;
	constructor(options: { databaseUrl: string }) {
		this.#client = postgres(options.databaseUrl, {
			max: 5,
			connect_timeout: 2,
		});
		// The Agent lock in the query transaction guards the current management
		// read. Keep Drizzle's timestamp/JSON codecs off the raw query pool.
		this.#managementClient = postgres(options.databaseUrl, {
			max: 5,
			connect_timeout: 2,
		});
		this.#managementDatabase = drizzle(this.#managementClient);
	}

	async #requireAgent(
		transaction: Transaction,
		scope: PlatformAuditQueryScopeV1,
		agentId: string,
	): Promise<void> {
		if (scope.kind === "administrator") return;
		const [agent] = await transaction<
			{ authorization_revision: string | null }[]
		>`
			select authorization_revision from platform.agents where id = ${agentId} for share`;
		if (!agent?.authorization_revision) deny();
		const management = await readAgentManagementState(
			this.#managementDatabase,
			agentId,
		);
		if (!management) deny();
		if (scope.credential || scope.principal.kind === "application") {
			// This is current audit read access, not live Task execution eligibility.
			const [grant] = await transaction`
				select agent_id from platform.agent_principal_grants
				where agent_id = ${agentId} and principal_type = ${scope.principal.kind}
					and principal_id = ${scope.principal.id} and grant_type = 'use'
					and revoked_at is null and authorization_revision = ${agent.authorization_revision}
				for share`;
			if (!grant) deny();
			return;
		}
		if (!scope.user) deny();
		const boundary = captureTaskAuthorizationBoundaryV1({
			principal: scope.principal,
			user: scope.user,
			agent: management,
			channelId: "audit:web",
			agentAuthorizationRevision: agent.authorization_revision,
		});
		if (!boundary) deny();
	}

	async #audit(
		transaction: Transaction,
		scope: PlatformAuditQueryScopeV1,
		query: PlatformAuditQueryInputV1,
		operation: "list" | "detail",
		result: "succeeded" | "rejected" | "failed",
		count: number,
		request: ScopedPlatformAuditRequestMetadataV1,
		reason?: PlatformAuditQueryDenialReasonV1,
	): Promise<void> {
		const metadata = projectPlatformAuditQueryRecordV1({
			scope,
			query,
			operation,
			result,
			count,
			...(reason !== undefined ? { reason } : {}),
		});
		await transaction`
			insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, details)
			values (${randomUUID()}, ${request.traceId}, ${scope.kind === "administrator" ? "user" : scope.principal.kind},
				${scope.kind === "administrator" ? scope.administratorId : scope.principal.id},
				${result === "succeeded" ? "audit.query.completed" : "audit.query.failed"}, 'unknown', 'audit-query', ${result}, ${request.requestId}, ${transaction.json(metadata)})
		`;
	}

	async #run(
		scopeInput: ScopedAuditQueryIdentityV1,
		input: unknown,
		request: ScopedPlatformAuditRequestMetadataV1,
		auditId?: string,
	): Promise<ScopedPlatformAuditPageV1> {
		let resolvedScope: PlatformAuditQueryScopeV1 | undefined;
		const credentialQuery = scopeInput.kind === "api-credential";
		if (!boundedText(request.requestId) || !boundedText(request.traceId))
			throw new PlatformAuditScopeErrorV1("invalid_request");
		let query: PlatformAuditQueryInputV1 = { limit: 1, filters: {} };
		const operation = auditId === undefined ? "list" : "detail";
		try {
			return await this.#client.begin(async (transaction) => {
				const resolution = credentialQuery
					? await resolveApiAuditCredentialIdentityV1(
							transaction,
							scopeInput.material,
							scopeInput.userDirectory,
						)
					: undefined;
				const scope = resolution
					? parsePlatformAuditQueryScopeV1({
							kind: "execution",
							principal: resolution.identity.principal,
							credential: resolution.identity.credential,
							...(resolution.identity.user
								? { user: resolution.identity.user }
								: {}),
						})
					: parsePlatformAuditQueryScopeV1(scopeInput);
				resolvedScope = scope;
				// Credential metadata alone is never authentication.
				if (!resolution && scope.kind === "execution" && scope.credential)
					deny();
				query = parsePlatformAuditQueryInputV1(input, scope);
				if (
					operation === "detail" &&
					(query.limit !== 1 ||
						query.cursor !== undefined ||
						!boundedText(auditId))
				)
					throw new PlatformAuditScopeErrorV1("invalid_request");
				const key = fingerprint(scope, query);
				const cursor =
					query.cursor === undefined ? null : decodeCursor(query.cursor, key);
				if (query.filters.agentId)
					await this.#requireAgent(transaction, scope, query.filters.agentId);
				if (scope.kind === "execution" && query.filters.executionId) {
					const [owned] = await transaction<
						Row[]
					>`${candidates(transaction, scope, { limit: 1, filters: { executionId: query.filters.executionId } })}
						select * from controlled limit 1`;
					if (!owned) deny();
					const binding = executionBinding(owned);
					if (!binding) deny();
					requirePlatformExecutionAuditBindingV1(binding, scope);
					await this.#requireAgent(transaction, scope, binding.agentId);
				}
				const cte = candidates(transaction, scope, query);
				let rows: Row[];
				if (auditId !== undefined) {
					rows = await transaction<
						Row[]
					>`${cte} select * from controlled where "auditId" = ${auditId} order by source limit 2`;
					if (rows.length !== 1) deny();
				} else if (cursor) {
					const [anchor] = await transaction<
						Row[]
					>`${cte} select * from controlled where source = ${cursor[0]} and "auditId" = ${cursor[1]}`;
					if (!anchor) deny();
					if (anchor.agentId)
						await this.#requireAgent(transaction, scope, anchor.agentId);
					// Keep PostgreSQL's full timestamp precision at the keyset boundary.
					rows = await transaction<Row[]>`${cte}, anchor as (
						select "occurredAt", source, "auditId" from controlled
						where source = ${cursor[0]} and "auditId" = ${cursor[1]}
					) select page.* from controlled page cross join anchor
						where (page."occurredAt", page.source, page."auditId") < (anchor."occurredAt", anchor.source, anchor."auditId")
						order by page."occurredAt" desc, page.source desc, page."auditId" desc limit ${query.limit + 1}`;
				} else
					rows = await transaction<
						Row[]
					>`${cte} select * from controlled order by "occurredAt" desc, source desc, "auditId" desc limit ${query.limit + 1}`;
				for (const agentId of new Set(
					rows.flatMap((row) => (row.agentId ? [row.agentId] : [])),
				))
					await this.#requireAgent(transaction, scope, agentId);
				const visible = rows.slice(0, query.limit);
				const items = visible.map((row) =>
					project({ ...row, conversationId: row.boundConversationId }, scope),
				);
				await this.#audit(
					transaction,
					scope,
					query,
					operation,
					"succeeded",
					items.length,
					request,
				);
				await resolution?.revalidate();
				const last = visible.at(-1);
				return {
					items,
					nextCursor:
						rows.length > query.limit && last ? encodeCursor(key, last) : null,
				};
			});
		} catch (error) {
			const code =
				error instanceof PlatformAuditScopeErrorV1
					? error.code
					: error instanceof PersonalApiCredentialErrorV1 &&
							error.code !== "unavailable"
						? "access_denied"
						: "unavailable";
			try {
				if (credentialQuery || !resolvedScope) {
					await this.recordDeniedQuery(
						{
							principal:
								resolvedScope?.kind === "execution"
									? resolvedScope.principal
									: null,
							requestedScope:
								scopeInput.kind === "administrator"
									? "administrator"
									: "execution",
							operation,
							result: code === "unavailable" ? "failed" : "rejected",
							reason: code,
						},
						request,
					);
				} else {
					const rejectedScope = resolvedScope;
					await this.#client.begin((transaction) =>
						this.#audit(
							transaction,
							rejectedScope,
							query,
							operation,
							code === "unavailable" ? "failed" : "rejected",
							0,
							request,
							code,
						),
					);
				}
			} catch {
				throw new PlatformAuditScopeErrorV1("unavailable");
			}
			if (error instanceof PersonalApiCredentialErrorV1) throw error;
			throw new PlatformAuditScopeErrorV1(code);
		}
	}

	listAudit(
		scope: ScopedAuditQueryIdentityV1,
		input: unknown,
		request: ScopedPlatformAuditRequestMetadataV1,
	): Promise<ScopedPlatformAuditPageV1> {
		return this.#run(scope, input, request);
	}

	async recordDeniedQuery(
		input: Parameters<typeof projectPlatformAuditQueryDenialV1>[0],
		request: ScopedPlatformAuditRequestMetadataV1,
	): Promise<void> {
		if (!boundedText(request.requestId) || !boundedText(request.traceId))
			throw new PlatformAuditScopeErrorV1("invalid_request");
		const { actor, details } = projectPlatformAuditQueryDenialV1(input);
		try {
			await this.#client`
				insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, details)
				values (${randomUUID()}, ${request.traceId}, ${actor.kind}, ${actor.actorId},
					'audit.query.failed', 'unknown', 'audit-query', ${details.result}, ${request.requestId}, ${this.#client.json(details)})
			`;
		} catch {
			throw new PlatformAuditScopeErrorV1("unavailable");
		}
	}

	async getAudit(
		scope: ScopedAuditQueryIdentityV1,
		auditId: string,
		input: unknown,
		request: ScopedPlatformAuditRequestMetadataV1,
	): Promise<ScopedPlatformAuditProjectionV1> {
		const page = await this.#run(scope, input, request, auditId);
		const item = page.items[0];
		if (!item) deny();
		return item;
	}

	async close(): Promise<void> {
		await Promise.all([this.#client.end(), this.#managementClient.end()]);
	}
}
