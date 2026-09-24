import { randomUUID } from "node:crypto";

import {
	type ApiCredentialMetadataV1,
	type ApiCredentialScopeV1,
	type ApiIdentityAuditInputV1,
	type ApiPrincipalV1,
	hashApiCredentialV1,
	isApiCredentialScopeV1,
	parseCurrentTaskUserV1,
} from "@agent-infra/platform-core";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
	agentPrincipalGrants,
	apiCredentialDeliveryGrants,
	auditEvents,
	platformApiCredentials,
	platformApplications,
} from "./schema.js";

export interface PostgresApiIdentityStoreOptionsV1 {
	readonly databaseUrl: string;
}

export type {
	ApiIdentityAuditActionV1,
	ApiIdentityAuditInputV1,
} from "@agent-infra/platform-core";

type ApiIdentityDatabase = ReturnType<typeof drizzle>;
type ApiIdentityAuditDatabase = Pick<ApiIdentityDatabase, "insert">;

type ApiIdentityAuditTargetV1 = ApiIdentityAuditInputV1 & {
	readonly targetId: string;
};

async function writeApiIdentityAudit(
	database: ApiIdentityAuditDatabase,
	input: ApiIdentityAuditTargetV1,
): Promise<void> {
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
		details: {
			recipient: input.recipient ?? null,
			grantType: input.grantType ?? null,
		},
		occurredAt: new Date(),
	});
}

function principalType(principal: ApiPrincipalV1): "user" | "application" {
	return principal.kind;
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

	constructor(options: PostgresApiIdentityStoreOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 4 });
		this.#database = drizzle(this.#client);
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
		readonly applicationId: string;
		readonly name: string;
		readonly responsibleUserId: string;
		readonly authorizationRevision: string;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<void> {
		await this.#database.transaction(async (transaction) => {
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

	async listApplications(responsibleUserId: string) {
		const rows = await this.#database
			.select()
			.from(platformApplications)
			.where(eq(platformApplications.responsibleUserId, responsibleUserId))
			.orderBy(platformApplications.id);
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
		const id = input.credentialId ?? randomUUID();
		const row = await this.#database.transaction(async (transaction) => {
			if (input.principal.kind === "application" && input.recipient) {
				const [application] = await transaction
					.select({
						status: platformApplications.status,
						authorizationRevision: platformApplications.authorizationRevision,
					})
					.from(platformApplications)
					.where(eq(platformApplications.id, input.principal.id))
					.limit(1);
				if (application?.status !== "active")
					throw new Error("Application is not active");
				const [delivery] = await transaction
					.select({
						applicationId: apiCredentialDeliveryGrants.applicationId,
						authorizationRevision:
							apiCredentialDeliveryGrants.authorizationRevision,
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
					.limit(1);
				if (
					!delivery ||
					delivery.authorizationRevision !== application.authorizationRevision
				)
					throw new Error("Credential delivery is not authorized");
			}
			const [created] = await transaction
				.insert(platformApiCredentials)
				.values({
					id,
					principalType: principalType(input.principal),
					principalId: input.principal.id,
					credentialHash: hashApiCredentialV1(input.credential),
					scopes: [...input.scopes],
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
		const result = metadata(row);
		if (
			result.revokedAt ||
			(result.expiresAt && result.expiresAt.getTime() <= Date.now())
		)
			return null;
		return result;
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
		return {
			schemaVersion: 1,
			principal: resolved.principal,
			accountStatus: application.status === "active" ? "active" : "disabled",
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
		const user = await resolveUser(resolved.principal.id);
		if (user === null) return null;
		const currentUser = parseCurrentTaskUserV1(user);
		if (currentUser.userId !== resolved.principal.id) return null;
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
	}): Promise<readonly ApiCredentialMetadataV1[]> {
		const rows = input.principal
			? await this.#database
					.select()
					.from(platformApiCredentials)
					.where(
						and(
							eq(platformApiCredentials.principalType, input.principal.kind),
							eq(platformApiCredentials.principalId, input.principal.id),
						),
					)
					.orderBy(platformApiCredentials.id)
			: input.applicationId
				? await this.#database
						.select()
						.from(platformApiCredentials)
						.where(
							and(
								eq(platformApiCredentials.principalType, "application"),
								eq(platformApiCredentials.principalId, input.applicationId),
							),
						)
						.orderBy(platformApiCredentials.id)
				: [];
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
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
		readonly authorizationRevision: string;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<void> {
		await this.#database.transaction(async (transaction) => {
			await transaction
				.insert(apiCredentialDeliveryGrants)
				.values({
					applicationId: input.applicationId,
					principalType: input.principal.kind,
					principalId: input.principal.id,
					authorizationRevision: input.authorizationRevision,
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
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
		readonly revokedAt?: Date;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<boolean> {
		return this.#database.transaction(async (transaction) => {
			const rows = await transaction
				.update(apiCredentialDeliveryGrants)
				.set({ revokedAt: input.revokedAt ?? new Date() })
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

	async revokeCredential(
		credentialId: string,
		revokedAt = new Date(),
		audit?: ApiIdentityAuditInputV1,
	): Promise<boolean> {
		return this.#database.transaction(async (transaction) => {
			const rows = await transaction
				.update(platformApiCredentials)
				.set({ revokedAt })
				.where(
					and(
						eq(platformApiCredentials.id, credentialId),
						isNull(platformApiCredentials.revokedAt),
					),
				)
				.returning({ id: platformApiCredentials.id });
			if (rows.length !== 1) return false;
			if (audit) {
				await writeApiIdentityAudit(transaction, {
					...audit,
					targetId: credentialId,
				});
			}
			return true;
		});
	}

	async grantAgent(input: {
		readonly agentId: string;
		readonly principal: ApiPrincipalV1;
		readonly grantType: "manage" | "use";
		readonly authorizationRevision: string;
		readonly audit?: ApiIdentityAuditInputV1;
	}): Promise<void> {
		await this.#database.transaction(async (transaction) => {
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
		});
	}

	async revokeAgentGrant(input: {
		readonly agentId: string;
		readonly principal: ApiPrincipalV1;
		readonly grantType: "manage" | "use";
		readonly revokedAt?: Date;
		readonly audit?: ApiIdentityAuditInputV1;
	}): Promise<boolean> {
		return this.#database.transaction(async (transaction) => {
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
						isNull(agentPrincipalGrants.revokedAt),
					),
				)
				.returning({ agentId: agentPrincipalGrants.agentId });
			if (rows.length !== 1) return false;
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
			.where(
				and(
					eq(agentPrincipalGrants.agentId, input.agentId),
					eq(
						agentPrincipalGrants.principalType,
						principalType(input.principal),
					),
					eq(agentPrincipalGrants.principalId, input.principal.id),
					eq(agentPrincipalGrants.grantType, input.grantType),
					isNull(agentPrincipalGrants.revokedAt),
				),
			)
			.limit(1);
		return row !== undefined;
	}
}
