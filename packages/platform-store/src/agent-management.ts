import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
	type AgentApiAuditContextV1,
	type AgentApiLifecycleTransactionV1,
	type AgentApplicationGrantCommandV1,
	type AgentApplicationGrantResultV1,
	type AgentManagementAcceptedResultV1,
	type AgentManagementDecisionV1,
	AgentManagementError,
	type AgentManagementStateV1,
	type AgentManagementTransactionPortV1,
	type AgentManagementTransactionRequestV1,
	type AgentUserUseRevokeCommandV1,
	type AgentUserUseRevokeResultV1,
	PersonalApiCredentialErrorV1,
	parseAgentApiLifecycleCommandV1,
	parseAgentApplicationGrantCommandV1,
	parseAgentUserUseRevokeCommandV1,
	personalApiAgentMetadataGrantTypesV1,
	planAgentApplicationGrantV1,
	planAgentUserUseRevokeV1,
	platformIdempotencyV1,
	requireAgentApplicationGrantAuthorityV1,
	resolveCurrentPersonalApiUserV1,
	snapshotAgentManagementWritePlanV1,
	type TaskUserDirectoryV1,
	withAgentApiAuditContextV1,
} from "@agent-infra/platform-core";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolveAgentApiIdentityV1 } from "./agent-api-identity.js";
import {
	agentManagementStateUpdate,
	insertAgentManagementEffects,
	insertAgentManagementHistory,
} from "./plan-writes.js";
import {
	agentApplications,
	agentAvailability,
	agentConfigurationRevisions,
	agentManagementHistory,
	agentOwners,
	agentPrincipalGrants,
	agents,
	auditEvents,
	idempotencyRecords,
	platformApiCredentials,
	platformApplications,
	platformUserDisables,
} from "./schema.js";

export interface PostgresAgentManagementOptionsV1 {
	readonly databaseUrl: string;
	readonly userDirectory?: TaskUserDirectoryV1;
}

type JsonValue = Parameters<ReturnType<typeof postgres>["json"]>[0];

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
function managementCommandType(request: AgentManagementTransactionRequestV1) {
	return request.actorType === undefined
		? idempotencyCommandType
		: `agent.api.lifecycle.${request.actorType}.v1`;
}
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
function validText(input: unknown, maximum = 1024): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		!input.includes("\0") &&
		String.prototype.isWellFormed.call(input) &&
		Buffer.byteLength(input, "utf8") <= maximum
	);
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
		eq(idempotencyRecords.commandType, managementCommandType(request)),
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

export async function readAgentManagementState(
	database: PostgresJsDatabase | Transaction,
	agentId: string,
): Promise<AgentManagementStateV1 | undefined> {
	const [application] = await database
		.select({
			// Whole-row extraction preserves the supported pre-0039 Web read during upgrade.
			creationChannel: sql<
				string | null
			>`to_jsonb(agent_applications)->>'creation_channel'`,
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
		...(({ creationChannel: _channel, ...state }) => state)(application),
		...(application.creationChannel === "api"
			? { creationChannel: "api" as const }
			: {}),
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
	return (
		lockedApplication &&
		readAgentManagementState(transaction, lockedApplication.agentId)
	);
}

function requireAcceptedEnvelope(
	request: AgentManagementTransactionRequestV1,
	current: AgentManagementStateV1,
	decision: AcceptedDecision,
): {
	readonly result: AgentManagementAcceptedResultV1;
	readonly writePlan: AcceptedDecision["writePlan"];
} {
	let writePlan: AcceptedDecision["writePlan"];
	try {
		writePlan = snapshotAgentManagementWritePlanV1(decision.writePlan);
	} catch {
		throw new AgentManagementError("unavailable");
	}
	const result = acceptedResult(decision.result, request);
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
		!sameValue(writePlan.state.ownerIds, current.ownerIds) ||
		!sameValue(writePlan.state.availability, current.availability) ||
		writePlan.transition.from !== current.status ||
		writePlan.auditEvent.actorId !== request.actorId ||
		writePlan.auditEvent.actorType !== request.actorType ||
		result.applicationId !== writePlan.state.applicationId ||
		result.agentId !== writePlan.state.agentId ||
		result.status !== writePlan.state.status ||
		result.revision !== writePlan.state.revision
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
	return { result, writePlan };
}

export async function persistAcceptedAgentManagement(
	transaction: Transaction,
	request: AgentManagementTransactionRequestV1,
	current: AgentManagementStateV1,
	decision: AcceptedDecision,
): Promise<AgentManagementDecisionV1> {
	const validated = requireAcceptedEnvelope(request, current, decision);
	const { result, writePlan } = validated;
	const observation = request.operation.startsWith("observe_");
	const [updated] = await transaction
		.update(agentApplications)
		.set(agentManagementStateUpdate(writePlan))
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

	await insertAgentManagementHistory(transaction, writePlan);
	await insertAgentManagementEffects(transaction, writePlan);
	await transaction.insert(idempotencyRecords).values({
		id: randomUUID(),
		scopeType: request.subjectType,
		scopeId: request.subjectId,
		actorId: request.actorId,
		commandType: managementCommandType(request),
		idempotencyKey: request.idempotencyKey,
		requestDigest: request.requestDigest,
		status: "completed",
		result: { ...result },
		createdAt: writePlan.transition.occurredAt,
		updatedAt: writePlan.transition.occurredAt,
	});
	return { outcome: "accepted", result, writePlan };
}

export class PostgresAgentManagementTransactionV1
	implements AgentManagementTransactionPortV1, AgentApiLifecycleTransactionV1
{
	readonly #client;
	readonly #database;
	readonly #userDirectory;

	constructor(options: PostgresAgentManagementOptionsV1) {
		this.#userDirectory = options.userDirectory;
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
				return persistAcceptedAgentManagement(
					transaction,
					request,
					state,
					decision,
				);
			});
		} catch {
			throw new AgentManagementError("unavailable");
		}
	}

	async executeAgentApiLifecycleTransaction(
		input: Parameters<
			AgentApiLifecycleTransactionV1["executeAgentApiLifecycleTransaction"]
		>[0],
		decide: Parameters<
			AgentApiLifecycleTransactionV1["executeAgentApiLifecycleTransaction"]
		>[1],
	): Promise<AgentManagementDecisionV1> {
		const command = parseAgentApiLifecycleCommandV1(input.command);
		const digest = platformIdempotencyV1.canonicalRequestDigest({
			schemaVersion: 1,
			agentId: command.agentId,
			command: command.command,
		});
		if (input.requestDigest !== digest)
			throw new PersonalApiCredentialErrorV1("invalid_input");
		let auditContext: AgentApiAuditContextV1 = { command: command.command };
		try {
			return await this.#database.transaction(async (transaction) => {
				await transaction.execute(sql`set local lock_timeout = '5s'`);
				await transaction.execute(sql`set local statement_timeout = '30s'`);
				const authenticated = await resolveAgentApiIdentityV1(
					transaction,
					input.material,
					this.#userDirectory,
					"agent:manage",
				);
				const principal = authenticated.identity.principal;
				auditContext = { ...auditContext, principal };
				const request: AgentManagementTransactionRequestV1 = {
					operation:
						command.command === "stop" ? "stop_agent" : "restart_agent",
					subjectType: "agent",
					subjectId: command.agentId,
					actorId: principal.id,
					actorType: principal.kind,
					idempotencyKey: command.idempotencyKey,
					requestDigest: digest,
				};
				const database = transaction;
				const state = await lockState(database, request);
				if (!state) throw new PersonalApiCredentialErrorV1("not_found");
				auditContext = { ...auditContext, agentId: state.agentId };
				const requireManage = async () => {
					const rows = await transaction
						.select({
							authorization_revision:
								agentPrincipalGrants.authorizationRevision,
							revoked_at: agentPrincipalGrants.revokedAt,
						})
						.from(agentPrincipalGrants)
						.where(
							and(
								eq(agentPrincipalGrants.agentId, command.agentId),
								eq(agentPrincipalGrants.principalType, principal.kind),
								eq(agentPrincipalGrants.principalId, principal.id),
								eq(agentPrincipalGrants.grantType, "manage"),
							),
						)
						.for("share");
					if (rows.length !== 1 || rows[0]?.revoked_at !== null)
						throw new PersonalApiCredentialErrorV1("not_found");
					const revision = rows[0].authorization_revision;
					if (!validText(revision))
						throw new PersonalApiCredentialErrorV1("unavailable");
					return revision;
				};
				const grantRevision = await requireManage();
				const existing = await replay(
					database,
					await readIdempotency(database, request),
					request,
				);
				const decision =
					existing ??
					decide(
						structuredClone(state),
						Object.freeze({
							principal,
							agentId: command.agentId,
							manageGrantRevision: grantRevision,
						}),
					);
				const result =
					decision.outcome === "accepted"
						? await persistAcceptedAgentManagement(
								database,
								request,
								state,
								decision,
							)
						: decision;
				if (result.outcome === "denied")
					throw new PersonalApiCredentialErrorV1("not_found");
				if (result.outcome === "conflict")
					throw new PersonalApiCredentialErrorV1("idempotency_conflict");
				await transaction
					.update(platformApiCredentials)
					.set({ lastUsedAt: sql`clock_timestamp()` })
					.where(
						eq(
							platformApiCredentials.id,
							authenticated.identity.credential.credentialId,
						),
					);
				await authenticated.revalidate();
				if ((await requireManage()) !== grantRevision)
					throw new PersonalApiCredentialErrorV1("unavailable");
				return result;
			});
		} catch (error) {
			const failure =
				error instanceof PersonalApiCredentialErrorV1
					? error
					: new PersonalApiCredentialErrorV1("unavailable");
			throw withAgentApiAuditContextV1(failure, auditContext);
		}
	}

	async readApiState(
		request: {
			readonly agentId: string;
			readonly requestId: string;
			readonly traceId: string;
		},
		material: string,
	) {
		if (
			![request.agentId, request.requestId, request.traceId].every((value) =>
				validText(value),
			)
		)
			throw new PersonalApiCredentialErrorV1("invalid_input");
		let auditContext: AgentApiAuditContextV1 = { command: "read_state" };
		try {
			return await this.#database.transaction(async (transaction) => {
				await transaction.execute(sql`set local lock_timeout = '5s'`);
				await transaction.execute(sql`set local statement_timeout = '30s'`);
				const authenticated = await resolveAgentApiIdentityV1(
					transaction,
					material,
					this.#userDirectory,
					"agent:read",
				);
				const principal = authenticated.identity.principal;
				auditContext = { ...auditContext, principal };
				const currentGrants = async () => {
					const rows = await transaction
						.select({
							type: agentPrincipalGrants.grantType,
							revision: agentPrincipalGrants.authorizationRevision,
							revokedAt: agentPrincipalGrants.revokedAt,
						})
						.from(agentPrincipalGrants)
						.where(
							and(
								eq(agentPrincipalGrants.agentId, request.agentId),
								eq(agentPrincipalGrants.principalType, principal.kind),
								eq(agentPrincipalGrants.principalId, principal.id),
								inArray(agentPrincipalGrants.grantType, [
									...personalApiAgentMetadataGrantTypesV1,
								]),
							),
						)
						.orderBy(asc(agentPrincipalGrants.grantType))
						.for("share");
					const active = rows.filter((row) => row.revokedAt === null);
					if (!active.length)
						throw new PersonalApiCredentialErrorV1("not_found");
					if (active.some((row) => !validText(row.revision)))
						throw new PersonalApiCredentialErrorV1("unavailable");
					return active;
				};
				const grants = await currentGrants();
				const state = await readAgentManagementState(
					transaction,
					request.agentId,
				);
				if (!state) throw new PersonalApiCredentialErrorV1("not_found");
				auditContext = { ...auditContext, agentId: state.agentId };
				const result = {
					schemaVersion: 1 as const,
					agentId: state.agentId,
					status: state.status,
					serviceAvailability: state.serviceAvailability,
					revision: state.revision,
				};
				await transaction.insert(auditEvents).values({
					id: randomUUID(),
					...request,
					actorType: principal.kind,
					actorId: principal.id,
					action: "api.agent.state.read",
					targetType: "agent",
					targetId: request.agentId,
					outcome: "succeeded",
				});
				await transaction
					.update(platformApiCredentials)
					.set({ lastUsedAt: sql`clock_timestamp()` })
					.where(
						eq(
							platformApiCredentials.id,
							authenticated.identity.credential.credentialId,
						),
					);
				await authenticated.revalidate();
				if (!sameValue(await currentGrants(), grants))
					throw new PersonalApiCredentialErrorV1("unavailable");
				return result;
			});
		} catch (error) {
			const failure =
				error instanceof PersonalApiCredentialErrorV1
					? error
					: new PersonalApiCredentialErrorV1("unavailable");
			throw withAgentApiAuditContextV1(failure, auditContext);
		}
	}

	async changeApplicationGrant(
		input: AgentApplicationGrantCommandV1,
		grantType: "manage" | "use",
	): Promise<AgentApplicationGrantResultV1> {
		const command = parseAgentApplicationGrantCommandV1(input);
		const digest = platformIdempotencyV1.canonicalRequestDigest({
			schemaVersion: 1,
			agentId: command.agentId,
			applicationId: command.applicationId,
			granted: command.granted,
		});
		const commandType =
			grantType === "manage"
				? "agent.application.manager.v1"
				: "agent.application.use.v1";
		let auditContext: AgentApiAuditContextV1 = {
			command:
				grantType === "manage"
					? command.granted
						? "grant_manager"
						: "revoke_manager"
					: command.granted
						? "grant_use"
						: "revoke_use",
		};
		try {
			return await this.#database.transaction(async (transaction) => {
				await transaction.execute(sql`set local lock_timeout = '5s'`);
				await transaction.execute(sql`set local statement_timeout = '30s'`);
				await transaction.execute(
					sql`lock table platform.platform_user_disables in share mode`,
				);
				const readActor = () =>
					resolveCurrentPersonalApiUserV1(this.#userDirectory, command.actorId);
				const firstActor = await readActor();
				auditContext = {
					...auditContext,
					principal: { kind: "user", id: firstActor.userId },
				};
				const [disabled] = await transaction
					.select()
					.from(platformUserDisables)
					.where(eq(platformUserDisables.userId, command.actorId));
				const [application] = await transaction
					.select({
						id: platformApplications.id,
						status: platformApplications.status,
						authorizationRevision: platformApplications.authorizationRevision,
					})
					.from(platformApplications)
					.where(eq(platformApplications.id, command.applicationId))
					.for("share");
				const state = await lockState(transaction, {
					operation: "stop_agent",
					subjectType: "agent",
					subjectId: command.agentId,
					actorId: command.actorId,
					idempotencyKey: command.idempotencyKey,
					requestDigest: digest,
				});
				const check = (actor: typeof firstActor) =>
					requireAgentApplicationGrantAuthorityV1({
						command,
						state,
						actor,
						actorDisabled: disabled !== undefined,
						application: application ?? null,
					});
				auditContext = { ...auditContext, agentId: state?.agentId };
				const actorRevision = check(firstActor);
				const idempotencyScope = and(
					eq(idempotencyRecords.scopeType, "agent"),
					eq(idempotencyRecords.scopeId, command.agentId),
					eq(idempotencyRecords.actorId, command.actorId),
					eq(idempotencyRecords.commandType, commandType),
					eq(idempotencyRecords.idempotencyKey, command.idempotencyKey),
				);
				const [existing] = await transaction
					.select()
					.from(idempotencyRecords)
					.where(idempotencyScope);
				if (
					existing &&
					(existing.requestDigest !== digest || existing.status !== "completed")
				)
					throw new PersonalApiCredentialErrorV1(
						existing.requestDigest !== digest
							? "idempotency_conflict"
							: "unavailable",
					);
				if (existing) {
					const saved = existing.result as Record<string, unknown> | null;
					if (
						!saved ||
						typeof saved !== "object" ||
						Array.isArray(saved) ||
						Object.keys(saved).length !== 6 ||
						saved.schemaVersion !== 1 ||
						saved.agentId !== command.agentId ||
						saved.applicationId !== command.applicationId ||
						typeof saved.granted !== "boolean" ||
						saved.replayed !== false ||
						(saved.authorizationRevision !== null &&
							!validText(saved.authorizationRevision))
					)
						throw new PersonalApiCredentialErrorV1("unavailable");
				}
				const target = and(
					eq(agentPrincipalGrants.agentId, command.agentId),
					eq(agentPrincipalGrants.principalType, "application"),
					eq(agentPrincipalGrants.principalId, command.applicationId),
					eq(agentPrincipalGrants.grantType, grantType),
				);
				let [grant] = await transaction
					.select()
					.from(agentPrincipalGrants)
					.where(target)
					.for("update");
				const plan = planAgentApplicationGrantV1({
					command,
					grantType,
					current: grant
						? {
								granted: grant.revokedAt === null,
								authorizationRevision: grant.authorizationRevision,
							}
						: null,
					replayed: existing !== undefined,
					nextRevision: randomUUID(),
					occurredAt: new Date(),
				});
				if (plan.mutation === "grant") {
					[grant] = await transaction
						.insert(agentPrincipalGrants)
						.values({
							agentId: command.agentId,
							principalType: "application",
							principalId: command.applicationId,
							grantType,
							authorizationRevision: plan.result.authorizationRevision ?? "",
						})
						.onConflictDoUpdate({
							target: [
								agentPrincipalGrants.agentId,
								agentPrincipalGrants.principalType,
								agentPrincipalGrants.principalId,
								agentPrincipalGrants.grantType,
							],
							set: {
								revokedAt: null,
								authorizationRevision: plan.result.authorizationRevision ?? "",
							},
						})
						.returning();
				} else if (plan.mutation === "revoke") {
					[grant] = await transaction
						.update(agentPrincipalGrants)
						.set({
							revokedAt: plan.occurredAt,
							authorizationRevision: plan.result.authorizationRevision ?? "",
						})
						.where(target)
						.returning();
				}
				const result = plan.result;
				await transaction
					.insert(auditEvents)
					.values({ id: randomUUID(), ...plan.audit });
				if (!existing)
					await transaction.insert(idempotencyRecords).values({
						id: randomUUID(),
						scopeType: "agent",
						scopeId: command.agentId,
						actorId: command.actorId,
						commandType,
						idempotencyKey: command.idempotencyKey,
						requestDigest: digest,
						status: "completed",
						result: { ...result },
					});
				const finalActor = await readActor();
				const [finalDisabled] = await transaction
					.select()
					.from(platformUserDisables)
					.where(eq(platformUserDisables.userId, command.actorId));
				const finalState = await readAgentManagementState(
					transaction,
					command.agentId,
				);
				const [finalApplication] = await transaction
					.select({
						id: platformApplications.id,
						status: platformApplications.status,
						authorizationRevision: platformApplications.authorizationRevision,
					})
					.from(platformApplications)
					.where(eq(platformApplications.id, command.applicationId));
				if (
					requireAgentApplicationGrantAuthorityV1({
						command,
						state: finalState,
						actor: finalActor,
						actorDisabled: finalDisabled !== undefined,
						application: finalApplication ?? null,
					}) !== actorRevision
				)
					throw new PersonalApiCredentialErrorV1("unavailable");
				const [finalGrant] = await transaction
					.select()
					.from(agentPrincipalGrants)
					.where(target);
				if (
					(finalGrant?.authorizationRevision ?? null) !==
						result.authorizationRevision ||
					(finalGrant !== undefined && finalGrant.revokedAt === null) !==
						result.granted
				)
					throw new PersonalApiCredentialErrorV1("unavailable");
				return result;
			});
		} catch (error) {
			const failure =
				error instanceof PersonalApiCredentialErrorV1
					? error
					: new PersonalApiCredentialErrorV1("unavailable");
			throw withAgentApiAuditContextV1(failure, auditContext);
		}
	}

	/** Browser Owner-only API-use revoke; governance and affected Task controls share one raw transaction. */
	async revokeUserApiUse(
		input: AgentUserUseRevokeCommandV1,
	): Promise<AgentUserUseRevokeResultV1> {
		const command = parseAgentUserUseRevokeCommandV1(input);
		const digest = platformIdempotencyV1.canonicalRequestDigest({
			schemaVersion: 1,
			agentId: command.agentId,
			userId: command.userId,
		});
		const commandType = "agent.user.use.revoke.v1";
		let auditContext: AgentApiAuditContextV1 = {
			command: "revoke_use",
		};
		try {
			return await this.#client.begin(async (transaction) => {
				await transaction`set local lock_timeout = '5s'`;
				await transaction`set local statement_timeout = '30s'`;
				await transaction`lock table platform.platform_user_disables in share row exclusive mode`;
				const actor = await resolveCurrentPersonalApiUserV1(
					this.#userDirectory,
					command.actorId,
				);
				const [actorDisabled] = await transaction<{ user_id: string }[]>`
					select user_id from platform.platform_user_disables where user_id = ${command.actorId}
				`;
				auditContext = {
					...auditContext,
					principal: { kind: "user", id: actor.userId },
					agentId: command.agentId,
				};
				if (
					actor.userId !== command.actorId ||
					actor.accountStatus !== "active" ||
					actorDisabled
				)
					throw new PersonalApiCredentialErrorV1("forbidden");
				const [agent] = await transaction<
					{
						status: string;
						owner_id: string;
						management_revision: number | string;
					}[]
				>`select application.status, owner.owner_id
					, application.management_revision
					from platform.agent_applications application
					join platform.agent_owners owner on owner.agent_id = application.agent_id
					where application.agent_id = ${command.agentId} and owner.owner_id = ${command.actorId}
					limit 1 for update`;
				if (
					!agent ||
					Number(agent.management_revision) !== command.expectedRevision ||
					![
						"creating",
						"available",
						"stopped",
						"creation_failed",
						"disabled",
					].includes(agent.status)
				)
					throw new PersonalApiCredentialErrorV1("not_found");
				await transaction`lock table platform.agent_principal_grants in share row exclusive mode`;
				const idempotencyScope = {
					select: async () =>
						transaction<
							{
								id: string;
								request_digest: string;
								status: string;
								result: unknown;
							}[]
						>`
							select id, request_digest, status, result from platform.idempotency_records
							where scope_type = 'agent' and scope_id = ${command.agentId}
								and actor_id = ${command.actorId} and command_type = ${commandType}
								and idempotency_key = ${command.idempotencyKey}
							for update
						`,
				};
				const [existing] = await idempotencyScope.select();
				if (existing && existing.request_digest !== digest)
					throw new PersonalApiCredentialErrorV1("idempotency_conflict");
				const [grant] = await transaction<
					{ authorization_revision: string; revoked_at: Date | null }[]
				>`select authorization_revision, revoked_at from platform.agent_principal_grants
					where agent_id = ${command.agentId} and principal_type = 'user'
						and principal_id = ${command.userId} and grant_type = 'use'
					for update`;
				if (existing) {
					const saved = existing.result as Record<string, unknown> | null;
					if (
						!saved ||
						typeof saved !== "object" ||
						Array.isArray(saved) ||
						Object.keys(saved).length !== 6 ||
						saved.schemaVersion !== 1 ||
						saved.agentId !== command.agentId ||
						saved.userId !== command.userId ||
						saved.granted !== false ||
						(saved.authorizationRevision !== null &&
							!validText(saved.authorizationRevision)) ||
						saved.replayed !== false
					)
						throw new PersonalApiCredentialErrorV1("unavailable");
					await transaction`
						insert into platform.audit_events
							(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
						values (${randomUUID()}, ${command.traceId}, 'user', ${command.actorId}, 'api.agent.use.replayed', 'agent', ${command.agentId}, 'succeeded', ${command.requestId}, ${command.agentId}, ${transaction.json(saved as unknown as JsonValue)})
					`;
					const finalActor = await resolveCurrentPersonalApiUserV1(
						this.#userDirectory,
						command.actorId,
					);
					const [finalOwner] = await transaction<{ owner_id: string }[]>`
						select owner_id from platform.agent_owners
						where agent_id = ${command.agentId} and owner_id = ${command.actorId}
						for update
					`;
					const [finalDisabled] = await transaction<{ user_id: string }[]>`
						select user_id from platform.platform_user_disables where user_id = ${command.actorId}
					`;
					if (
						finalActor.userId !== command.actorId ||
						finalActor.accountStatus !== "active" ||
						finalDisabled ||
						!finalOwner
					)
						throw new PersonalApiCredentialErrorV1("unavailable");
					return {
						...saved,
						replayed: true,
					} as unknown as AgentUserUseRevokeResultV1;
				}
				const plan = planAgentUserUseRevokeV1({
					command,
					current: grant
						? {
								granted: grant.revoked_at === null,
								authorizationRevision: grant.authorization_revision,
							}
						: null,
					replayed: false,
					nextRevision: randomUUID(),
					occurredAt: new Date(),
				});
				if (plan.mutation === "revoke") {
					await transaction`
						update platform.agent_principal_grants
						set revoked_at = ${plan.occurredAt}, authorization_revision = ${plan.result.authorizationRevision}
						where agent_id = ${command.agentId} and principal_type = 'user'
							and principal_id = ${command.userId} and grant_type = 'use'
					`;
					const executions = await transaction<{ execution_id: string }[]>`
						select execution_id from platform.conversation_executions
						where agent_id = ${command.agentId} and principal_type = 'user'
							and actor_id = ${command.userId}
							and channel_id in ('api', 'api:user')
							and status in ('waiting', 'submitted', 'processing', 'unknown')
					`;
					const { recordTaskSystemControlInTransactionV1 } = await import(
						"./task-authorization.ts"
					);
					for (const execution of executions) {
						const [record] = await transaction<{ id: string }[]>`
							select id from platform.task_authorization_records
							where execution_id = ${execution.execution_id} for update
						`;
						if (!record) throw new Error("Missing task authorization record");
						await recordTaskSystemControlInTransactionV1(transaction, {
							executionId: execution.execution_id,
							authorizationRecordId: record.id,
							reason: "authorization_revoked",
							workerId: `api-owner-revoke:${command.actorId}`,
							traceId: command.traceId,
							requestId: command.requestId,
						});
					}
				}
				await transaction`
					insert into platform.audit_events
						(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
						values (${randomUUID()}, ${command.traceId}, 'user', ${command.actorId}, ${plan.audit.action}, 'agent', ${command.agentId}, 'succeeded', ${command.requestId}, ${command.agentId}, ${transaction.json(plan.result as unknown as JsonValue)})
				`;
				if (!existing)
					await transaction`
						insert into platform.idempotency_records
							(id, scope_type, scope_id, actor_id, command_type, idempotency_key, request_digest, status, result, created_at, updated_at)
						values (${randomUUID()}, 'agent', ${command.agentId}, ${command.actorId}, ${commandType}, ${command.idempotencyKey}, ${digest}, 'completed', ${transaction.json(plan.result as unknown as JsonValue)}, ${plan.occurredAt}, ${plan.occurredAt})
					`;
				const finalActor = await resolveCurrentPersonalApiUserV1(
					this.#userDirectory,
					command.actorId,
				);
				const [finalDisabled] = await transaction<{ user_id: string }[]>`
					select user_id from platform.platform_user_disables where user_id = ${command.actorId}
				`;
				const [finalOwner] = await transaction<{ owner_id: string }[]>`
					select owner_id from platform.agent_owners
					where agent_id = ${command.agentId} and owner_id = ${command.actorId}
					for update
				`;
				const [finalGrant] = await transaction<
					{ authorization_revision: string; revoked_at: Date | null }[]
				>`select authorization_revision, revoked_at from platform.agent_principal_grants
					where agent_id = ${command.agentId} and principal_type = 'user'
						and principal_id = ${command.userId} and grant_type = 'use'
				`;
				if (
					finalActor.userId !== command.actorId ||
					finalActor.accountStatus !== "active" ||
					finalDisabled ||
					!finalOwner ||
					(finalGrant?.authorization_revision ?? null) !==
						plan.result.authorizationRevision ||
					(finalGrant?.revoked_at === null) !== plan.result.granted
				)
					throw new PersonalApiCredentialErrorV1("unavailable");
				return plan.result;
			});
		} catch (error) {
			const failure =
				error instanceof PersonalApiCredentialErrorV1
					? error
					: new PersonalApiCredentialErrorV1("unavailable");
			throw withAgentApiAuditContextV1(failure, auditContext);
		}
	}

	async recordApiManagementRefusal(input: {
		readonly requestId: string;
		readonly traceId: string;
		readonly reason: string;
		readonly failed: boolean;
		readonly operation: "lifecycle" | "manager" | "use" | "state" | "create";
		readonly context?: AgentApiAuditContextV1;
	}) {
		try {
			if (
				!validText(input.requestId) ||
				!validText(input.traceId) ||
				typeof input.failed !== "boolean" ||
				!["lifecycle", "manager", "use", "state", "create"].includes(
					input.operation,
				) ||
				![
					"invalid_input",
					"authentication_required",
					"forbidden",
					"not_found",
					"unavailable",
					"idempotency_conflict",
					"conflict",
					"denied",
				].includes(input.reason)
			)
				throw new Error();
			await this.#database.insert(auditEvents).values({
				id: randomUUID(),
				requestId: input.requestId,
				traceId: input.traceId,
				actorType: input.context?.principal?.kind ?? "unknown",
				actorId: input.context?.principal?.id ?? "unknown",
				action: `api.agent.${input.operation}.refused`,
				...(input.context?.agentId ? { agentId: input.context.agentId } : {}),
				targetType: input.context?.agentId ? "agent" : "unknown",
				targetId: input.context?.agentId ?? "unknown",
				outcome: input.failed ? "failed" : "rejected",
				occurredAt: new Date(),
				details: {
					reason: input.reason,
					...(input.context?.command ? { command: input.context.command } : {}),
				},
			});
		} catch {
			throw new PersonalApiCredentialErrorV1("unavailable");
		}
	}

	async resolveAgentAccessState(
		agentId: string,
	): Promise<AgentManagementStateV1 | undefined> {
		try {
			return await this.#database.transaction(
				async (transaction) => {
					const state = await readAgentManagementState(transaction, agentId);
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
	| { readonly kind: "administrator" }
	| { readonly kind: "api_user"; readonly userId: string }
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

function snapshotScopeTextArray(input: unknown): readonly string[] | undefined {
	if (!Array.isArray(input) || types.isProxy(input)) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(input);
	const keys = Reflect.ownKeys(descriptors);
	const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
	if (keys.length !== input.length + 1 || length !== input.length) {
		return undefined;
	}
	const values: string[] = [];
	for (let index = 0; index < input.length; index += 1) {
		const descriptor = descriptors[String(index)];
		if (
			descriptor?.enumerable !== true ||
			!Object.hasOwn(descriptor, "value") ||
			Object.hasOwn(descriptor, "get") ||
			Object.hasOwn(descriptor, "set") ||
			!validText(descriptor.value)
		) {
			return undefined;
		}
		values.push(descriptor.value);
	}
	return new Set(values).size === values.length ? values : undefined;
}

function requireAgentScope(
	scope: AgentManagementAgentScopeV1,
): AgentManagementAgentScopeV1 {
	try {
		if (
			typeof scope !== "object" ||
			scope === null ||
			Array.isArray(scope) ||
			types.isProxy(scope)
		) {
			throw new Error();
		}
		const descriptors = Object.getOwnPropertyDescriptors(scope);
		const keys = Reflect.ownKeys(descriptors);
		if (
			keys.some((key) => typeof key !== "string") ||
			keys.some((key) => {
				const descriptor = descriptors[key as string];
				return (
					descriptor?.enumerable !== true ||
					!Object.hasOwn(descriptor, "value") ||
					Object.hasOwn(descriptor, "get") ||
					Object.hasOwn(descriptor, "set")
				);
			})
		) {
			throw new Error();
		}
		const values = Object.fromEntries(
			keys.map((key) => [key, descriptors[key as string]?.value]),
		);
		const exact = (expected: readonly string[]) =>
			keys.length === expected.length &&
			expected.every((key) => Object.hasOwn(values, key));
		if (values.kind === "administrator" && exact(["kind"])) {
			return { kind: "administrator" };
		}
		if (
			values.kind === "api_user" &&
			exact(["kind", "userId"]) &&
			validText(values.userId)
		) {
			return { kind: "api_user", userId: values.userId };
		}
		if (
			values.kind === "owner" &&
			exact(["kind", "ownerId"]) &&
			validText(values.ownerId)
		) {
			return { kind: "owner", ownerId: values.ownerId };
		}
		const organizationIds = snapshotScopeTextArray(values.organizationIds);
		if (
			values.kind === "user" &&
			exact(["kind", "userId", "organizationIds"]) &&
			validText(values.userId) &&
			organizationIds
		) {
			return { kind: "user", userId: values.userId, organizationIds };
		}
	} catch {}
	throw new AgentManagementError("unavailable");
}

function applicationScopeCondition(scope: AgentManagementApplicationScopeV1) {
	return scope.kind === "administrator"
		? undefined
		: eq(agentApplications.applicantId, scope.applicantId);
}

function agentScopeCondition(scope: AgentManagementAgentScopeV1) {
	if (scope.kind === "administrator") return undefined;
	if (scope.kind === "api_user") {
		return sql<boolean>`exists (
			select 1 from ${agentPrincipalGrants}
			where ${agentPrincipalGrants.agentId} = ${agentApplications.agentId}
				and ${agentPrincipalGrants.principalType} = 'user'
				and ${agentPrincipalGrants.principalId} = ${scope.userId}
				and ${inArray(agentPrincipalGrants.grantType, [...personalApiAgentMetadataGrantTypesV1])}
				and ${agentPrincipalGrants.revokedAt} is null
		)`;
	}
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
	)`.mapWith(agentManagementHistory.occurredAt),
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
			const normalizedScope = requireAgentScope(scope);
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
						agentScopeCondition(normalizedScope),
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
			const normalizedScope = requireAgentScope(scope);
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
						agentScopeCondition(normalizedScope),
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
