import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
	type AgentManagementAcceptedResultV1,
	type AgentManagementDecisionV1,
	AgentManagementError,
	type AgentManagementStateV1,
	type AgentManagementTransactionPortV1,
	type AgentManagementTransactionRequestV1,
} from "@agent-infra/platform-core";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
	agentApplications,
	agentAvailability,
	agentConfigurationRevisions,
	agentManagementHistory,
	agentOwners,
	agents,
	auditEvents,
	idempotencyRecords,
	outboxItems,
} from "./schema.js";

export interface PostgresAgentManagementOptionsV1 {
	readonly databaseUrl: string;
}

interface IdempotencyRow {
	readonly requestDigest: string;
	readonly status: "reserved" | "completed";
	readonly result: unknown;
}

type AcceptedDecision = Extract<
	AgentManagementDecisionV1,
	{ readonly outcome: "accepted" }
>;
type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

const idempotencyCommandType = "agent.management.v1";
const managementStatuses = new Set([
	"pending_approval",
	"withdrawn",
	"rejected",
	"creating",
	"available",
	"stopped",
	"creation_failed",
	"disabled",
]);
const managementAuditActions = new Set([
	"agent.application.updated",
	"agent.application.resubmitted",
	"agent.application.withdrawn",
	"agent.application.approved",
	"agent.application.rejected",
	"agent.lifecycle.stopped",
	"agent.lifecycle.restarted",
	"agent.lifecycle.creation_retried",
	"agent.lifecycle.disabled",
	"agent.workload.creation_succeeded",
	"agent.workload.creation_failed",
	"agent.workload.service_starting",
	"agent.workload.service_ready",
	"agent.workload.service_updating",
	"agent.workload.service_unavailable",
]);

function exactObject(input: unknown, keys: readonly string[]): void {
	if (
		typeof input !== "object" ||
		input === null ||
		Array.isArray(input) ||
		Object.keys(input).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(input, key))
	) {
		throw new AgentManagementError("unavailable");
	}
}

function validText(input: unknown, maximum = 1024): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		!input.includes("\0") &&
		String.prototype.isWellFormed.call(input) &&
		Buffer.byteLength(input, "utf8") <= maximum
	);
}

function validDate(input: unknown): input is Date {
	try {
		return Number.isFinite(Date.prototype.getTime.call(input));
	} catch {
		return false;
	}
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function acceptedResult(
	input: unknown,
	request: AgentManagementTransactionRequestV1,
): AgentManagementAcceptedResultV1 {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new AgentManagementError("unavailable");
	}
	const result = input as Record<string, unknown>;
	if (
		Object.keys(result).length !== 5 ||
		result.schemaVersion !== 1 ||
		!validText(result.applicationId) ||
		!validText(result.agentId) ||
		!managementStatuses.has(result.status as string) ||
		!Number.isSafeInteger(result.revision) ||
		(result.revision as number) < 1 ||
		(request.subjectType === "agent_application"
			? result.applicationId !== request.subjectId
			: result.agentId !== request.subjectId)
	) {
		throw new AgentManagementError("unavailable");
	}
	return structuredClone(result) as unknown as AgentManagementAcceptedResultV1;
}

async function replay(
	transaction: Transaction,
	row: IdempotencyRow | undefined,
	request: AgentManagementTransactionRequestV1,
): Promise<AgentManagementDecisionV1 | undefined> {
	if (!row) return undefined;
	if (row.requestDigest !== request.requestDigest) {
		return {
			outcome: "conflict",
			reason: "idempotency_conflict",
			writePlan: null,
		};
	}
	if (row.status !== "completed") {
		throw new AgentManagementError("unavailable");
	}
	const result = acceptedResult(row.result, request);
	const [identity] = await transaction
		.select({ agentId: agentApplications.agentId })
		.from(agentApplications)
		.where(eq(agentApplications.id, result.applicationId))
		.limit(1);
	if (identity?.agentId !== result.agentId) {
		throw new AgentManagementError("unavailable");
	}
	return {
		outcome: "replayed",
		result,
		writePlan: null,
	};
}

function idempotencyWhere(request: AgentManagementTransactionRequestV1) {
	return and(
		eq(idempotencyRecords.scopeType, request.subjectType),
		eq(idempotencyRecords.scopeId, request.subjectId),
		eq(idempotencyRecords.actorId, request.actorId),
		eq(idempotencyRecords.commandType, idempotencyCommandType),
		eq(idempotencyRecords.idempotencyKey, request.idempotencyKey),
	);
}

async function readIdempotency(
	transaction: Transaction,
	request: AgentManagementTransactionRequestV1,
): Promise<IdempotencyRow | undefined> {
	const [row] = await transaction
		.select({
			requestDigest: idempotencyRecords.requestDigest,
			status: idempotencyRecords.status,
			result: idempotencyRecords.result,
		})
		.from(idempotencyRecords)
		.where(idempotencyWhere(request))
		.limit(1);
	return row;
}

async function readState(
	database: ReturnType<typeof drizzle> | Transaction,
	agentId: string,
): Promise<AgentManagementStateV1 | undefined> {
	const [application] = await database
		.select({
			applicationId: agentApplications.id,
			agentId: agentApplications.agentId,
			applicantId: agentApplications.applicantId,
			status: agentApplications.status,
			revision: agentApplications.managementRevision,
			approvalRevision: agentApplications.approvalRevision,
			decisionReason: agentApplications.decisionReason,
			serviceAvailability: agentApplications.serviceAvailability,
			desiredState: agentApplications.desiredState,
			workloadRevision: agentApplications.workloadRevision,
			fence: agentApplications.fence,
			failureCode: agentApplications.failureCode,
		})
		.from(agentApplications)
		.where(eq(agentApplications.agentId, agentId))
		.limit(1);
	if (!application) return undefined;
	const [owners, availability] = await Promise.all([
		database
			.select({ ownerId: agentOwners.ownerId })
			.from(agentOwners)
			.where(eq(agentOwners.agentId, agentId))
			.orderBy(asc(agentOwners.ownerId)),
		database
			.select({
				targetType: agentAvailability.targetType,
				targetId: agentAvailability.targetId,
			})
			.from(agentAvailability)
			.where(eq(agentAvailability.agentId, agentId))
			.orderBy(
				asc(agentAvailability.targetType),
				asc(agentAvailability.targetId),
			),
	]);
	return {
		schemaVersion: 1,
		...application,
		ownerIds: owners.map(({ ownerId }) => ownerId),
		availability: availability.map(({ targetType, targetId }) =>
			targetType === "user"
				? { kind: "user" as const, userId: targetId }
				: { kind: "organization" as const, organizationId: targetId },
		),
	};
}

async function lockState(
	transaction: Transaction,
	request: AgentManagementTransactionRequestV1,
): Promise<AgentManagementStateV1 | undefined> {
	let agentId = request.subjectId;
	if (request.subjectType === "agent_application") {
		const [application] = await transaction
			.select({ agentId: agentApplications.agentId })
			.from(agentApplications)
			.where(eq(agentApplications.id, request.subjectId))
			.limit(1);
		if (!application) return undefined;
		agentId = application.agentId;
	}
	const [lockedAgent] = await transaction
		.select({ id: agents.id })
		.from(agents)
		.where(eq(agents.id, agentId))
		.for("update")
		.limit(1);
	if (!lockedAgent) return undefined;
	const subjectCondition =
		request.subjectType === "agent_application"
			? eq(agentApplications.id, request.subjectId)
			: eq(agentApplications.agentId, request.subjectId);
	const [lockedApplication] = await transaction
		.select({ agentId: agentApplications.agentId })
		.from(agentApplications)
		.where(and(subjectCondition, eq(agentApplications.agentId, agentId)))
		.for("update")
		.limit(1);
	return lockedApplication && readState(transaction, lockedApplication.agentId);
}

function requireAcceptedEnvelope(
	request: AgentManagementTransactionRequestV1,
	current: AgentManagementStateV1,
	decision: AcceptedDecision,
): {
	readonly result: AgentManagementAcceptedResultV1;
	readonly outboxPayload: null | {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly revision: number;
		readonly workloadRevision: number;
		readonly fence: number;
		readonly desiredState: "running" | "stopped";
	};
} {
	const { result, writePlan } = decision;
	exactObject(writePlan, [
		"schemaVersion",
		"operation",
		"subjectType",
		"subjectId",
		"expectedRevision",
		"state",
		"transition",
		"outboxIntent",
		"auditEvent",
		"idempotency",
	]);
	exactObject(writePlan.state, [
		"schemaVersion",
		"applicationId",
		"agentId",
		"applicantId",
		"status",
		"revision",
		"approvalRevision",
		"decisionReason",
		"serviceAvailability",
		"desiredState",
		"workloadRevision",
		"fence",
		"ownerIds",
		"availability",
		"failureCode",
	]);
	exactObject(writePlan.transition, ["from", "to", "occurredAt"]);
	exactObject(writePlan.auditEvent, [
		"action",
		"actorId",
		"subjectType",
		"subjectId",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	exactObject(writePlan.idempotency, ["key", "requestDigest"]);
	const validatedResult = acceptedResult(result, request);
	if (
		writePlan.schemaVersion !== 1 ||
		writePlan.operation !== request.operation ||
		writePlan.subjectType !== request.subjectType ||
		writePlan.subjectId !== request.subjectId ||
		writePlan.expectedRevision !== current.revision ||
		writePlan.idempotency.key !== request.idempotencyKey ||
		writePlan.idempotency.requestDigest !== request.requestDigest ||
		writePlan.state.applicationId !== current.applicationId ||
		writePlan.state.agentId !== current.agentId ||
		writePlan.state.applicantId !== current.applicantId ||
		writePlan.state.schemaVersion !== 1 ||
		writePlan.state.revision !== current.revision + 1 ||
		!sameValue(writePlan.state.ownerIds, current.ownerIds) ||
		!sameValue(writePlan.state.availability, current.availability) ||
		writePlan.transition.from !== current.status ||
		writePlan.transition.to !== writePlan.state.status ||
		!validDate(writePlan.transition.occurredAt) ||
		!managementAuditActions.has(writePlan.auditEvent.action) ||
		writePlan.auditEvent.actorId !== request.actorId ||
		writePlan.auditEvent.subjectType !== request.subjectType ||
		writePlan.auditEvent.subjectId !== request.subjectId ||
		!validText(writePlan.auditEvent.traceId) ||
		!validText(writePlan.auditEvent.requestId) ||
		!validDate(writePlan.auditEvent.occurredAt) ||
		writePlan.auditEvent.occurredAt.getTime() !==
			writePlan.transition.occurredAt.getTime() ||
		validatedResult.applicationId !== writePlan.state.applicationId ||
		validatedResult.agentId !== writePlan.state.agentId ||
		validatedResult.status !== writePlan.state.status ||
		validatedResult.revision !== writePlan.state.revision
	) {
		throw new AgentManagementError("unavailable");
	}
	const workloadChanged =
		writePlan.state.desiredState !== current.desiredState ||
		writePlan.state.workloadRevision !== current.workloadRevision ||
		writePlan.state.fence !== current.fence;
	if (workloadChanged !== (writePlan.outboxIntent !== null)) {
		throw new AgentManagementError("unavailable");
	}
	if (writePlan.outboxIntent === null) {
		return { result: validatedResult, outboxPayload: null };
	}
	const outbox = writePlan.outboxIntent;
	if (!outbox) throw new AgentManagementError("unavailable");
	exactObject(outbox, [
		"operation",
		"payload",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	exactObject(outbox.payload, [
		"schemaVersion",
		"agentId",
		"revision",
		"workloadRevision",
		"fence",
		"desiredState",
	]);
	const outboxPayload = {
		schemaVersion: 1 as const,
		agentId: writePlan.state.agentId,
		revision: writePlan.state.revision,
		workloadRevision: writePlan.state.workloadRevision,
		fence: writePlan.state.fence,
		desiredState: writePlan.state.desiredState,
	};
	if (
		outbox.operation !== "agent.workload.reconcile.v1" ||
		!sameValue(outbox.payload, outboxPayload) ||
		!validText(outbox.traceId) ||
		!validText(outbox.requestId) ||
		outbox.traceId !== writePlan.auditEvent.traceId ||
		outbox.requestId !== writePlan.auditEvent.requestId ||
		!validDate(outbox.occurredAt) ||
		outbox.occurredAt.getTime() !== writePlan.transition.occurredAt.getTime()
	) {
		throw new AgentManagementError("unavailable");
	}
	return { result: validatedResult, outboxPayload };
}

async function persistAccepted(
	transaction: Transaction,
	request: AgentManagementTransactionRequestV1,
	current: AgentManagementStateV1,
	decision: AcceptedDecision,
): Promise<AgentManagementDecisionV1> {
	const validated = requireAcceptedEnvelope(request, current, decision);
	const { writePlan } = decision;
	const { result, outboxPayload } = validated;
	const next = writePlan.state;
	const observation = request.operation.startsWith("observe_");
	const [updated] = await transaction
		.update(agentApplications)
		.set({
			status: next.status,
			managementRevision: next.revision,
			approvalRevision: next.approvalRevision,
			decisionReason: next.decisionReason,
			serviceAvailability: next.serviceAvailability,
			desiredState: next.desiredState,
			workloadRevision: next.workloadRevision,
			fence: next.fence,
			failureCode: next.failureCode,
		})
		.where(
			and(
				eq(agentApplications.id, current.applicationId),
				eq(agentApplications.managementRevision, writePlan.expectedRevision),
				...(observation
					? [
							eq(agentApplications.workloadRevision, current.workloadRevision),
							eq(agentApplications.fence, current.fence),
						]
					: []),
			),
		)
		.returning({ applicationId: agentApplications.id });
	if (!updated) {
		return {
			outcome: "conflict",
			reason: observation ? "stale_observation" : "stale_revision",
			writePlan: null,
		};
	}

	await transaction.insert(agentManagementHistory).values({
		agentId: next.agentId,
		revision: next.revision,
		applicationId: next.applicationId,
		subjectType: writePlan.subjectType,
		subjectId: writePlan.subjectId,
		operation: writePlan.operation,
		fromStatus: writePlan.transition.from,
		toStatus: writePlan.transition.to,
		occurredAt: writePlan.transition.occurredAt,
	});
	if (writePlan.outboxIntent && outboxPayload) {
		await transaction.insert(outboxItems).values({
			id: randomUUID(),
			scopeType: "agent",
			scopeId: next.agentId,
			operation: writePlan.outboxIntent.operation,
			payload: outboxPayload,
			traceId: writePlan.outboxIntent.traceId,
			requestId: writePlan.outboxIntent.requestId,
			availableAt: writePlan.outboxIntent.occurredAt,
			createdAt: writePlan.outboxIntent.occurredAt,
			updatedAt: writePlan.outboxIntent.occurredAt,
		});
	}
	await transaction.insert(auditEvents).values({
		id: randomUUID(),
		traceId: writePlan.auditEvent.traceId,
		requestId: writePlan.auditEvent.requestId,
		agentId: next.agentId,
		actorType: observation ? "system" : "user",
		actorId: writePlan.auditEvent.actorId,
		action: writePlan.auditEvent.action,
		targetType: writePlan.auditEvent.subjectType,
		targetId: writePlan.auditEvent.subjectId,
		outcome: "succeeded",
		occurredAt: writePlan.auditEvent.occurredAt,
	});
	await transaction.insert(idempotencyRecords).values({
		id: randomUUID(),
		scopeType: request.subjectType,
		scopeId: request.subjectId,
		actorId: request.actorId,
		commandType: idempotencyCommandType,
		idempotencyKey: request.idempotencyKey,
		requestDigest: request.requestDigest,
		status: "completed",
		result: { ...result },
		createdAt: writePlan.transition.occurredAt,
		updatedAt: writePlan.transition.occurredAt,
	});
	return decision;
}

export class PostgresAgentManagementTransactionV1
	implements AgentManagementTransactionPortV1
{
	readonly #client;
	readonly #database;

	constructor(options: PostgresAgentManagementOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 1 });
		this.#database = drizzle(this.#client);
	}

	async executeAgentManagementTransaction(
		request: AgentManagementTransactionRequestV1,
		decide: (
			state: AgentManagementStateV1 | undefined,
		) => AgentManagementDecisionV1,
	): Promise<AgentManagementDecisionV1> {
		try {
			return await this.#database.transaction(async (transaction) => {
				const firstReplay = await replay(
					transaction,
					await readIdempotency(transaction, request),
					request,
				);
				if (firstReplay) return firstReplay;
				const state = await lockState(transaction, request);
				const secondReplay = await replay(
					transaction,
					await readIdempotency(transaction, request),
					request,
				);
				if (secondReplay) return secondReplay;
				const decision = decide(state && structuredClone(state));
				if (decision.outcome !== "accepted") return decision;
				if (!state) throw new AgentManagementError("unavailable");
				return persistAccepted(transaction, request, state, decision);
			});
		} catch {
			throw new AgentManagementError("unavailable");
		}
	}

	async resolveAgentAccessState(
		agentId: string,
	): Promise<AgentManagementStateV1 | undefined> {
		try {
			return await this.#database.transaction(
				async (transaction) => {
					const state = await readState(transaction, agentId);
					return state && structuredClone(state);
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch {
			throw new AgentManagementError("unavailable");
		}
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			throw new AgentManagementError("unavailable");
		}
	}
}

export interface AgentManagementApplicationProjectionV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly agentId: string;
	readonly applicantId: string;
	readonly name: string;
	readonly description: string;
	readonly sourceReference: string;
	readonly management: AgentManagementStateV1;
	readonly submittedAt: Date;
	readonly decision: null | {
		readonly decidedAt: Date;
		readonly reason: string | null;
	};
}

export interface AgentManagementAgentProjectionV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly applicationId: string;
	readonly name: string;
	readonly description: string;
	readonly sourceReference: string;
	readonly management: AgentManagementStateV1;
}

export type AgentManagementApplicationScopeV1 =
	| { readonly kind: "applicant"; readonly applicantId: string }
	| { readonly kind: "administrator" };

export type AgentManagementAgentScopeV1 =
	| { readonly kind: "owner"; readonly ownerId: string }
	| {
			readonly kind: "user";
			readonly userId: string;
			readonly organizationIds: readonly string[];
	  };

export interface AgentManagementPageInputV1 {
	readonly limit: number;
	readonly afterId?: string;
}

export interface AgentManagementPageV1<T> {
	readonly items: readonly T[];
	readonly nextAfterId: string | null;
}

function requirePage(input: AgentManagementPageInputV1): void {
	if (
		!Number.isInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 100 ||
		(input.afterId !== undefined && input.afterId.length === 0)
	) {
		throw new AgentManagementError("unavailable");
	}
}

function applicationScopeCondition(scope: AgentManagementApplicationScopeV1) {
	return scope.kind === "administrator"
		? undefined
		: eq(agentApplications.applicantId, scope.applicantId);
}

function agentScopeCondition(scope: AgentManagementAgentScopeV1) {
	const owner = sql<boolean>`exists (
		select 1 from ${agentOwners}
		where ${agentOwners.agentId} = ${agentApplications.agentId}
			and ${agentOwners.ownerId} = ${
				scope.kind === "owner" ? scope.ownerId : scope.userId
			}
	)`;
	if (scope.kind === "owner") return owner;
	const directlyAvailable = sql<boolean>`exists (
		select 1 from ${agentAvailability}
		where ${agentAvailability.agentId} = ${agentApplications.agentId}
			and ${agentAvailability.targetType} = 'user'
			and ${agentAvailability.targetId} = ${scope.userId}
	)`;
	const organizationAvailable =
		scope.organizationIds.length === 0
			? undefined
			: sql<boolean>`exists (
				select 1 from ${agentAvailability}
				where ${agentAvailability.agentId} = ${agentApplications.agentId}
					and ${agentAvailability.targetType} = 'organization'
					and ${inArray(
						agentAvailability.targetId,
						scope.organizationIds as string[],
					)}
			)`;
	return or(owner, directlyAvailable, organizationAvailable);
}

const projectionAccessSelection = {
	ownerIds: sql<string[]>`coalesce((
		select jsonb_agg(${agentOwners.ownerId} order by ${agentOwners.ownerId})
		from ${agentOwners}
		where ${agentOwners.agentId} = ${agentApplications.agentId}
	), '[]'::jsonb)`,
	availability: sql<AgentManagementStateV1["availability"]>`coalesce((
		select jsonb_agg(
			case
				when ${agentAvailability.targetType} = 'user'
					then jsonb_build_object(
						'kind', 'user', 'userId', ${agentAvailability.targetId}
					)
				else jsonb_build_object(
					'kind', 'organization',
					'organizationId', ${agentAvailability.targetId}
				)
			end
			order by ${agentAvailability.targetType}, ${agentAvailability.targetId}
		)
		from ${agentAvailability}
		where ${agentAvailability.agentId} = ${agentApplications.agentId}
	), '[]'::jsonb)`,
};

const applicationSelection = {
	applicationId: agentApplications.id,
	agentId: agentApplications.agentId,
	applicantId: agentApplications.applicantId,
	name: agentApplications.name,
	description: agentApplications.description,
	sourceReference: agentConfigurationRevisions.sourceReference,
	status: agentApplications.status,
	revision: agentApplications.managementRevision,
	approvalRevision: agentApplications.approvalRevision,
	serviceAvailability: agentApplications.serviceAvailability,
	desiredState: agentApplications.desiredState,
	workloadRevision: agentApplications.workloadRevision,
	fence: agentApplications.fence,
	failureCode: agentApplications.failureCode,
	...projectionAccessSelection,
	submittedAt: agentApplications.submittedAt,
	decisionReason: agentApplications.decisionReason,
	decisionOccurredAt: sql<Date | null>`(
		select ${agentManagementHistory.occurredAt}
		from ${agentManagementHistory}
		where ${agentManagementHistory.agentId} = ${agentApplications.agentId}
			and ${agentManagementHistory.revision} = coalesce(
				${agentApplications.approvalRevision},
				${agentApplications.managementRevision}
			)
			and ${agentManagementHistory.operation} in (
				'approve_application', 'reject_application'
			)
		limit 1
	)`,
};

const agentSelection = {
	agentId: agentApplications.agentId,
	applicationId: agentApplications.id,
	applicantId: agentApplications.applicantId,
	name: agentApplications.name,
	description: agentApplications.description,
	sourceReference: agentConfigurationRevisions.sourceReference,
	status: agentApplications.status,
	revision: agentApplications.managementRevision,
	approvalRevision: agentApplications.approvalRevision,
	decisionReason: agentApplications.decisionReason,
	serviceAvailability: agentApplications.serviceAvailability,
	desiredState: agentApplications.desiredState,
	workloadRevision: agentApplications.workloadRevision,
	fence: agentApplications.fence,
	failureCode: agentApplications.failureCode,
	...projectionAccessSelection,
};

interface ManagementProjectionRow {
	readonly applicationId: string;
	readonly agentId: string;
	readonly applicantId: string;
	readonly status: AgentManagementStateV1["status"];
	readonly revision: number;
	readonly approvalRevision: number | null;
	readonly decisionReason: string | null;
	readonly serviceAvailability: AgentManagementStateV1["serviceAvailability"];
	readonly desiredState: AgentManagementStateV1["desiredState"];
	readonly workloadRevision: number;
	readonly fence: number;
	readonly failureCode: AgentManagementStateV1["failureCode"];
	readonly ownerIds: readonly string[];
	readonly availability: AgentManagementStateV1["availability"];
}

interface ApplicationProjectionRow extends ManagementProjectionRow {
	readonly name: string;
	readonly description: string;
	readonly sourceReference: string;
	readonly submittedAt: Date;
	readonly decisionOccurredAt: Date | null;
}

function managementState(row: ManagementProjectionRow): AgentManagementStateV1 {
	if (row.ownerIds.length === 0) {
		throw new AgentManagementError("unavailable");
	}
	return {
		schemaVersion: 1,
		applicationId: row.applicationId,
		agentId: row.agentId,
		applicantId: row.applicantId,
		status: row.status,
		revision: row.revision,
		approvalRevision: row.approvalRevision,
		decisionReason: row.decisionReason,
		serviceAvailability: row.serviceAvailability,
		desiredState: row.desiredState,
		workloadRevision: row.workloadRevision,
		fence: row.fence,
		ownerIds: row.ownerIds,
		availability: row.availability,
		failureCode: row.failureCode,
	};
}

function applicationProjection(
	row: ApplicationProjectionRow,
): AgentManagementApplicationProjectionV1 {
	return {
		schemaVersion: 1,
		applicationId: row.applicationId,
		agentId: row.agentId,
		applicantId: row.applicantId,
		name: row.name,
		description: row.description,
		sourceReference: row.sourceReference,
		management: managementState(row),
		submittedAt: row.submittedAt,
		decision: row.decisionOccurredAt
			? { decidedAt: row.decisionOccurredAt, reason: row.decisionReason }
			: null,
	};
}

export class PostgresAgentManagementQueryV1 {
	readonly #client;
	readonly #database;

	constructor(options: PostgresAgentManagementOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 1 });
		this.#database = drizzle(this.#client);
	}

	async listApplications(
		scope: AgentManagementApplicationScopeV1,
		page: AgentManagementPageInputV1,
	): Promise<AgentManagementPageV1<AgentManagementApplicationProjectionV1>> {
		try {
			requirePage(page);
			const rows = await this.#database
				.select(applicationSelection)
				.from(agentApplications)
				.innerJoin(agents, eq(agents.id, agentApplications.agentId))
				.innerJoin(
					agentConfigurationRevisions,
					and(
						eq(agentConfigurationRevisions.agentId, agents.id),
						eq(
							agentConfigurationRevisions.revision,
							agents.currentConfigurationRevision,
						),
					),
				)
				.where(
					and(
						applicationScopeCondition(scope),
						scope.kind === "administrator"
							? eq(agentApplications.status, "pending_approval")
							: undefined,
						page.afterId ? gt(agentApplications.id, page.afterId) : undefined,
					),
				)
				.orderBy(asc(agentApplications.id))
				.limit(page.limit + 1);
			const hasNext = rows.length > page.limit;
			const items = rows.slice(0, page.limit).map(applicationProjection);
			return {
				items,
				nextAfterId: hasNext ? (items.at(-1)?.applicationId ?? null) : null,
			};
		} catch {
			throw new AgentManagementError("unavailable");
		}
	}

	async getApplication(
		scope: AgentManagementApplicationScopeV1,
		applicationId: string,
	): Promise<AgentManagementApplicationProjectionV1 | undefined> {
		try {
			const [row] = await this.#database
				.select(applicationSelection)
				.from(agentApplications)
				.innerJoin(agents, eq(agents.id, agentApplications.agentId))
				.innerJoin(
					agentConfigurationRevisions,
					and(
						eq(agentConfigurationRevisions.agentId, agents.id),
						eq(
							agentConfigurationRevisions.revision,
							agents.currentConfigurationRevision,
						),
					),
				)
				.where(
					and(
						eq(agentApplications.id, applicationId),
						applicationScopeCondition(scope),
					),
				)
				.limit(1);
			if (!row) return undefined;
			return applicationProjection(row);
		} catch {
			throw new AgentManagementError("unavailable");
		}
	}

	async listAgents(
		scope: AgentManagementAgentScopeV1,
		page: AgentManagementPageInputV1,
	): Promise<AgentManagementPageV1<AgentManagementAgentProjectionV1>> {
		try {
			requirePage(page);
			const rows = await this.#database
				.select(agentSelection)
				.from(agentApplications)
				.innerJoin(agents, eq(agents.id, agentApplications.agentId))
				.innerJoin(
					agentConfigurationRevisions,
					and(
						eq(agentConfigurationRevisions.agentId, agents.id),
						eq(
							agentConfigurationRevisions.revision,
							agents.currentConfigurationRevision,
						),
					),
				)
				.where(
					and(
						agentScopeCondition(scope),
						inArray(agentApplications.status, [
							"creating",
							"available",
							"stopped",
							"creation_failed",
							"disabled",
						]),
						page.afterId
							? gt(agentApplications.agentId, page.afterId)
							: undefined,
					),
				)
				.orderBy(asc(agentApplications.agentId))
				.limit(page.limit + 1);
			const hasNext = rows.length > page.limit;
			const items = rows.slice(0, page.limit).map((row) => ({
				schemaVersion: 1 as const,
				agentId: row.agentId,
				applicationId: row.applicationId,
				name: row.name,
				description: row.description,
				sourceReference: row.sourceReference,
				management: managementState(row),
			}));
			return {
				items,
				nextAfterId: hasNext ? (items.at(-1)?.agentId ?? null) : null,
			};
		} catch {
			throw new AgentManagementError("unavailable");
		}
	}

	async getAgent(
		scope: AgentManagementAgentScopeV1,
		agentId: string,
	): Promise<AgentManagementAgentProjectionV1 | undefined> {
		try {
			const [row] = await this.#database
				.select(agentSelection)
				.from(agentApplications)
				.innerJoin(agents, eq(agents.id, agentApplications.agentId))
				.innerJoin(
					agentConfigurationRevisions,
					and(
						eq(agentConfigurationRevisions.agentId, agents.id),
						eq(
							agentConfigurationRevisions.revision,
							agents.currentConfigurationRevision,
						),
					),
				)
				.where(
					and(
						eq(agentApplications.agentId, agentId),
						agentScopeCondition(scope),
						inArray(agentApplications.status, [
							"creating",
							"available",
							"stopped",
							"creation_failed",
							"disabled",
						]),
					),
				)
				.limit(1);
			if (!row) return undefined;
			return {
				schemaVersion: 1,
				agentId: row.agentId,
				applicationId: row.applicationId,
				name: row.name,
				description: row.description,
				sourceReference: row.sourceReference,
				management: managementState(row),
			};
		} catch {
			throw new AgentManagementError("unavailable");
		}
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			throw new AgentManagementError("unavailable");
		}
	}
}
