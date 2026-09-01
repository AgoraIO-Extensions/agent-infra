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
		typeof result.applicationId !== "string" ||
		result.applicationId.length === 0 ||
		typeof result.agentId !== "string" ||
		result.agentId.length === 0 ||
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

function replay(
	row: IdempotencyRow | undefined,
	request: AgentManagementTransactionRequestV1,
): AgentManagementDecisionV1 | undefined {
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
	return {
		outcome: "replayed",
		result: acceptedResult(row.result, request),
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
	const condition =
		request.subjectType === "agent_application"
			? eq(agentApplications.id, request.subjectId)
			: eq(agentApplications.agentId, request.subjectId);
	const [locked] = await transaction
		.select({ agentId: agentApplications.agentId })
		.from(agentApplications)
		.where(condition)
		.for("update")
		.limit(1);
	return locked && readState(transaction, locked.agentId);
}

function requireAcceptedEnvelope(
	request: AgentManagementTransactionRequestV1,
	current: AgentManagementStateV1,
	decision: AcceptedDecision,
): void {
	const { result, writePlan } = decision;
	if (
		writePlan.operation !== request.operation ||
		writePlan.subjectType !== request.subjectType ||
		writePlan.subjectId !== request.subjectId ||
		writePlan.expectedRevision !== current.revision ||
		writePlan.idempotency.key !== request.idempotencyKey ||
		writePlan.idempotency.requestDigest !== request.requestDigest ||
		writePlan.state.applicationId !== current.applicationId ||
		writePlan.state.agentId !== current.agentId ||
		writePlan.state.applicantId !== current.applicantId ||
		writePlan.state.revision !== current.revision + 1 ||
		writePlan.transition.from !== current.status ||
		writePlan.transition.to !== writePlan.state.status ||
		writePlan.auditEvent.actorId !== request.actorId ||
		writePlan.auditEvent.subjectType !== request.subjectType ||
		writePlan.auditEvent.subjectId !== request.subjectId ||
		result.applicationId !== writePlan.state.applicationId ||
		result.agentId !== writePlan.state.agentId ||
		result.status !== writePlan.state.status ||
		result.revision !== writePlan.state.revision
	) {
		throw new AgentManagementError("unavailable");
	}
}

async function persistAccepted(
	transaction: Transaction,
	request: AgentManagementTransactionRequestV1,
	current: AgentManagementStateV1,
	decision: AcceptedDecision,
): Promise<AgentManagementDecisionV1> {
	requireAcceptedEnvelope(request, current, decision);
	const { result, writePlan } = decision;
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
	if (writePlan.outboxIntent) {
		await transaction.insert(outboxItems).values({
			id: randomUUID(),
			scopeType: "agent",
			scopeId: next.agentId,
			operation: writePlan.outboxIntent.operation,
			payload: { ...writePlan.outboxIntent.payload },
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
				const firstReplay = replay(
					await readIdempotency(transaction, request),
					request,
				);
				if (firstReplay) return firstReplay;
				const state = await lockState(transaction, request);
				const secondReplay = replay(
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
