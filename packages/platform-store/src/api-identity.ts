import { randomUUID } from "node:crypto";

import {
	type ApiCredentialMetadataV1,
	type ApiCredentialScopeV1,
	type ApiIdentityActorV1,
	type ApiIdentityAuditInputV1,
	ApiIdentityError,
	type ApiPrincipalV1,
	type CurrentTaskUserV1,
	hashApiCredentialV1,
	isApiCredentialScopeV1,
	isCurrentAgentGrantManageAllowedV1,
	isCurrentApiIdentityBrowserActorV1,
	isCurrentApiIdentityUserWriteAllowedV1,
	isCurrentCredentialDeliveryManagerV1,
	isIndependentApiCredentialDeliveryRecipientV1,
	parseCurrentTaskUserV1,
} from "@agent-infra/platform-core";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
	agentOwners,
	agentPrincipalGrants,
	agents,
	apiCredentialDeliveryGrants,
	auditEvents,
	idempotencyRecords,
	ldapIdentityIds,
	platformApiCredentials,
	platformApplications,
	platformUserDisables,
} from "./schema.js";

export interface PostgresApiIdentityStoreOptionsV1 {
	readonly databaseUrl: string;
	readonly resolveUser?: (userId: string) => Promise<unknown | null>;
}

export type {
	ApiIdentityAuditActionV1,
	ApiIdentityAuditInputV1,
	ApiIdentityAuditReasonV1,
} from "@agent-infra/platform-core";

type ApiIdentityDatabase = ReturnType<typeof drizzle>;
type ApiIdentityAuditDatabase = Pick<ApiIdentityDatabase, "insert">;

type ApiIdentityAuditTargetV1 = ApiIdentityAuditInputV1 & {
	readonly targetId: string;
};

async function currentUserAtWrite(
	database: Pick<ApiIdentityDatabase, "select">,
	userId: string,
	resolveUser?: (userId: string) => Promise<unknown | null>,
): Promise<ReturnType<typeof parseCurrentTaskUserV1> | null> {
	// A deployment without LDAP mappings still resolves its own user authority.
	await database
		.select({ userId: ldapIdentityIds.userId })
		.from(ldapIdentityIds)
		.where(eq(ldapIdentityIds.userId, userId))
		.limit(1)
		.for("share");
	const [disabled] = await database
		.select({ userId: platformUserDisables.userId })
		.from(platformUserDisables)
		.where(eq(platformUserDisables.userId, userId))
		.limit(1);
	if (disabled || !resolveUser) return null;
	try {
		return parseCurrentTaskUserV1(await resolveUser(userId));
	} catch {
		return null;
	}
}

async function writeApiIdentityAudit(
	database: ApiIdentityAuditDatabase,
	input: ApiIdentityAuditTargetV1,
): Promise<void> {
	const details =
		input.action === "api.access.rejected"
			? {
					reason: input.reason,
					requiredScopes: input.requiredScopes ?? [],
				}
			: {
					recipient: input.recipient ?? null,
					grantType: input.grantType ?? null,
				};
	await database.insert(auditEvents).values({
		id: randomUUID(),
		traceId: input.traceId,
		requestId: input.requestId,
		actorType: input.actor.kind,
		actorId: input.actor.id,
		action: input.action,
		targetType: "grant",
		targetId: input.targetId,
		outcome: input.outcome ?? "succeeded",
		details,
		occurredAt: new Date(),
	});
}

function principalType(principal: ApiPrincipalV1): "user" | "application" {
	return principal.kind;
}

async function hasCurrentDeliveryManager(
	database: Pick<ApiIdentityDatabase, "select">,
	actor: ApiIdentityActorV1,
	responsibleUserId: string,
	resolveUser?: (userId: string) => Promise<unknown | null>,
): Promise<boolean> {
	if (!resolveUser) return false;
	try {
		const current = await currentUserAtWrite(
			database,
			actor.userId,
			resolveUser,
		);
		return isCurrentCredentialDeliveryManagerV1({
			actor,
			responsibleUserId,
			currentUser: current,
		});
	} catch {
		return false;
	}
}

async function hasCurrentManageAuthority(
	database: Pick<ApiIdentityDatabase, "select" | "execute">,
	actor: ApiIdentityActorV1,
	agentId: string,
	authorizationRevision: string | null,
	resolveUser?: (userId: string) => Promise<unknown | null>,
): Promise<boolean> {
	let application: {
		status: string;
		responsibleUserId: string;
		authorizationRevision: string;
	} | null = null;
	if (actor.principal?.kind === "application") {
		const [row] = await database
			.select({
				status: platformApplications.status,
				responsibleUserId: platformApplications.responsibleUserId,
				authorizationRevision: platformApplications.authorizationRevision,
			})
			.from(platformApplications)
			.where(eq(platformApplications.id, actor.principal.id))
			.limit(1)
			.for("share");
		application = row ?? null;
	}
	const [credential] =
		actor.principal && actor.credential
			? await database
					.select({
						principalType: platformApiCredentials.principalType,
						principalId: platformApiCredentials.principalId,
						scopes: platformApiCredentials.scopes,
						expiresAt: platformApiCredentials.expiresAt,
						revokedAt: platformApiCredentials.revokedAt,
						recipientUserId: platformApiCredentials.recipientUserId,
					})
					.from(platformApiCredentials)
					.where(eq(platformApiCredentials.id, actor.credential.credentialId))
					.limit(1)
					.for("share")
			: [];
	const currentUser =
		actor.principal?.kind === "application"
			? null
			: await currentUserAtWrite(database, actor.userId, resolveUser);
	let recipient: CurrentTaskUserV1 | null = null;
	let delivery: {
		authorizationRevision: string;
		revokedAt: Date | null;
	} | null = null;
	if (actor.principal?.kind === "application" && credential?.recipientUserId) {
		recipient = await currentUserAtWrite(
			database,
			credential.recipientUserId,
			resolveUser,
		);
		const [row] = await database
			.select({
				authorizationRevision:
					apiCredentialDeliveryGrants.authorizationRevision,
				revokedAt: apiCredentialDeliveryGrants.revokedAt,
			})
			.from(apiCredentialDeliveryGrants)
			.where(
				and(
					eq(apiCredentialDeliveryGrants.applicationId, actor.principal.id),
					eq(apiCredentialDeliveryGrants.principalType, "user"),
					eq(
						apiCredentialDeliveryGrants.principalId,
						credential.recipientUserId,
					),
				),
			)
			.limit(1)
			.for("share");
		delivery = row ?? null;
	}
	const [owner] =
		actor.principal === undefined
			? await database
					.select({ agentId: agentOwners.agentId })
					.from(agentOwners)
					.where(
						and(
							eq(agentOwners.agentId, agentId),
							eq(agentOwners.ownerId, actor.userId),
						),
					)
					.limit(1)
					.for("share")
			: [];
	const grants = actor.principal
		? await database
				.select({
					grantType: agentPrincipalGrants.grantType,
					authorizationRevision: agentPrincipalGrants.authorizationRevision,
					revokedAt: agentPrincipalGrants.revokedAt,
				})
				.from(agentPrincipalGrants)
				.where(
					and(
						eq(agentPrincipalGrants.agentId, agentId),
						eq(agentPrincipalGrants.principalType, actor.principal.kind),
						eq(agentPrincipalGrants.principalId, actor.principal.id),
					),
				)
				.for("share")
		: [];
	const clock = await database.execute<{ now_ms: string }>(
		sql`select (extract(epoch from clock_timestamp()) * 1000)::text as now_ms`,
	);
	return isCurrentAgentGrantManageAllowedV1({
		actor,
		credential: credential ?? null,
		currentUser,
		application,
		recipient,
		delivery,
		nowMs: Number(clock[0]?.now_ms),
		isOwner: owner !== undefined,
		authorizationRevision,
		grants,
	});
}

function metadata(
	row: typeof platformApiCredentials.$inferSelect,
): ApiCredentialMetadataV1 {
	if (row.principalType !== "user" && row.principalType !== "application") {
		throw new Error("Invalid credential principal");
	}
	const scopes = row.scopes.filter(
		isApiCredentialScopeV1,
	) as ApiCredentialScopeV1[];
	if (scopes.length !== row.scopes.length)
		throw new Error("Invalid credential scopes");
	return {
		schemaVersion: 1,
		credentialId: row.id,
		principal: { kind: row.principalType, id: row.principalId },
		scopes,
		expiresAt: row.expiresAt,
		revokedAt: row.revokedAt,
		createdAt: row.createdAt,
	};
}

export class PostgresApiIdentityStoreV1 {
	readonly #client;
	readonly #database;
	readonly #resolveUser;

	constructor(options: PostgresApiIdentityStoreOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 4 });
		this.#database = drizzle(this.#client);
		this.#resolveUser = options.resolveUser;
	}

	async close(): Promise<void> {
		await this.#client.end({ timeout: 5 });
	}

	async writeAudit(
		input: ApiIdentityAuditInputV1 & { readonly targetId: string },
	): Promise<void> {
		await writeApiIdentityAudit(this.#database, input);
	}

	async createApplication(input: {
		readonly actor: ApiIdentityActorV1;
		readonly applicationId: string;
		readonly name: string;
		readonly responsibleUserId: string;
		readonly authorizationRevision: string;
		readonly idempotencyKey?: string;
		readonly requestDigest?: string;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<string> {
		if (
			(input.idempotencyKey === undefined) !==
				(input.requestDigest === undefined) ||
			(input.idempotencyKey !== undefined &&
				!/^[A-Za-z0-9._~-]{1,128}$/.test(input.idempotencyKey)) ||
			(input.requestDigest !== undefined &&
				!/^[a-f0-9]{64}$/.test(input.requestDigest))
		)
			throw new TypeError("Invalid application idempotency input");
		return this.#database.transaction(async (transaction) => {
			if (
				!isCurrentApiIdentityUserWriteAllowedV1({
					actor: input.actor,
					userId: input.responsibleUserId,
					currentUser: await currentUserAtWrite(
						transaction,
						input.actor.userId,
						this.#resolveUser,
					),
				})
			)
				throw new ApiIdentityError("not_authorized");
			if (
				input.idempotencyKey !== undefined &&
				input.requestDigest !== undefined
			) {
				const [reservation] = await transaction
					.insert(idempotencyRecords)
					.values({
						id: randomUUID(),
						scopeType: "user",
						scopeId: input.responsibleUserId,
						actorId: input.responsibleUserId,
						commandType: "api.application.create.v1",
						idempotencyKey: input.idempotencyKey,
						requestDigest: input.requestDigest,
						status: "completed",
						result: { schemaVersion: 1, applicationId: input.applicationId },
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
							and(
								eq(idempotencyRecords.scopeType, "user"),
								eq(idempotencyRecords.scopeId, input.responsibleUserId),
								eq(idempotencyRecords.actorId, input.responsibleUserId),
								eq(idempotencyRecords.commandType, "api.application.create.v1"),
								eq(idempotencyRecords.idempotencyKey, input.idempotencyKey),
							),
						)
						.limit(1)
						.for("update");
					if (!existing) throw new ApiIdentityError("dependency_unavailable");
					if (existing.requestDigest !== input.requestDigest)
						throw new ApiIdentityError("idempotency_conflict");
					const result = existing.result;
					if (
						existing.status !== "completed" ||
						!result ||
						Object.keys(result).length !== 2 ||
						result.schemaVersion !== 1 ||
						typeof result.applicationId !== "string"
					)
						throw new ApiIdentityError("dependency_unavailable");
					const [application] = await transaction
						.select({
							responsibleUserId: platformApplications.responsibleUserId,
						})
						.from(platformApplications)
						.where(eq(platformApplications.id, result.applicationId))
						.limit(1);
					if (application?.responsibleUserId !== input.responsibleUserId)
						throw new ApiIdentityError("dependency_unavailable");
					return result.applicationId;
				}
			}
			await transaction.insert(platformApplications).values({
				id: input.applicationId,
				name: input.name,
				responsibleUserId: input.responsibleUserId,
				authorizationRevision: input.authorizationRevision,
			});
			await writeApiIdentityAudit(transaction, {
				...input.audit,
				targetId: input.applicationId,
			});
			return input.applicationId;
		});
	}

	async getApplication(applicationId: string): Promise<{
		readonly id: string;
		readonly name: string;
		readonly responsibleUserId: string;
		readonly status: "active" | "disabled";
		readonly authorizationRevision: string;
	} | null> {
		const [row] = await this.#database
			.select()
			.from(platformApplications)
			.where(eq(platformApplications.id, applicationId))
			.limit(1);
		if (!row) return null;
		if (row.status !== "active" && row.status !== "disabled")
			throw new Error("Invalid application status");
		return {
			id: row.id,
			name: row.name,
			responsibleUserId: row.responsibleUserId,
			status: row.status,
			authorizationRevision: row.authorizationRevision,
		};
	}

	async listApplications(
		responsibleUserId?: string,
		page?: { readonly limit: number; readonly afterId?: string },
	) {
		const query = this.#database
			.select()
			.from(platformApplications)
			.where(
				and(
					responsibleUserId
						? eq(platformApplications.responsibleUserId, responsibleUserId)
						: undefined,
					page?.afterId ? gt(platformApplications.id, page.afterId) : undefined,
				),
			)
			.orderBy(platformApplications.id);
		const rows = page ? await query.limit(page.limit + 1) : await query;
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			responsibleUserId: row.responsibleUserId,
			status:
				row.status === "active" ? ("active" as const) : ("disabled" as const),
			authorizationRevision: row.authorizationRevision,
		}));
	}

	async issueCredential(input: {
		readonly actor: ApiIdentityActorV1;
		readonly credentialId?: string;
		readonly principal: ApiPrincipalV1;
		readonly credential: string;
		readonly scopes: readonly ApiCredentialScopeV1[];
		readonly expiresAt: Date | null;
		readonly recipient?: ApiPrincipalV1;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<{
		readonly credentialId: string;
		readonly metadata: ApiCredentialMetadataV1;
	}> {
		if (
			input.scopes.length === 0 ||
			new Set(input.scopes).size !== input.scopes.length ||
			input.scopes.some((scope) => !isApiCredentialScopeV1(scope))
		) {
			throw new TypeError("Credential scopes are invalid");
		}
		if (
			input.principal.kind === "application" &&
			(input.recipient === undefined || input.recipient.kind === "application")
		) {
			await writeApiIdentityAudit(this.#database, {
				...input.audit,
				recipient: input.recipient ?? input.principal,
				outcome: "rejected",
				targetId: input.principal.id,
			});
			throw new Error("Application credential transport is unavailable");
		}
		const id = input.credentialId ?? randomUUID();
		const row = await this.#database.transaction(async (transaction) => {
			if (
				input.principal.kind === "user" &&
				!isCurrentApiIdentityUserWriteAllowedV1({
					actor: input.actor,
					userId: input.principal.id,
					currentUser: await currentUserAtWrite(
						transaction,
						input.actor.userId,
						this.#resolveUser,
					),
				})
			)
				throw new ApiIdentityError("not_authorized");
			if (input.principal.kind === "application" && input.recipient) {
				const [application] = await transaction
					.select({
						status: platformApplications.status,
						authorizationRevision: platformApplications.authorizationRevision,
					})
					.from(platformApplications)
					.where(eq(platformApplications.id, input.principal.id))
					.limit(1)
					.for("update");
				if (application?.status !== "active")
					throw new Error("Application is not active");
				if (
					!isCurrentApiIdentityUserWriteAllowedV1({
						actor: input.actor,
						userId: input.recipient.id,
						currentUser: await currentUserAtWrite(
							transaction,
							input.recipient.id,
							this.#resolveUser,
						),
					})
				)
					throw new ApiIdentityError("resource_unavailable");
				const [delivery] = await transaction
					.select({
						applicationId: apiCredentialDeliveryGrants.applicationId,
						authorizationRevision:
							apiCredentialDeliveryGrants.authorizationRevision,
						pendingScopes: apiCredentialDeliveryGrants.pendingScopes,
						pendingExpiresAt: apiCredentialDeliveryGrants.pendingExpiresAt,
					})
					.from(apiCredentialDeliveryGrants)
					.where(
						and(
							eq(apiCredentialDeliveryGrants.applicationId, input.principal.id),
							eq(
								apiCredentialDeliveryGrants.principalType,
								input.recipient.kind,
							),
							eq(apiCredentialDeliveryGrants.principalId, input.recipient.id),
							isNull(apiCredentialDeliveryGrants.revokedAt),
						),
					)
					.limit(1)
					.for("update");
				if (
					!delivery ||
					delivery.authorizationRevision !==
						application.authorizationRevision ||
					!delivery.pendingScopes ||
					input.scopes.length !== delivery.pendingScopes.length ||
					input.scopes.some(
						(scope) => !delivery.pendingScopes?.includes(scope),
					) ||
					input.expiresAt?.getTime() !== delivery.pendingExpiresAt?.getTime()
				)
					throw new ApiIdentityError("resource_unavailable");
				await transaction
					.update(apiCredentialDeliveryGrants)
					.set({ pendingScopes: null, pendingExpiresAt: null })
					.where(
						and(
							eq(apiCredentialDeliveryGrants.applicationId, input.principal.id),
							eq(
								apiCredentialDeliveryGrants.principalType,
								input.recipient.kind,
							),
							eq(apiCredentialDeliveryGrants.principalId, input.recipient.id),
						),
					);
			}
			const [created] = await transaction
				.insert(platformApiCredentials)
				.values({
					id,
					principalType: principalType(input.principal),
					principalId: input.principal.id,
					credentialHash: hashApiCredentialV1(input.credential),
					scopes: [...input.scopes],
					recipientUserId:
						input.recipient?.kind === "user" ? input.recipient.id : null,
					expiresAt: input.expiresAt,
				})
				.returning();
			if (!created) throw new Error("Credential was not created");
			await writeApiIdentityAudit(transaction, {
				...input.audit,
				recipient: input.recipient,
				targetId: id,
			});
			return created;
		});
		return { credentialId: id, metadata: metadata(row) };
	}

	async resolveCredential(
		credential: string,
	): Promise<ApiCredentialMetadataV1 | null> {
		const [row] = await this.#database
			.select()
			.from(platformApiCredentials)
			.where(
				eq(
					platformApiCredentials.credentialHash,
					hashApiCredentialV1(credential),
				),
			)
			.limit(1);
		if (!row) return null;
		return metadata(row);
	}

	async resolveApplicationCredential(
		credential: string,
	): Promise<unknown | null> {
		const resolved = await this.resolveCredential(credential);
		if (resolved?.principal.kind !== "application") return null;
		const [application] = await this.#database
			.select({
				status: platformApplications.status,
				authorizationRevision: platformApplications.authorizationRevision,
				responsibleUserId: platformApplications.responsibleUserId,
			})
			.from(platformApplications)
			.where(eq(platformApplications.id, resolved.principal.id))
			.limit(1);
		if (!application) return null;
		const credentialActive =
			resolved.revokedAt === null &&
			(resolved.expiresAt === null ||
				resolved.expiresAt.getTime() > Date.now());
		const [credentialRow] = credentialActive
			? await this.#database
					.select({ recipientUserId: platformApiCredentials.recipientUserId })
					.from(platformApiCredentials)
					.where(eq(platformApiCredentials.id, resolved.credentialId))
					.limit(1)
			: [];
		const [delivery] = credentialRow?.recipientUserId
			? await this.#database
					.select({
						authorizationRevision:
							apiCredentialDeliveryGrants.authorizationRevision,
					})
					.from(apiCredentialDeliveryGrants)
					.where(
						and(
							eq(
								apiCredentialDeliveryGrants.applicationId,
								resolved.principal.id,
							),
							eq(apiCredentialDeliveryGrants.principalType, "user"),
							eq(
								apiCredentialDeliveryGrants.principalId,
								credentialRow.recipientUserId,
							),
							isNull(apiCredentialDeliveryGrants.revokedAt),
						),
					)
					.limit(1)
			: [];
		const recipient = credentialRow?.recipientUserId
			? await currentUserAtWrite(
					this.#database,
					credentialRow.recipientUserId,
					this.#resolveUser,
				)
			: null;
		return {
			schemaVersion: 1,
			principal: resolved.principal,
			accountStatus:
				credentialActive &&
				application.status === "active" &&
				delivery?.authorizationRevision === application.authorizationRevision &&
				recipient?.userId === credentialRow?.recipientUserId &&
				recipient?.accountStatus === "active"
					? "active"
					: "disabled",
			organizationIds: [],
			authorizationRevision: application.authorizationRevision,
			ownerId: application.responsibleUserId,
			credential: resolved,
		};
	}

	async resolveApiCredential(
		credential: string,
		resolveUser?: (userId: string) => Promise<unknown | null>,
	): Promise<unknown | null> {
		const resolved = await this.resolveCredential(credential);
		if (!resolved) return null;
		if (resolved.principal.kind === "application") {
			return this.resolveApplicationCredential(credential);
		}
		if (!resolveUser) return null;
		const currentUser = await currentUserAtWrite(
			this.#database,
			resolved.principal.id,
			resolveUser,
		);
		if (currentUser?.userId !== resolved.principal.id) return null;
		return {
			schemaVersion: 1,
			principal: resolved.principal,
			accountStatus: currentUser.accountStatus,
			organizationIds: currentUser.organizationIds,
			authorizationRevision: currentUser.authorizationRevision,
			ownerId: resolved.principal.id,
			credential: resolved,
		};
	}

	async listCredentials(input: {
		readonly principal?: ApiPrincipalV1;
		readonly applicationId?: string;
		readonly page?: { readonly limit: number; readonly afterId?: string };
	}): Promise<readonly ApiCredentialMetadataV1[]> {
		const principal =
			input.principal ??
			(input.applicationId
				? { kind: "application" as const, id: input.applicationId }
				: undefined);
		if (!principal) return [];
		const query = this.#database
			.select()
			.from(platformApiCredentials)
			.where(
				and(
					eq(platformApiCredentials.principalType, principal.kind),
					eq(platformApiCredentials.principalId, principal.id),
					input.page?.afterId
						? gt(platformApiCredentials.id, input.page.afterId)
						: undefined,
				),
			)
			.orderBy(platformApiCredentials.id);
		const rows = input.page
			? await query.limit(input.page.limit + 1)
			: await query;
		return rows.map(metadata);
	}

	async getCredentialMetadata(
		credentialId: string,
	): Promise<ApiCredentialMetadataV1 | null> {
		const [row] = await this.#database
			.select()
			.from(platformApiCredentials)
			.where(eq(platformApiCredentials.id, credentialId))
			.limit(1);
		return row ? metadata(row) : null;
	}

	async grantCredentialDelivery(input: {
		readonly actor: ApiIdentityActorV1;
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
		readonly scopes: readonly ApiCredentialScopeV1[];
		readonly expiresAt: Date | null;
		readonly authorizationRevision: string;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<void> {
		if (
			input.scopes.length === 0 ||
			new Set(input.scopes).size !== input.scopes.length ||
			input.scopes.some((scope) => !isApiCredentialScopeV1(scope))
		)
			throw new TypeError("Credential scopes are invalid");
		if (input.principal.kind === "application") {
			await writeApiIdentityAudit(this.#database, {
				...input.audit,
				recipient: input.principal,
				outcome: "rejected",
				targetId: input.applicationId,
			});
			throw new Error("Application credential transport is unavailable");
		}
		await this.#database.transaction(async (transaction) => {
			const [application] = await transaction
				.select({
					status: platformApplications.status,
					responsibleUserId: platformApplications.responsibleUserId,
					authorizationRevision: platformApplications.authorizationRevision,
				})
				.from(platformApplications)
				.where(eq(platformApplications.id, input.applicationId))
				.limit(1)
				.for("update");
			if (
				!isIndependentApiCredentialDeliveryRecipientV1(
					input.actor,
					input.principal,
				) ||
				application?.status !== "active" ||
				application?.authorizationRevision !== input.authorizationRevision ||
				!(await hasCurrentDeliveryManager(
					transaction,
					input.actor,
					application.responsibleUserId,
					this.#resolveUser,
				))
			)
				throw new Error("Application delivery authorization is stale");
			await transaction
				.update(platformApiCredentials)
				.set({ revokedAt: new Date() })
				.where(
					and(
						eq(platformApiCredentials.principalType, "application"),
						eq(platformApiCredentials.principalId, input.applicationId),
						eq(platformApiCredentials.recipientUserId, input.principal.id),
						isNull(platformApiCredentials.revokedAt),
					),
				);
			await transaction
				.insert(apiCredentialDeliveryGrants)
				.values({
					applicationId: input.applicationId,
					principalType: input.principal.kind,
					principalId: input.principal.id,
					authorizationRevision: input.authorizationRevision,
					pendingScopes: [...input.scopes],
					pendingExpiresAt: input.expiresAt,
				})
				.onConflictDoUpdate({
					target: [
						apiCredentialDeliveryGrants.applicationId,
						apiCredentialDeliveryGrants.principalType,
						apiCredentialDeliveryGrants.principalId,
					],
					set: {
						revokedAt: null,
						authorizationRevision: input.authorizationRevision,
						pendingScopes: [...input.scopes],
						pendingExpiresAt: input.expiresAt,
					},
				});
			await writeApiIdentityAudit(transaction, {
				...input.audit,
				recipient: input.principal,
				targetId: input.applicationId,
			});
		});
	}

	async revokeCredentialDelivery(input: {
		readonly actor: ApiIdentityActorV1;
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
		readonly revokedAt?: Date;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<boolean> {
		if (input.principal.kind === "application") {
			await writeApiIdentityAudit(this.#database, {
				...input.audit,
				recipient: input.principal,
				outcome: "rejected",
				targetId: input.applicationId,
			});
			throw new Error("Application credential transport is unavailable");
		}
		return this.#database.transaction(async (transaction) => {
			const [application] = await transaction
				.select({ responsibleUserId: platformApplications.responsibleUserId })
				.from(platformApplications)
				.where(eq(platformApplications.id, input.applicationId))
				.limit(1)
				.for("update");
			if (
				!application ||
				!(await hasCurrentDeliveryManager(
					transaction,
					input.actor,
					application.responsibleUserId,
					this.#resolveUser,
				))
			)
				return false;
			const revokedAt = input.revokedAt ?? new Date();
			const rows = await transaction
				.update(apiCredentialDeliveryGrants)
				.set({ revokedAt, pendingScopes: null, pendingExpiresAt: null })
				.where(
					and(
						eq(apiCredentialDeliveryGrants.applicationId, input.applicationId),
						eq(apiCredentialDeliveryGrants.principalType, input.principal.kind),
						eq(apiCredentialDeliveryGrants.principalId, input.principal.id),
						isNull(apiCredentialDeliveryGrants.revokedAt),
					),
				)
				.returning({
					applicationId: apiCredentialDeliveryGrants.applicationId,
				});
			if (rows.length !== 1) return false;
			await transaction
				.update(platformApiCredentials)
				.set({ revokedAt })
				.where(
					and(
						eq(platformApiCredentials.principalType, "application"),
						eq(platformApiCredentials.principalId, input.applicationId),
						eq(platformApiCredentials.recipientUserId, input.principal.id),
						isNull(platformApiCredentials.revokedAt),
					),
				);
			await writeApiIdentityAudit(transaction, {
				...input.audit,
				targetId: input.applicationId,
			});
			return true;
		});
	}

	async hasCredentialDelivery(input: {
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
	}): Promise<boolean> {
		const [row] = await this.#database
			.select({ applicationId: apiCredentialDeliveryGrants.applicationId })
			.from(apiCredentialDeliveryGrants)
			.innerJoin(
				platformApplications,
				eq(platformApplications.id, apiCredentialDeliveryGrants.applicationId),
			)
			.where(
				and(
					eq(apiCredentialDeliveryGrants.applicationId, input.applicationId),
					eq(apiCredentialDeliveryGrants.principalType, input.principal.kind),
					eq(apiCredentialDeliveryGrants.principalId, input.principal.id),
					isNull(apiCredentialDeliveryGrants.revokedAt),
					isNotNull(apiCredentialDeliveryGrants.pendingScopes),
					eq(platformApplications.status, "active"),
					eq(
						apiCredentialDeliveryGrants.authorizationRevision,
						platformApplications.authorizationRevision,
					),
				),
			)
			.limit(1);
		return row !== undefined;
	}

	async revokeCredential(input: {
		readonly actor: ApiIdentityActorV1;
		readonly principal: ApiPrincipalV1;
		readonly credentialId: string;
		readonly revokedAt: Date;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<boolean> {
		return this.#database.transaction(async (transaction) => {
			const currentUser = await currentUserAtWrite(
				transaction,
				input.actor.userId,
				this.#resolveUser,
			);
			if (
				!isCurrentApiIdentityBrowserActorV1({
					actor: input.actor,
					currentUser,
				})
			)
				return false;
			if (input.principal.kind === "application") {
				const [application] = await transaction
					.select({ responsibleUserId: platformApplications.responsibleUserId })
					.from(platformApplications)
					.where(eq(platformApplications.id, input.principal.id))
					.limit(1)
					.for("share");
				if (
					!application ||
					!isCurrentCredentialDeliveryManagerV1({
						actor: input.actor,
						currentUser,
						responsibleUserId: application.responsibleUserId,
					})
				)
					return false;
			} else if (
				!isCurrentApiIdentityUserWriteAllowedV1({
					actor: input.actor,
					currentUser,
					userId: input.principal.id,
				})
			)
				return false;
			const rows = await transaction
				.update(platformApiCredentials)
				.set({ revokedAt: input.revokedAt })
				.where(
					and(
						eq(platformApiCredentials.id, input.credentialId),
						eq(platformApiCredentials.principalType, input.principal.kind),
						eq(platformApiCredentials.principalId, input.principal.id),
						isNull(platformApiCredentials.revokedAt),
					),
				)
				.returning({ id: platformApiCredentials.id });
			if (rows.length !== 1) return false;
			await writeApiIdentityAudit(transaction, {
				...input.audit,
				targetId: input.credentialId,
			});
			return true;
		});
	}

	async grantAgent(input: {
		readonly actor: ApiIdentityActorV1;
		readonly agentId: string;
		readonly principal: ApiPrincipalV1;
		readonly grantType: "manage" | "use";
		readonly authorizationRevision: string;
		readonly audit?: ApiIdentityAuditInputV1;
	}): Promise<boolean> {
		return this.#database.transaction(async (transaction) => {
			const [agent] = await transaction
				.select({ authorizationRevision: agents.authorizationRevision })
				.from(agents)
				.where(eq(agents.id, input.agentId))
				.limit(1)
				.for("update");
			if (
				!agent ||
				!(await hasCurrentManageAuthority(
					transaction,
					input.actor,
					input.agentId,
					agent.authorizationRevision,
					this.#resolveUser,
				))
			)
				return false;
			if (input.principal.kind === "application") {
				const [recipient] = await transaction
					.select({ status: platformApplications.status })
					.from(platformApplications)
					.where(eq(platformApplications.id, input.principal.id))
					.limit(1)
					.for("share");
				if (recipient?.status !== "active") return false;
			}
			await transaction
				.update(agents)
				.set({ authorizationRevision: input.authorizationRevision })
				.where(eq(agents.id, input.agentId));
			if (agent.authorizationRevision !== null) {
				await transaction
					.update(agentPrincipalGrants)
					.set({ authorizationRevision: input.authorizationRevision })
					.where(
						and(
							eq(agentPrincipalGrants.agentId, input.agentId),
							eq(
								agentPrincipalGrants.authorizationRevision,
								agent.authorizationRevision,
							),
							isNull(agentPrincipalGrants.revokedAt),
						),
					);
			}
			await transaction
				.insert(agentPrincipalGrants)
				.values({
					agentId: input.agentId,
					principalType: principalType(input.principal),
					principalId: input.principal.id,
					grantType: input.grantType,
					authorizationRevision: input.authorizationRevision,
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
						authorizationRevision: input.authorizationRevision,
					},
				});
			if (input.audit) {
				await writeApiIdentityAudit(transaction, {
					...input.audit,
					recipient: input.principal,
					targetId: input.agentId,
				});
			}
			return true;
		});
	}

	async revokeAgentGrant(input: {
		readonly actor: ApiIdentityActorV1;
		readonly agentId: string;
		readonly principal: ApiPrincipalV1;
		readonly grantType: "manage" | "use";
		readonly revokedAt?: Date;
		readonly audit?: ApiIdentityAuditInputV1;
	}): Promise<boolean> {
		return this.#database.transaction(async (transaction) => {
			const [agent] = await transaction
				.select({ authorizationRevision: agents.authorizationRevision })
				.from(agents)
				.where(eq(agents.id, input.agentId))
				.limit(1)
				.for("update");
			if (
				!agent ||
				agent.authorizationRevision === null ||
				!(await hasCurrentManageAuthority(
					transaction,
					input.actor,
					input.agentId,
					agent.authorizationRevision,
					this.#resolveUser,
				))
			)
				return false;
			const rows = await transaction
				.update(agentPrincipalGrants)
				.set({ revokedAt: input.revokedAt ?? new Date() })
				.where(
					and(
						eq(agentPrincipalGrants.agentId, input.agentId),
						eq(
							agentPrincipalGrants.principalType,
							principalType(input.principal),
						),
						eq(agentPrincipalGrants.principalId, input.principal.id),
						eq(agentPrincipalGrants.grantType, input.grantType),
						eq(
							agentPrincipalGrants.authorizationRevision,
							agent.authorizationRevision,
						),
						isNull(agentPrincipalGrants.revokedAt),
					),
				)
				.returning({ agentId: agentPrincipalGrants.agentId });
			if (rows.length !== 1) return false;
			const authorizationRevision = randomUUID();
			await transaction
				.update(agents)
				.set({ authorizationRevision })
				.where(eq(agents.id, input.agentId));
			await transaction
				.update(agentPrincipalGrants)
				.set({ authorizationRevision })
				.where(
					and(
						eq(agentPrincipalGrants.agentId, input.agentId),
						eq(
							agentPrincipalGrants.authorizationRevision,
							agent.authorizationRevision,
						),
						isNull(agentPrincipalGrants.revokedAt),
					),
				);
			if (input.audit) {
				await writeApiIdentityAudit(transaction, {
					...input.audit,
					recipient: input.principal,
					targetId: input.agentId,
				});
			}
			return true;
		});
	}

	async hasAgentGrant(input: {
		readonly agentId: string;
		readonly principal: ApiPrincipalV1;
		readonly grantType: "manage" | "use";
	}): Promise<boolean> {
		const [row] = await this.#database
			.select({ agentId: agentPrincipalGrants.agentId })
			.from(agentPrincipalGrants)
			.innerJoin(agents, eq(agents.id, agentPrincipalGrants.agentId))
			.where(
				and(
					eq(agentPrincipalGrants.agentId, input.agentId),
					eq(
						agentPrincipalGrants.principalType,
						principalType(input.principal),
					),
					eq(agentPrincipalGrants.principalId, input.principal.id),
					eq(agentPrincipalGrants.grantType, input.grantType),
					eq(
						agentPrincipalGrants.authorizationRevision,
						agents.authorizationRevision,
					),
					isNull(agentPrincipalGrants.revokedAt),
				),
			)
			.limit(1);
		return row !== undefined;
	}
}
