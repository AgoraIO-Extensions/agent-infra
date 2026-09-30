import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
	ApplicationFoundationError,
	type ApplicationFoundationTransactionPortV1,
	type ApplicationFoundationWritePlanV1,
	type CommitApplicationFoundationResultV1,
	isCurrentApiCreationAuthorizedV1,
	type PendingSecretRecordAttachmentsV1,
	parseCurrentTaskUserV1,
	snapshotApplicationFoundationWritePlanV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import { isPostgresError } from "./postgres-error.js";
import {
	agentApplications,
	agentAvailability,
	agentConfigurationRevisions,
	agentOwners,
	agentPrincipalGrants,
	agents,
	auditEvents,
	idempotencyRecords,
	outboxItems,
	platformApiCredentials,
	platformApplications,
} from "./schema.js";
import { insertPendingSecretRecordAttachments } from "./secret-records.js";

export interface PostgresApplicationFoundationOptions {
	readonly databaseUrl: string;
	/** Resolve current directory facts for API user principals at write time. */
	readonly resolveUser?: (userId: string) => Promise<unknown | null>;
}

interface IdempotencyRow {
	readonly requestDigest: string;
	readonly status: "reserved" | "completed";
	readonly result: unknown;
}

const scopeType = "agent";
const commandType = "agent.application.submit.v1";

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

function canonicalSourceReference(
	configuration: ReturnType<typeof decodeAgentConfigurationRecord>,
): string {
	return configuration.source.kind === "standard"
		? configuration.source.templateId
		: configuration.source.imageDigest;
}

function accessTargetKey(
	target: ApplicationFoundationWritePlanV1["access"]["availability"][number],
): string {
	return target.kind === "user"
		? `user\0${target.userId}`
		: target.kind === "organization"
			? `organization\0${target.organizationId}`
			: `application\0${target.applicationId}`;
}

function parseResult(input: unknown): CommitApplicationFoundationResultV1 {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new ApplicationFoundationError("persistence_failed");
	}
	const result = input as Record<string, unknown>;
	if (
		Object.keys(result).length !== 5 ||
		result.schemaVersion !== 1 ||
		!validText(result.applicationId) ||
		!validText(result.agentId) ||
		result.configurationRevision !== 1 ||
		(result.status !== "pending_approval" && result.status !== "creating")
	) {
		throw new ApplicationFoundationError("persistence_failed");
	}
	return structuredClone(
		result,
	) as unknown as CommitApplicationFoundationResultV1;
}

function validatedPlan(input: ApplicationFoundationWritePlanV1) {
	const plan = snapshotApplicationFoundationWritePlanV1(input);
	let configuration: ReturnType<typeof decodeAgentConfigurationRecord>;
	try {
		configuration = decodeAgentConfigurationRecord(
			plan.configurationRevision.configuration,
		);
	} catch {
		throw new ApplicationFoundationError("persistence_failed");
	}
	const result = parseResult(plan.result);
	const ownerIds = [...plan.access.ownerIds];
	const targetKeys = plan.access.availability.map(accessTargetKey);
	const principal = plan.principal;
	const timestamp = plan.agent.createdAt;
	const expectedResult: CommitApplicationFoundationResultV1 = {
		schemaVersion: 1,
		applicationId: plan.application.applicationId,
		agentId: plan.agent.agentId,
		configurationRevision: 1,
		status: result.status,
	};
	const expectedPayload = {
		schemaVersion: 1,
		applicationId: plan.application.applicationId,
		agentId: plan.agent.agentId,
		configurationRevision: 1,
	};
	if (
		plan.schemaVersion !== 1 ||
		!validText(plan.agent.agentId) ||
		plan.agent.currentConfigurationRevision !== 1 ||
		!validText(plan.agent.authorizationRevision) ||
		!validText(plan.application.applicationId) ||
		plan.application.agentId !== plan.agent.agentId ||
		!validText(plan.application.applicantId) ||
		!validText(plan.application.name, 800) ||
		Array.from(plan.application.name).length > 200 ||
		!validText(plan.application.description, 65_536) ||
		(plan.application.status !== "pending_approval" &&
			plan.application.status !== "creating") ||
		(plan.application.status === "creating"
			? !principal || !plan.apiAuthority
			: plan.apiAuthority !== undefined) ||
		(principal?.kind === "user" &&
			principal.id !== plan.application.applicantId) ||
		!validText(plan.application.traceId) ||
		!validText(plan.application.requestId) ||
		plan.configurationRevision.agentId !== plan.agent.agentId ||
		plan.configurationRevision.revision !== 1 ||
		configuration.agentId !== plan.agent.agentId ||
		configuration.revision !== 1 ||
		!sameValue(configuration, plan.configurationRevision.configuration) ||
		plan.access.agentId !== plan.agent.agentId ||
		ownerIds.length === 0 ||
		ownerIds.length > 256 ||
		ownerIds.some((ownerId) => !validText(ownerId)) ||
		new Set(ownerIds).size !== ownerIds.length ||
		!sameValue(ownerIds, ownerIds.toSorted()) ||
		!ownerIds.includes(plan.application.applicantId) ||
		targetKeys.length > 256 ||
		new Set(targetKeys).size !== targetKeys.length ||
		!sameValue(targetKeys, targetKeys.toSorted()) ||
		plan.access.availability.some((target) =>
			target.kind === "user"
				? !validText(target.userId)
				: target.kind === "organization"
					? !validText(target.organizationId)
					: !validText(target.applicationId),
		) ||
		!sameValue(result, expectedResult) ||
		!validText(plan.idempotency.key, 128) ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(plan.idempotency.key) ||
		!/^[a-f0-9]{64}$/.test(plan.idempotency.requestDigest) ||
		plan.outboxIntent.scopeType !== scopeType ||
		plan.outboxIntent.scopeId !== plan.agent.agentId ||
		plan.outboxIntent.operation !== "agent.application.submitted.v1" ||
		!sameValue(plan.outboxIntent.payload, expectedPayload) ||
		plan.outboxIntent.traceId !== plan.application.traceId ||
		plan.outboxIntent.requestId !== plan.application.requestId ||
		plan.auditEvent.traceId !== plan.application.traceId ||
		plan.auditEvent.requestId !== plan.application.requestId ||
		plan.auditEvent.agentId !== plan.agent.agentId ||
		(plan.auditEvent.actorType !== "user" &&
			plan.auditEvent.actorType !== "application") ||
		(plan.auditEvent.actorType === "user" &&
			plan.auditEvent.actorId !== plan.application.applicantId) ||
		(principal !== undefined &&
			(principal.kind !== plan.auditEvent.actorType ||
				principal.id !== plan.auditEvent.actorId)) ||
		plan.auditEvent.action !== "agent.application.submitted" ||
		plan.auditEvent.targetType !== "agent_application" ||
		plan.auditEvent.targetId !== plan.application.applicationId ||
		plan.auditEvent.outcome !== "succeeded" ||
		!validDate(timestamp) ||
		[
			plan.application.submittedAt,
			plan.configurationRevision.createdAt,
			plan.access.createdAt,
			plan.outboxIntent.occurredAt,
			plan.auditEvent.occurredAt,
		].some(
			(value) =>
				!validDate(value) ||
				Date.prototype.getTime.call(value) !==
					Date.prototype.getTime.call(timestamp),
		)
	) {
		throw new ApplicationFoundationError("persistence_failed");
	}
	return { plan, configuration, result };
}

function idempotencyWhere(
	agentId: string,
	actorId: string,
	idempotencyKey: string,
) {
	return and(
		eq(idempotencyRecords.scopeType, scopeType),
		eq(idempotencyRecords.scopeId, agentId),
		eq(idempotencyRecords.actorId, actorId),
		eq(idempotencyRecords.commandType, commandType),
		eq(idempotencyRecords.idempotencyKey, idempotencyKey),
	);
}

function replayDecision(
	row: IdempotencyRow,
	input: {
		readonly applicationId: string;
		readonly agentId: string;
		readonly requestDigest: string;
	},
) {
	if (row.requestDigest !== input.requestDigest) {
		return {
			outcome: "conflict" as const,
			reason: "idempotency_conflict" as const,
		};
	}
	if (row.status !== "completed") {
		throw new ApplicationFoundationError("persistence_failed");
	}
	const result = parseResult(row.result);
	if (
		result.agentId !== input.agentId ||
		result.applicationId !== input.applicationId
	) {
		throw new ApplicationFoundationError("persistence_failed");
	}
	return { outcome: "replayed" as const, result };
}

async function requirePersistedReplayIntegrity(
	database: Pick<ReturnType<typeof drizzle>, "select">,
	result: CommitApplicationFoundationResultV1,
): Promise<void> {
	const [persisted] = await database
		.select({
			agentId: agents.id,
			applicationAgentId: agentApplications.agentId,
			configuration: agentConfigurationRevisions.configuration,
			sourceReference: agentConfigurationRevisions.sourceReference,
		})
		.from(agents)
		.innerJoin(
			agentApplications,
			and(
				eq(agentApplications.agentId, agents.id),
				eq(agentApplications.id, result.applicationId),
			),
		)
		.innerJoin(
			agentConfigurationRevisions,
			and(
				eq(agentConfigurationRevisions.agentId, agents.id),
				eq(agentConfigurationRevisions.revision, result.configurationRevision),
			),
		)
		.where(eq(agents.id, result.agentId))
		.limit(1);
	if (!persisted?.configuration) {
		throw new ApplicationFoundationError("persistence_failed");
	}
	const replayedConfiguration = decodeAgentConfigurationRecord(
		persisted.configuration,
	);
	if (
		persisted.applicationAgentId !== result.agentId ||
		replayedConfiguration.agentId !== result.agentId ||
		replayedConfiguration.revision !== result.configurationRevision ||
		persisted.sourceReference !==
			canonicalSourceReference(replayedConfiguration)
	) {
		throw new ApplicationFoundationError("persistence_failed");
	}
}

async function requireCurrentApiCreationAuthority(
	database: Pick<ReturnType<typeof drizzle>, "select">,
	input: {
		readonly principal: NonNullable<
			ApplicationFoundationWritePlanV1["principal"]
		>;
		readonly apiAuthority: NonNullable<
			ApplicationFoundationWritePlanV1["apiAuthority"]
		>;
		readonly applicantId: string;
	},
	resolveUser?: (userId: string) => Promise<unknown | null>,
): Promise<void> {
	const [credential] = await database
		.select({
			principalType: platformApiCredentials.principalType,
			principalId: platformApiCredentials.principalId,
			scopes: platformApiCredentials.scopes,
			expiresAt: platformApiCredentials.expiresAt,
			revokedAt: platformApiCredentials.revokedAt,
		})
		.from(platformApiCredentials)
		.where(eq(platformApiCredentials.id, input.apiAuthority.credentialId))
		.limit(1)
		.for("share");
	const [clock] = await database
		.select({ now: sql<Date>`clock_timestamp()` })
		.from(platformApiCredentials)
		.where(eq(platformApiCredentials.id, input.apiAuthority.credentialId))
		.limit(1);
	let currentUser: ReturnType<typeof parseCurrentTaskUserV1> | null = null;
	if (input.principal.kind === "user") {
		try {
			if (!resolveUser) throw new Error("Current user resolver is unavailable");
			currentUser = parseCurrentTaskUserV1(
				await resolveUser(input.principal.id),
			);
		} catch {
			throw new ApplicationFoundationError("not_authorized");
		}
	}
	let application: {
		status: string;
		responsibleUserId: string;
		authorizationRevision: string;
	} | null = null;
	if (input.principal.kind === "application") {
		const [currentApplication] = await database
			.select({
				status: platformApplications.status,
				responsibleUserId: platformApplications.responsibleUserId,
				authorizationRevision: platformApplications.authorizationRevision,
			})
			.from(platformApplications)
			.where(eq(platformApplications.id, input.principal.id))
			.limit(1)
			.for("share");
		application = currentApplication ?? null;
	}
	if (
		!isCurrentApiCreationAuthorizedV1({
			principal: input.principal,
			applicantId: input.applicantId,
			identityRevision: input.apiAuthority.identityRevision,
			credential: credential ?? null,
			now: clock?.now ?? null,
			user: currentUser,
			application,
		})
	)
		throw new ApplicationFoundationError("not_authorized");
}

export class PostgresApplicationFoundationTransactionV1
	implements ApplicationFoundationTransactionPortV1
{
	readonly #client;
	readonly #database;
	readonly #resolveUser;

	constructor(options: PostgresApplicationFoundationOptions) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
		this.#database = drizzle(this.#client);
		this.#resolveUser = options.resolveUser;
	}

	async read(
		input: Parameters<ApplicationFoundationTransactionPortV1["read"]>[0],
	): ReturnType<ApplicationFoundationTransactionPortV1["read"]> {
		try {
			const apiRequest = Object.hasOwn(input, "apiAuthority");
			if (
				Object.keys(input).length !== (apiRequest ? 9 : 6) ||
				input.schemaVersion !== 1 ||
				!validText(input.applicationId) ||
				!validText(input.agentId) ||
				!validText(input.actorId) ||
				!validText(input.idempotencyKey, 128) ||
				!/^[A-Za-z0-9._~-]{1,128}$/.test(input.idempotencyKey) ||
				!/^[a-f0-9]{64}$/.test(input.requestDigest)
			) {
				throw new ApplicationFoundationError("persistence_failed");
			}
			if (
				apiRequest &&
				(!input.principal ||
					(input.principal.kind !== "user" &&
						input.principal.kind !== "application") ||
					!validText(input.principal.id) ||
					!validText(input.applicantId) ||
					!input.apiAuthority ||
					!validText(input.apiAuthority.credentialId) ||
					!validText(input.apiAuthority.identityRevision))
			)
				throw new ApplicationFoundationError("persistence_failed");
			return await this.#database.transaction(async (transaction) => {
				if (
					apiRequest &&
					input.principal &&
					input.apiAuthority &&
					input.applicantId
				)
					await requireCurrentApiCreationAuthority(
						transaction,
						{
							principal: input.principal,
							apiAuthority: input.apiAuthority,
							applicantId: input.applicantId,
						},
						this.#resolveUser,
					);
				const [existing] = await transaction
					.select({
						requestDigest: idempotencyRecords.requestDigest,
						status: idempotencyRecords.status,
						result: idempotencyRecords.result,
					})
					.from(idempotencyRecords)
					.where(
						idempotencyWhere(
							input.agentId,
							input.actorId,
							input.idempotencyKey,
						),
					)
					.limit(1);
				if (!existing) return { outcome: "ready" };
				const replay = replayDecision(existing, input);
				if (replay.outcome === "conflict")
					return { outcome: "idempotency_conflict" };
				await requirePersistedReplayIntegrity(transaction, replay.result);
				return replay;
			});
		} catch (error) {
			if (error instanceof ApplicationFoundationError) throw error;
			throw new ApplicationFoundationError("persistence_failed");
		}
	}

	async commit(
		input: ApplicationFoundationWritePlanV1,
		attachments?: PendingSecretRecordAttachmentsV1,
	): ReturnType<ApplicationFoundationTransactionPortV1["commit"]> {
		try {
			const { plan, configuration, result } = validatedPlan(input);
			return await this.#database.transaction(async (transaction) => {
				if (plan.application.status === "creating") {
					if (!plan.principal || !plan.apiAuthority)
						throw new ApplicationFoundationError("not_authorized");
					await requireCurrentApiCreationAuthority(
						transaction,
						{
							principal: plan.principal,
							apiAuthority: plan.apiAuthority,
							applicantId: plan.application.applicantId,
						},
						this.#resolveUser,
					);
				}
				const [reservation] = await transaction
					.insert(idempotencyRecords)
					.values({
						id: randomUUID(),
						scopeType,
						scopeId: plan.agent.agentId,
						actorId: plan.auditEvent.actorId,
						commandType,
						idempotencyKey: plan.idempotency.key,
						requestDigest: plan.idempotency.requestDigest,
						createdAt: plan.agent.createdAt,
						updatedAt: plan.agent.createdAt,
					})
					.onConflictDoNothing()
					.returning({ id: idempotencyRecords.id });
				if (!reservation) {
					const [existing] = await transaction
						.select({
							requestDigest: idempotencyRecords.requestDigest,
							status: idempotencyRecords.status,
							result: idempotencyRecords.result,
						})
						.from(idempotencyRecords)
						.where(
							idempotencyWhere(
								plan.agent.agentId,
								plan.auditEvent.actorId,
								plan.idempotency.key,
							),
						)
						.limit(1);
					if (!existing) {
						throw new ApplicationFoundationError("persistence_failed");
					}
					const replay = replayDecision(existing, {
						applicationId: plan.application.applicationId,
						agentId: plan.agent.agentId,
						requestDigest: plan.idempotency.requestDigest,
					});
					if (replay.outcome === "replayed") {
						await requirePersistedReplayIntegrity(transaction, replay.result);
					}
					return replay;
				}
				await transaction.insert(agents).values({
					id: plan.agent.agentId,
					currentConfigurationRevision: plan.agent.currentConfigurationRevision,
					authorizationRevision: plan.agent.authorizationRevision,
					createdAt: plan.agent.createdAt,
				});
				await transaction.insert(agentApplications).values({
					id: plan.application.applicationId,
					agentId: plan.application.agentId,
					applicantId: plan.application.applicantId,
					name: plan.application.name,
					description: plan.application.description,
					status: plan.application.status,
					...(plan.application.status === "creating"
						? {
								managementRevision: 1,
								// API creation bypasses Web approval, so it is immediately
								// eligible for the Workload reconciliation candidate query.
								approvalRevision: 1,
								desiredState: "running" as const,
								workloadRevision: 1,
								fence: 1,
							}
						: {}),
					traceId: plan.application.traceId,
					requestId: plan.application.requestId,
					submittedAt: plan.application.submittedAt,
				});
				await transaction.insert(agentConfigurationRevisions).values({
					agentId: plan.configurationRevision.agentId,
					revision: plan.configurationRevision.revision,
					sourceReference: canonicalSourceReference(configuration),
					configuration,
					createdAt: plan.configurationRevision.createdAt,
				});
				await insertPendingSecretRecordAttachments(
					transaction,
					attachments,
					configuration,
				);
				await transaction.insert(agentOwners).values(
					plan.access.ownerIds.map((ownerId) => ({
						agentId: plan.access.agentId,
						ownerId,
						createdAt: plan.access.createdAt,
					})),
				);
				if (plan.access.availability.length > 0) {
					await transaction.insert(agentAvailability).values(
						plan.access.availability.map((target) => ({
							agentId: plan.access.agentId,
							targetType: target.kind,
							targetId:
								target.kind === "user"
									? target.userId
									: target.kind === "organization"
										? target.organizationId
										: target.applicationId,
						})),
					);
				}
				const grantPrincipal =
					plan.principal ??
					({ kind: "user", id: plan.application.applicantId } as const);
				await transaction.insert(agentPrincipalGrants).values(
					(["manage", "use"] as const).map((grantType) => ({
						agentId: plan.agent.agentId,
						principalType: grantPrincipal.kind,
						principalId: grantPrincipal.id,
						grantType,
						authorizationRevision: plan.agent.authorizationRevision,
					})),
				);
				await transaction.insert(outboxItems).values({
					id: randomUUID(),
					scopeType: plan.outboxIntent.scopeType,
					scopeId: plan.outboxIntent.scopeId,
					operation: plan.outboxIntent.operation,
					payload: plan.outboxIntent.payload,
					traceId: plan.outboxIntent.traceId,
					requestId: plan.outboxIntent.requestId,
					availableAt: plan.outboxIntent.occurredAt,
					createdAt: plan.outboxIntent.occurredAt,
					updatedAt: plan.outboxIntent.occurredAt,
				});
				await transaction.insert(auditEvents).values({
					id: randomUUID(),
					traceId: plan.auditEvent.traceId,
					requestId: plan.auditEvent.requestId,
					agentId: plan.auditEvent.agentId,
					actorType: plan.auditEvent.actorType,
					actorId: plan.auditEvent.actorId,
					action: plan.auditEvent.action,
					targetType: plan.auditEvent.targetType,
					targetId: plan.auditEvent.targetId,
					outcome: plan.auditEvent.outcome,
					occurredAt: plan.auditEvent.occurredAt,
				});
				if (plan.result.status === "creating") {
					await transaction.insert(auditEvents).values(
						(["manage", "use"] as const).map((grantType) => ({
							id: randomUUID(),
							traceId: plan.auditEvent.traceId,
							requestId: plan.auditEvent.requestId,
							agentId: plan.auditEvent.agentId,
							actorType: plan.auditEvent.actorType,
							actorId: plan.auditEvent.actorId,
							action: "api.agent.grant.granted" as const,
							targetType: "grant" as const,
							targetId: plan.agent.agentId,
							outcome: "succeeded" as const,
							details: {
								recipient: grantPrincipal,
								grantType,
							},
							occurredAt: plan.auditEvent.occurredAt,
						})),
					);
				}
				const [completed] = await transaction
					.update(idempotencyRecords)
					.set({
						status: "completed",
						result: { ...result },
						updatedAt: plan.agent.createdAt,
					})
					.where(eq(idempotencyRecords.id, reservation.id))
					.returning({ id: idempotencyRecords.id });
				if (!completed) {
					throw new ApplicationFoundationError("persistence_failed");
				}
				return { outcome: "committed", result };
			});
		} catch (error) {
			if (error instanceof ApplicationFoundationError) throw error;
			if (isPostgresError(error, "23505")) {
				return { outcome: "conflict", reason: "duplicate" };
			}
			throw new ApplicationFoundationError("persistence_failed");
		}
	}

	async close(): Promise<void> {
		await this.#client.end();
	}
}
