import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
	type AgentApiAuditContextV1,
	type AgentApiCreationRowsV1,
	type AgentApiCreationTransactionV1,
	type AgentConfigurationAuthorityContextV1,
	AgentConfigurationError,
	ApplicationFoundationError,
	type ApplicationFoundationRelayKeyAttachmentV1,
	type ApplicationFoundationTransactionPortV1,
	type ApplicationFoundationWritePlanV1,
	agentApiCreationIdsV1,
	type CommitApplicationFoundationResultV1,
	captureAgentApiCreatePrincipalsV1,
	type PendingSecretRecordAttachmentsV1,
	PersonalApiCredentialErrorV1,
	planAgentApiCreationCompletionV1,
	requireAgentApiCreatePermissionV1,
	requirePersonalApiUserActiveV1,
	requirePersonalApiUserEnabledV1,
	resolveCurrentPersonalApiUserV1,
	snapshotApplicationFoundationWritePlanV1,
	type TaskUserDirectoryV1,
	withAgentApiAuditContextV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolveAgentApiIdentityV1 } from "./agent-api-identity.js";
import { decodeVersionedAgentConfigurationRecord as decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import { readAgentManagementState } from "./agent-management.js";
import { isPostgresError } from "./postgres-error.js";
import { replaceRelayKeyVersionInTransaction } from "./relay-key-versions.js";
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
	platformUserDisables,
} from "./schema.js";
import { insertPendingSecretRecordAttachments } from "./secret-records.js";

export interface PostgresApplicationFoundationOptions {
	readonly databaseUrl: string;
	readonly userDirectory?: TaskUserDirectoryV1;
	readonly apiCreation?: {
		readonly allowedPrincipals: Parameters<
			typeof captureAgentApiCreatePrincipalsV1
		>[0];
		readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
	};
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
		: `organization\0${target.organizationId}`;
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
		result.status !== "pending_approval"
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
	const timestamp = plan.agent.createdAt;
	const expectedResult: CommitApplicationFoundationResultV1 = {
		schemaVersion: 1,
		applicationId: plan.application.applicationId,
		agentId: plan.agent.agentId,
		configurationRevision: 1,
		status: "pending_approval",
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
		plan.application.status !== "pending_approval" ||
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
				: !validText(target.organizationId),
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
		plan.auditEvent.actorType !== "user" ||
		plan.auditEvent.actorId !== plan.application.applicantId ||
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

type FoundationTransaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

/** Both channels persist configuration, Secrets and the default Key on this exact transaction. */
async function persistApplicationFoundationRowsV1(
	transaction: FoundationTransaction,
	plan: ApplicationFoundationWritePlanV1 | AgentApiCreationRowsV1,
	configuration: ReturnType<typeof decodeAgentConfigurationRecord>,
	attachments?: PendingSecretRecordAttachmentsV1,
	defaultRelayKey?: ApplicationFoundationRelayKeyAttachmentV1,
) {
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
		...("creator" in plan
			? (({
					applicationId: _id,
					agentId: _agent,
					applicantId: _applicant,
					name: _name,
					description: _description,
					status: _status,
					traceId: _trace,
					requestId: _request,
					submittedAt: _submitted,
					...lifecycle
				}) => lifecycle)(plan.application)
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
	if (defaultRelayKey) {
		if (configuration.source.kind !== "standard")
			throw new ApplicationFoundationError("persistence_failed");
		// Keep the original Drizzle transaction; adapt only tagged SQL values.
		const keySql = async (
			parts: TemplateStringsArray,
			...parameters: (string | number)[]
		) => transaction.execute(sql(parts, ...parameters));
		const replacement = await replaceRelayKeyVersionInTransaction(keySql, {
			purpose: "agent-default",
			subjectId: plan.agent.agentId,
			expectedCurrentVersion: null,
			encrypt: (binding) =>
				defaultRelayKey.encrypt({
					...binding,
					purpose: "agent-default",
				}),
		});
		if (replacement.outcome !== "replaced")
			throw new ApplicationFoundationError("persistence_failed");
		const binding = replacement.binding;
		await transaction.insert(auditEvents).values({
			id: randomUUID(),
			traceId: plan.application.traceId,
			requestId: plan.application.requestId,
			agentId: plan.agent.agentId,
			actorType: "creator" in plan ? plan.creator.kind : "user",
			actorId:
				"creator" in plan ? plan.creator.id : plan.application.applicantId,
			action: "relay_key.agent_default.replace",
			targetType: "agent",
			targetId: plan.agent.agentId,
			outcome: "succeeded",
			occurredAt: plan.application.submittedAt,
			details: {
				schemaVersion: 1,
				previousVersion: null,
				keyVersion: binding.keyVersion,
				configurationRevision: 1,
			},
		});
	}
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
					target.kind === "user" ? target.userId : target.organizationId,
			})),
		);
	}
}

export class PostgresApplicationFoundationTransactionV1
	implements
		ApplicationFoundationTransactionPortV1,
		AgentApiCreationTransactionV1
{
	readonly #client;
	readonly #database;
	readonly #userDirectory;
	readonly #apiCreation;
	readonly #allowedPrincipals;

	constructor(options: PostgresApplicationFoundationOptions) {
		this.#allowedPrincipals = captureAgentApiCreatePrincipalsV1(
			options.apiCreation?.allowedPrincipals,
		);
		this.#apiCreation = options.apiCreation;
		this.#userDirectory = options.userDirectory;
		this.#client = postgres(options.databaseUrl, { max: 10 });
		this.#database = drizzle(this.#client);
	}

	async read(
		input: Parameters<ApplicationFoundationTransactionPortV1["read"]>[0],
	): ReturnType<ApplicationFoundationTransactionPortV1["read"]> {
		try {
			if (
				Object.keys(input).length !== 6 ||
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
			const [existing] = await this.#database
				.select({
					requestDigest: idempotencyRecords.requestDigest,
					status: idempotencyRecords.status,
					result: idempotencyRecords.result,
				})
				.from(idempotencyRecords)
				.where(
					idempotencyWhere(input.agentId, input.actorId, input.idempotencyKey),
				)
				.limit(1);
			if (!existing) return { outcome: "ready" };
			const replay = replayDecision(existing, input);
			if (replay.outcome === "conflict") {
				return { outcome: "idempotency_conflict" };
			}
			await requirePersistedReplayIntegrity(this.#database, replay.result);
			return replay;
		} catch (error) {
			if (error instanceof ApplicationFoundationError) throw error;
			throw new ApplicationFoundationError("persistence_failed");
		}
	}

	async commit(
		input: ApplicationFoundationWritePlanV1,
		attachments?: PendingSecretRecordAttachmentsV1,
		defaultRelayKey?: ApplicationFoundationRelayKeyAttachmentV1,
	): ReturnType<ApplicationFoundationTransactionPortV1["commit"]> {
		try {
			const { plan, configuration, result } = validatedPlan(input);
			if (configuration.schemaVersion === 3 && !defaultRelayKey) {
				throw new ApplicationFoundationError("persistence_failed");
			}
			return await this.#database.transaction(async (transaction) => {
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

				await persistApplicationFoundationRowsV1(
					transaction,
					plan,
					configuration,
					attachments,
					defaultRelayKey,
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

	async createAgentApiTransaction(
		input: Parameters<
			AgentApiCreationTransactionV1["createAgentApiTransaction"]
		>[0],
		prepare: Parameters<
			AgentApiCreationTransactionV1["createAgentApiTransaction"]
		>[1],
	): ReturnType<AgentApiCreationTransactionV1["createAgentApiTransaction"]> {
		let auditContext: AgentApiAuditContextV1 = { command: "create" };
		try {
			return await this.#database.transaction(async (transaction) => {
				await transaction.execute(sql`set local lock_timeout = '5s'`);
				await transaction.execute(sql`set local statement_timeout = '30s'`);
				const authenticated = await resolveAgentApiIdentityV1(
					transaction,
					input.material,
					this.#userDirectory,
					"agent:create",
				);
				const { principal } = authenticated.identity;
				auditContext = { ...auditContext, principal };
				requireAgentApiCreatePermissionV1(principal, this.#allowedPrincipals);
				const ids = agentApiCreationIdsV1(
					principal,
					input.command.idempotencyKey,
				);
				const commandType = `agent.api.create.${principal.kind}.v1`;
				const scope = and(
					eq(idempotencyRecords.scopeType, "agent"),
					eq(idempotencyRecords.scopeId, ids.agentId),
					eq(idempotencyRecords.actorId, principal.id),
					eq(idempotencyRecords.commandType, commandType),
					eq(idempotencyRecords.idempotencyKey, input.command.idempotencyKey),
				);
				const [reservation] = await transaction
					.insert(idempotencyRecords)
					.values({
						id: randomUUID(),
						scopeType: "agent",
						scopeId: ids.agentId,
						actorId: principal.id,
						commandType,
						idempotencyKey: input.command.idempotencyKey,
						requestDigest: input.requestDigest,
					})
					.onConflictDoNothing()
					.returning();
				const replayed = !reservation;
				let initial: AgentApiCreationRowsV1 | undefined;
				let revalidateCreationAuthority: (() => Promise<void>) | undefined;
				if (replayed) {
					const [existing] = await transaction
						.select()
						.from(idempotencyRecords)
						.where(scope);
					if (existing?.status !== "completed")
						throw new PersonalApiCredentialErrorV1("unavailable");

					const saved = existing.result as Record<string, unknown> | null;
					if (
						!saved ||
						Object.keys(saved).length !== 3 ||
						saved.schemaVersion !== 1 ||
						saved.agentId !== ids.agentId ||
						saved.applicationId !== ids.applicationId
					)
						throw new PersonalApiCredentialErrorV1("unavailable");
					await transaction
						.select()
						.from(agents)
						.where(eq(agents.id, ids.agentId))
						.for("update");
					const [application] = await transaction
						.select()
						.from(agentApplications)
						.where(eq(agentApplications.agentId, ids.agentId));
					if (
						application?.creationChannel !== "api" ||
						application.creatorPrincipalType !== principal.kind ||
						application.creatorPrincipalId !== principal.id
					)
						throw new PersonalApiCredentialErrorV1("unavailable");
					auditContext = { ...auditContext, agentId: ids.agentId };
					const grants = await transaction
						.select()
						.from(agentPrincipalGrants)
						.where(
							and(
								eq(agentPrincipalGrants.agentId, ids.agentId),
								eq(agentPrincipalGrants.principalType, principal.kind),
								eq(agentPrincipalGrants.principalId, principal.id),
							),
						)
						.for("share");
					if (
						!grants.some(
							(grant) =>
								grant.revokedAt === null &&
								(grant.grantType === "manage" || grant.grantType === "use"),
						)
					)
						throw new PersonalApiCredentialErrorV1("not_found");
					if (existing.requestDigest !== input.requestDigest)
						throw new PersonalApiCredentialErrorV1("idempotency_conflict");
				} else {
					const deployment = this.#apiCreation;
					if (!deployment) throw new PersonalApiCredentialErrorV1("forbidden");
					const [application] =
						principal.kind === "application"
							? await transaction
									.select()
									.from(platformApplications)
									.where(eq(platformApplications.id, principal.id))
									.for("share")
							: [];
					const ownerId =
						principal.kind === "user"
							? principal.id
							: application?.responsibleUserId;
					if (!ownerId) throw new PersonalApiCredentialErrorV1("forbidden");
					// Serialize current Platform disables without deriving application permission from its Owner.
					await transaction.execute(
						sql`lock table platform.platform_user_disables in share mode`,
					);
					const currentUser = async (id: string) => {
						const user = await resolveCurrentPersonalApiUserV1(
							this.#userDirectory,
							id,
						);
						const disabled = await transaction
							.select()
							.from(platformUserDisables)
							.where(eq(platformUserDisables.userId, id));
						requirePersonalApiUserActiveV1(user);
						requirePersonalApiUserEnabledV1(disabled.length !== 0);
						return user;
					};
					const owner = await currentUser(ownerId);
					const revision = randomUUID();
					const authorityContext = structuredClone(
						await deployment.loadAuthorityContext(),
					);
					const prepared = await prepare({
						principal,
						ownerId,
						...ids,
						authorizationRevision: revision,
						authorizationAdmission: {
							authorize: async (request) => {
								await authenticated.revalidate();
								requireAgentApiCreatePermissionV1(
									principal,
									this.#allowedPrincipals,
								);
								if (
									request.agentId !== ids.agentId ||
									request.actorId !== principal.id
								)
									return {
										schemaVersion: 1,
										status: "rejected",
										agentId: request.agentId,
										actorId: request.actorId,
									};
								return {
									schemaVersion: 1,
									agentId: request.agentId,
									actorId: request.actorId,
									status: "admitted",
									authorizationRevision: revision,
									authorityContext,
								};
							},
						},
					});
					const { rows, attachments, defaultRelayKey, outboxIntent } = prepared;
					const configuration = decodeAgentConfigurationRecord(
						rows.configurationRevision.configuration,
					);
					if (
						rows.creator.kind !== principal.kind ||
						rows.creator.id !== principal.id ||
						rows.agent.agentId !== ids.agentId ||
						rows.application.agentId !== ids.agentId ||
						rows.application.applicationId !== ids.applicationId ||
						rows.application.applicantId !== ownerId ||
						!rows.access.ownerIds.includes(ownerId) ||
						rows.agent.authorizationRevision !== revision ||
						configuration.agentId !== ids.agentId ||
						configuration.revision !== 1 ||
						rows.application.status !== "creating" ||
						(configuration.schemaVersion === 3 && !defaultRelayKey)
					)
						throw new PersonalApiCredentialErrorV1("unavailable");
					const references = new Set([
						...rows.access.ownerIds,
						...rows.access.availability
							.filter((target) => target.kind === "user")
							.map((target) => target.userId),
					]);
					const observed = await Promise.all(
						[...references].map(async (id) => ({
							id,
							revision: (await currentUser(id)).authorizationRevision,
						})),
					);
					await persistApplicationFoundationRowsV1(
						transaction,
						rows,
						configuration,
						attachments,
						defaultRelayKey,
					);
					await transaction.insert(agentPrincipalGrants).values(
						(["manage", "use"] as const).map((grantType) => ({
							agentId: ids.agentId,
							principalType: principal.kind,
							principalId: principal.id,
							grantType,
							authorizationRevision: rows.grants[grantType],
							createdAt: rows.agent.createdAt,
						})),
					);
					await transaction.insert(outboxItems).values({
						id: randomUUID(),
						scopeType: "agent",
						scopeId: ids.agentId,
						operation: outboxIntent.operation,
						payload: outboxIntent.payload,
						traceId: outboxIntent.traceId,
						requestId: outboxIntent.requestId,
						availableAt: outboxIntent.occurredAt,
						createdAt: outboxIntent.occurredAt,
						updatedAt: outboxIntent.occurredAt,
					});
					await transaction
						.update(idempotencyRecords)
						.set({
							status: "completed",
							result: { schemaVersion: 1, ...ids },
							updatedAt: sql`clock_timestamp()`,
						})
						.where(eq(idempotencyRecords.id, reservation.id));
					initial = rows;
					revalidateCreationAuthority = async () => {
						if (
							(await currentUser(ownerId)).authorizationRevision !==
							owner.authorizationRevision
						)
							throw new PersonalApiCredentialErrorV1("unavailable");
						for (const reference of observed)
							if (
								(await currentUser(reference.id)).authorizationRevision !==
								reference.revision
							)
								throw new PersonalApiCredentialErrorV1("unavailable");
						if (
							JSON.stringify(await deployment.loadAuthorityContext()) !==
							JSON.stringify(authorityContext)
						)
							throw new PersonalApiCredentialErrorV1("unavailable");
					};
				}
				const state = await readAgentManagementState(transaction, ids.agentId);
				if (!state) throw new PersonalApiCredentialErrorV1("unavailable");
				const completion = planAgentApiCreationCompletionV1({
					state,
					principal,
					command: input.command,
					...(initial ? { initial } : {}),
				});
				await transaction
					.insert(auditEvents)
					.values({ id: randomUUID(), ...completion.auditEvent });
				await transaction
					.update(platformApiCredentials)
					.set({ lastUsedAt: sql`clock_timestamp()` })
					.where(
						eq(
							platformApiCredentials.id,
							authenticated.identity.credential.credentialId,
						),
					);
				await revalidateCreationAuthority?.();
				await authenticated.revalidate();
				requireAgentApiCreatePermissionV1(principal, this.#allowedPrincipals);
				return completion.result;
			});
		} catch (error) {
			const failure =
				error instanceof PersonalApiCredentialErrorV1
					? error
					: error instanceof AgentConfigurationError
						? new PersonalApiCredentialErrorV1(
								error.code === "not_authorized"
									? "forbidden"
									: error.code === "invalid_command" ||
											error.code === "not_admitted"
										? "invalid_input"
										: "unavailable",
							)
						: new PersonalApiCredentialErrorV1("unavailable");
			throw withAgentApiAuditContextV1(failure, auditContext);
		}
	}

	async close(): Promise<void> {
		await this.#client.end();
	}
}
