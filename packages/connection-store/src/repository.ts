import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	randomUUID,
} from "node:crypto";
import {
	type ActionDefinition,
	type ActionName,
	authorizationSnapshotMatches,
	type CallStatus,
	ConnectionError,
	type ConnectionOverview,
	type ConnectionRepository,
	type CurrentConsumerAuthorizationPreview,
	canonicalHash,
	createAuthorizationSnapshot,
	decideReconnectAuthorization,
	type InvocationContext,
	normalizeSharedScopeDisplayName,
	type OAuthTransaction,
	type ReconciliationJob,
	type StoredCall,
} from "@agent-infra/connection-core";
import postgres from "postgres";

const githubProvider = "github";

export type PublishedProviderCatalog = {
	actions: readonly ActionDefinition[];
	authProfile: Readonly<Record<string, unknown>>;
	deploymentProfile: Readonly<Record<string, unknown>>;
	executorDigest: string;
	provider: string;
	providerReleaseId: string;
	sourceCommit: string;
};

type InvocationRow = {
	connection_id: string;
	consumer_id: string;
	credential_version_id: string;
	grant_id: string;
	instance_id: string;
	principal_id: string;
	provider_id: string;
	provider_release_id: string;
	actor_key: string | null;
};

type StoredCallRow = InvocationRow & {
	action_name: ActionName;
	created_at: Date;
	id: string;
	idempotency_key: string | null;
	request_hash: string;
	result: unknown;
	status: CallStatus;
};

type AuthorizationRootSnapshot = {
	currentGrantId: string | null;
	fence: string;
	id: string;
	providerId: string;
	status: string;
};

type AuthorizationTarget = {
	actions: ActionDefinition[];
	catalogRevisionDigest: string;
	connection: {
		displayName: string;
		externalAccount: string;
		id: string;
	};
	consumer: { id: string; name: string };
	consumerDeclarationDigest: string;
	consumerDeclarationId: string;
	consumerDeclarationRevision: string;
	consumerRevision: string;
	connectionExecutionFence: string;
	connectionRevision: string;
	credentialRevision: string;
	credentialScopeDigest: string;
	credentialScopes: string[];
	credentialVersionId: string;
	externalAccountFingerprint: string;
	providerId: string;
	providerReleaseId: string;
	providerReleaseRevision: string;
	sharedEligibilityPathHash: string | null;
};

type ConnectionEligibility = {
	ownerType: "PERSONAL" | "SHARED";
	providerId: string;
	sharedEligibilityPathHash: string | null;
};

function hash(value: string) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function forbidden(): never {
	throw new ConnectionError(
		"FORBIDDEN",
		"Connection authorization is not active",
	);
}

function invalidAuthorizationPreview(message: string): never {
	throw new ConnectionError("INVALID_REQUEST", message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function actionDefinition(row: {
	description: string;
	effect: "READ" | "WRITE";
	id: string;
	input_schema: unknown;
	name: ActionName;
	required_scopes: unknown;
}): ActionDefinition {
	const schema = asRecord(row.input_schema);
	const required = schema?.required;
	if (
		!Array.isArray(required) ||
		!required.every((item) => typeof item === "string")
	) {
		throw new ConnectionError(
			"PROVIDER_FAILED",
			"Published action schema is invalid",
		);
	}
	const requiredScopes = Array.isArray(row.required_scopes)
		? row.required_scopes.filter(
				(scope): scope is string => typeof scope === "string",
			)
		: [];
	return {
		description: row.description,
		effect: row.effect,
		id: row.id,
		inputSchema: { ...(schema ?? {}), required },
		name: row.name,
		requiredScopes: [...new Set(requiredScopes)].sort(),
	};
}

function invocation(row: InvocationRow): InvocationContext {
	return {
		...(row.actor_key ? { actorKey: row.actor_key } : {}),
		connectionId: row.connection_id,
		consumerId: row.consumer_id,
		credentialVersionId: row.credential_version_id,
		grantId: row.grant_id,
		instanceId: row.instance_id,
		principalId: row.principal_id,
		providerId: row.provider_id,
		providerReleaseId: row.provider_release_id,
	};
}

function storedCall(row: StoredCallRow): StoredCall {
	return {
		action: row.action_name,
		argsHash: row.request_hash,
		callId: row.id,
		connectionId: row.connection_id,
		createdAt: row.created_at.toISOString(),
		grantId: row.grant_id,
		idempotencyKey: row.idempotency_key ?? undefined,
		invocation: invocation(row),
		result: asRecord(row.result),
		status: row.status,
	};
}

class CredentialProtector {
	private readonly key: Buffer;

	constructor(key: Uint8Array) {
		if (key.byteLength !== 32) {
			throw new Error(
				"Connection credential key must contain exactly 32 bytes",
			);
		}
		this.key = Buffer.from(key);
	}

	encrypt(value: string, associatedData: string) {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(Buffer.from(associatedData, "utf8"));
		const plaintext = Buffer.from(value, "utf8");
		const ciphertext = Buffer.concat([
			cipher.update(plaintext),
			cipher.final(),
		]);
		plaintext.fill(0);
		return {
			ciphertext: ciphertext.toString("base64url"),
			nonce: nonce.toString("base64url"),
			tag: cipher.getAuthTag().toString("base64url"),
		};
	}

	decrypt(
		value: { ciphertext: string; nonce: string; tag: string },
		associatedData: string,
	) {
		try {
			const decipher = createDecipheriv(
				"aes-256-gcm",
				this.key,
				Buffer.from(value.nonce, "base64url"),
			);
			decipher.setAAD(Buffer.from(associatedData, "utf8"));
			decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
			const plaintext = Buffer.concat([
				decipher.update(Buffer.from(value.ciphertext, "base64url")),
				decipher.final(),
			]);
			const result = plaintext.toString("utf8");
			plaintext.fill(0);
			return result;
		} catch {
			throw new ConnectionError(
				"PROVIDER_FAILED",
				"Credential cannot be decrypted",
			);
		}
	}
}

export class PostgresConnectionRepository implements ConnectionRepository {
	private readonly authorizationPreviewTtlMs: number;
	private readonly protector: CredentialProtector;
	private readonly publishedProviderReleaseIds = new Map<string, string>();
	private readonly sql;

	constructor(
		databaseUrl: string,
		credentialKey: Uint8Array,
		options: { authorizationPreviewTtlMs?: number } = {},
	) {
		this.sql = postgres(databaseUrl, { max: 10 });
		this.protector = new CredentialProtector(credentialKey);
		this.authorizationPreviewTtlMs =
			options.authorizationPreviewTtlMs ?? 5 * 60_000;
		if (
			!Number.isSafeInteger(this.authorizationPreviewTtlMs) ||
			this.authorizationPreviewTtlMs < 0
		) {
			throw new Error(
				"Authorization preview TTL must be a non-negative integer",
			);
		}
	}

	async close() {
		await this.sql.end();
	}

	async publishProviderCatalog(catalog: PublishedProviderCatalog) {
		const catalogChecksum = canonicalHash(catalog.actions);
		if (!/^sha256:[a-f0-9]{64}$/.test(catalog.executorDigest)) {
			throw new Error("Provider executor digest is invalid");
		}
		await this.sql.begin(async (sql) => {
			await sql`
				INSERT INTO connection_provider_releases (
					id, provider, source_commit, deployment_profile, auth_profile,
					executor_digest, catalog_checksum, status
				)
				VALUES (
					${catalog.providerReleaseId}, ${catalog.provider}, ${catalog.sourceCommit},
					${sql.json(catalog.deploymentProfile as postgres.JSONValue)},
					${sql.json(catalog.authProfile as postgres.JSONValue)},
					${catalog.executorDigest}, ${catalogChecksum}, 'PUBLISHED'
				)
				ON CONFLICT (id) DO NOTHING
			`;
			const [release] = await sql<
				{
					auth_profile: unknown;
					catalog_checksum: string;
					deployment_profile: unknown;
					executor_digest: string;
					provider: string;
					source_commit: string;
					status: string;
				}[]
			>`
				SELECT provider, source_commit, deployment_profile, auth_profile,
					executor_digest, catalog_checksum, status
				FROM connection_provider_releases WHERE id = ${catalog.providerReleaseId}
			`;
			if (
				release?.provider !== catalog.provider ||
				release.source_commit !== catalog.sourceCommit ||
				canonicalHash(release.deployment_profile) !==
					canonicalHash(catalog.deploymentProfile) ||
				canonicalHash(release.auth_profile) !==
					canonicalHash(catalog.authProfile) ||
				release.executor_digest !== catalog.executorDigest ||
				release.catalog_checksum !== catalogChecksum ||
				release.status !== "PUBLISHED"
			) {
				throw new Error("Pinned ProviderRelease does not match the catalog");
			}
			for (const action of catalog.actions) {
				await sql`
						INSERT INTO connection_action_versions (
							id, provider_release_id, name, description, effect, input_schema,
							required_scopes, status
						)
						VALUES (
							${action.id}, ${catalog.providerReleaseId}, ${action.name},
							${action.description}, ${action.effect},
							${sql.json(action.inputSchema as postgres.JSONValue)},
							${sql.json([...action.requiredScopes])},
							'PUBLISHED'
						)
						ON CONFLICT (id) DO NOTHING
					`;
				const [stored] = await sql<
					{
						description: string;
						effect: string;
						input_schema: unknown;
						name: string;
						provider_release_id: string;
						required_scopes: unknown;
						status: string;
					}[]
				>`
							SELECT provider_release_id, name, description, effect, input_schema,
								required_scopes, status
					FROM connection_action_versions WHERE id = ${action.id}
				`;
				if (
					stored?.provider_release_id !== catalog.providerReleaseId ||
					stored.name !== action.name ||
					stored.description !== action.description ||
					stored.effect !== action.effect ||
					canonicalHash(stored.input_schema) !==
						canonicalHash(action.inputSchema) ||
					canonicalHash(stored.required_scopes) !==
						canonicalHash([...action.requiredScopes]) ||
					stored.status !== "PUBLISHED"
				) {
					throw new Error(
						`Published ActionVersion does not match ${action.id}`,
					);
				}
			}
		});
		this.publishedProviderReleaseIds.set(
			catalog.provider,
			catalog.providerReleaseId,
		);
	}

	/** @deprecated Use publishProviderCatalog. */
	publishGithubCatalog(catalog: PublishedProviderCatalog) {
		return this.publishProviderCatalog(catalog);
	}

	async publishConsumerDeclaration(input: {
		actionVersionIds: readonly string[];
		consumer: { id: string; name: string };
		providerReleaseId: string;
	}) {
		const actionVersionIds = [...new Set(input.actionVersionIds)].sort();
		if (
			!input.consumer.id ||
			!input.consumer.name ||
			actionVersionIds.length === 0
		) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"Consumer declaration is incomplete",
			);
		}
		return this.sql.begin(async (sql) => {
			const declaredActions = await sql<{ id: string; provider: string }[]>`
				SELECT action.id, release.provider
				FROM connection_action_versions action
				JOIN connection_provider_releases release
					ON release.id = action.provider_release_id
					AND release.status = 'PUBLISHED'
					AND release.executor_digest <> 'legacy:unrecorded'
					AND release.catalog_checksum <> 'legacy:unrecorded'
				WHERE action.provider_release_id = ${input.providerReleaseId}
					AND action.status = 'PUBLISHED'
				ORDER BY action.id
				FOR SHARE OF action, release
			`;
			const providerId = declaredActions[0]?.provider;
			if (!providerId) {
				throw new ConnectionError(
					"INVALID_REQUEST",
					"Consumer declaration references an unavailable ProviderRelease",
				);
			}
			const publishedIds = new Set(declaredActions.map((action) => action.id));
			if (actionVersionIds.some((actionId) => !publishedIds.has(actionId))) {
				throw new ConnectionError(
					"INVALID_REQUEST",
					"Consumer declaration contains an unpublished ActionVersion",
				);
			}
			await sql`
				INSERT INTO connection_consumers (id, display_name, status)
				VALUES (${input.consumer.id}, ${input.consumer.name}, 'ACTIVE')
				ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
			`;
			const [consumer] = await sql<
				{
					revision: string;
					status: string;
				}[]
			>`
				SELECT revision::text, status
				FROM connection_consumers
				WHERE id = ${input.consumer.id}
				FOR UPDATE
			`;
			if (consumer?.status !== "ACTIVE") forbidden();
			const declarationDigest = canonicalHash({
				actionVersionIds,
				providerId,
				providerReleaseId: input.providerReleaseId,
			});
			const [current] = await sql<{ digest: string; id: string }[]>`
				SELECT id, digest FROM connection_consumer_action_declarations
				WHERE consumer_id = ${input.consumer.id}
					AND provider_id = ${providerId}
					AND status = 'PUBLISHED'
				FOR UPDATE
			`;
			if (current?.digest === declarationDigest) {
				return { declarationId: current.id };
			}
			const declarationId = `declaration-${randomUUID()}`;
			const nextRevision = (BigInt(consumer.revision) + 1n).toString();
			if (current) {
				await sql`
					UPDATE connection_consumer_action_declarations
					SET status = 'SUPERSEDED'
					WHERE id = ${current.id}
						AND consumer_id = ${input.consumer.id}
						AND provider_id = ${providerId}
						AND status = 'PUBLISHED'
				`;
			}
			await sql`
				INSERT INTO connection_consumer_action_declarations (
					id, consumer_id, provider_id, provider_release_id, revision, digest, status
				)
				VALUES (
					${declarationId}, ${input.consumer.id}, ${providerId},
					${input.providerReleaseId},
					${nextRevision}, ${declarationDigest}, 'PUBLISHED'
				)
			`;
			for (const actionVersionId of actionVersionIds) {
				await sql`
					INSERT INTO connection_consumer_declared_actions (
						declaration_id, action_version_id
					)
					VALUES (${declarationId}, ${actionVersionId})
				`;
			}
			await sql`
				UPDATE connection_consumers
				SET revision = ${nextRevision},
					current_declaration_id = CASE
						WHEN ${providerId} = 'github' THEN ${declarationId}
						ELSE current_declaration_id
					END
				WHERE id = ${input.consumer.id} AND revision = ${consumer.revision}
			`;
			return { declarationId };
		});
	}

	async ensurePrincipal(input: { principalId: string }) {
		const [principal] = await this.sql<{ id: string }[]>`
			SELECT id FROM connection_principals
			WHERE id = ${input.principalId} AND status = 'ACTIVE'
		`;
		if (!principal) forbidden();
	}

	async isConnectionAdministrator(principalId: string) {
		const [administrator] = await this.sql<{ allowed: boolean }[]>`
			SELECT true AS allowed
			FROM connection_principal_roles role_binding
			JOIN connection_principals principal
				ON principal.id = role_binding.principal_id
			WHERE role_binding.principal_id = ${principalId}
				AND role_binding.role = 'CONNECTION_ADMIN'
				AND role_binding.status = 'ACTIVE'
				AND principal.status = 'ACTIVE'
		`;
		return administrator?.allowed === true;
	}

	async authorizeConnectionAdministration(principalId: string) {
		if (await this.isConnectionAdministrator(principalId)) return true;
		await this.recordConnectionAdministratorDenial(principalId);
		return false;
	}

	private async recordConnectionAdministratorDenial(principalId: string) {
		await this.sql`
			INSERT INTO connection_audit_records (principal_id, event, detail)
			SELECT id, 'CONNECTION_ADMIN_DENIED', '{}'::jsonb
			FROM connection_principals
			WHERE id = ${principalId} AND status = 'ACTIVE'
		`;
	}

	private async requireConnectionAdministrator(
		sql: postgres.TransactionSql,
		principalId: string,
	) {
		const [administrator] = await sql<{ allowed: boolean }[]>`
			SELECT true AS allowed
			FROM connection_principal_roles role_binding
			JOIN connection_principals principal
				ON principal.id = role_binding.principal_id
			WHERE role_binding.principal_id = ${principalId}
				AND role_binding.role = 'CONNECTION_ADMIN'
				AND role_binding.status = 'ACTIVE'
				AND principal.status = 'ACTIVE'
			FOR SHARE OF role_binding, principal
		`;
		if (!administrator?.allowed) {
			await this.recordConnectionAdministratorDenial(principalId);
			forbidden();
		}
	}

	async bootstrapConnectionAdministrator(input: {
		identityIssuer: string;
		identitySubjectHash: string;
	}) {
		return this.sql.begin(async (sql) => {
			await sql`LOCK TABLE connection_principal_roles IN SHARE ROW EXCLUSIVE MODE`;
			const [identity] = await sql<
				{
					display_name: string;
					email: string | null;
					principal_id: string;
				}[]
			>`
				SELECT identity.principal_id, principal.display_name, principal.email
				FROM connection_principal_identities identity
				JOIN connection_principals principal ON principal.id = identity.principal_id
				WHERE identity.identity_issuer = ${input.identityIssuer}
					AND identity.identity_subject_hash = ${input.identitySubjectHash}
					AND identity.status = 'ACTIVE'
					AND principal.status = 'ACTIVE'
				FOR UPDATE OF identity, principal
			`;
			if (!identity) {
				throw new ConnectionError(
					"INVALID_REQUEST",
					"LDAP identity has not authenticated with Connection",
				);
			}
			const [existing] = await sql<{ principal_id: string; status: string }[]>`
				SELECT principal_id, status FROM connection_principal_roles
				WHERE role = 'CONNECTION_ADMIN'
				ORDER BY principal_id
				LIMIT 1
				FOR UPDATE
			`;
			if (existing?.principal_id === identity.principal_id) {
				if (existing.status !== "ACTIVE") {
					throw new ConnectionError(
						"FORBIDDEN",
						"Administrator bootstrap is no longer available",
					);
				}
				return {
					displayName: identity.display_name,
					email: identity.email,
					principalId: identity.principal_id,
				};
			}
			if (existing) {
				throw new ConnectionError(
					"FORBIDDEN",
					"Administrator bootstrap is no longer available",
				);
			}
			await sql`
				INSERT INTO connection_principal_roles (
					principal_id, role, status, grant_source
				)
				VALUES (
					${identity.principal_id}, 'CONNECTION_ADMIN', 'ACTIVE', 'BOOTSTRAP'
				)
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${identity.principal_id},
					'CONNECTION_ADMIN_BOOTSTRAPPED',
					${sql.json({ grantSource: "BOOTSTRAP" })}
				)
			`;
			return {
				displayName: identity.display_name,
				email: identity.email,
				principalId: identity.principal_id,
			};
		});
	}

	async listConnectionAdministrators(principalId: string) {
		return this.sql.begin(async (sql) => {
			await this.requireConnectionAdministrator(sql, principalId);
			const administrators = await sql<
				{ display_name: string; email: string | null; principal_id: string }[]
			>`
				SELECT principal.id AS principal_id, principal.display_name, principal.email
				FROM connection_principal_roles role_binding
				JOIN connection_principals principal
					ON principal.id = role_binding.principal_id
				WHERE role_binding.role = 'CONNECTION_ADMIN'
					AND role_binding.status = 'ACTIVE'
					AND principal.status = 'ACTIVE'
				ORDER BY principal.display_name, principal.id
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (${principalId}, 'CONNECTION_ADMINISTRATORS_QUERIED', '{}'::jsonb)
			`;
			return administrators.map((administrator) => ({
				displayName: administrator.display_name,
				email: administrator.email,
				principalId: administrator.principal_id,
			}));
		});
	}

	async listConnectionAdministratorCandidates(principalId: string) {
		return this.sql.begin(async (sql) => {
			await this.requireConnectionAdministrator(sql, principalId);
			const principals = await sql<
				{
					display_name: string;
					email: string | null;
					is_administrator: boolean;
					principal_id: string;
				}[]
			>`
				SELECT principal.id AS principal_id, principal.display_name,
					principal.email, role_binding.principal_id IS NOT NULL AS is_administrator
				FROM connection_principals principal
				LEFT JOIN connection_principal_roles role_binding
					ON role_binding.principal_id = principal.id
					AND role_binding.role = 'CONNECTION_ADMIN'
					AND role_binding.status = 'ACTIVE'
				WHERE principal.status = 'ACTIVE'
				ORDER BY principal.display_name, principal.id
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (${principalId}, 'CONNECTION_ADMIN_CANDIDATES_QUERIED', '{}'::jsonb)
			`;
			return principals.map((principal) => ({
				displayName: principal.display_name,
				email: principal.email,
				isAdministrator: principal.is_administrator,
				principalId: principal.principal_id,
			}));
		});
	}

	async grantConnectionAdministrator(input: {
		actorPrincipalId: string;
		targetPrincipalId: string;
	}) {
		await this.sql.begin(async (sql) => {
			await sql`LOCK TABLE connection_principal_roles IN SHARE ROW EXCLUSIVE MODE`;
			await this.requireConnectionAdministrator(sql, input.actorPrincipalId);
			const [target] = await sql<{ id: string }[]>`
				SELECT id FROM connection_principals
				WHERE id = ${input.targetPrincipalId} AND status = 'ACTIVE'
				FOR SHARE
			`;
			if (!target) forbidden();
			const [existing] = await sql<{ status: string }[]>`
				SELECT status FROM connection_principal_roles
				WHERE principal_id = ${input.targetPrincipalId}
					AND role = 'CONNECTION_ADMIN'
				FOR UPDATE
			`;
			if (existing?.status === "ACTIVE") return;
			await sql`
				INSERT INTO connection_principal_roles (
					principal_id, role, status, grant_source,
					granted_by_principal_id
				)
				VALUES (
					${input.targetPrincipalId}, 'CONNECTION_ADMIN', 'ACTIVE', 'ADMIN',
					${input.actorPrincipalId}
				)
				ON CONFLICT (principal_id, role) DO UPDATE SET
					status = 'ACTIVE',
					grant_source = 'ADMIN',
					granted_by_principal_id = EXCLUDED.granted_by_principal_id,
					revoked_by_principal_id = NULL,
					granted_at = now(),
					revoked_at = NULL,
					revision = connection_principal_roles.revision + 1
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.actorPrincipalId},
					'CONNECTION_ADMIN_GRANTED',
					${sql.json({ targetPrincipalId: input.targetPrincipalId })}
				)
			`;
		});
	}

	async revokeConnectionAdministrator(input: {
		actorPrincipalId: string;
		targetPrincipalId: string;
	}) {
		await this.sql.begin(async (sql) => {
			await sql`LOCK TABLE connection_principal_roles IN SHARE ROW EXCLUSIVE MODE`;
			await this.requireConnectionAdministrator(sql, input.actorPrincipalId);
			const [target] = await sql<{ status: string }[]>`
				SELECT status FROM connection_principal_roles
				WHERE principal_id = ${input.targetPrincipalId}
					AND role = 'CONNECTION_ADMIN'
				FOR UPDATE
			`;
			if (target?.status !== "ACTIVE") return;
			const [active] = await sql<{ count: string }[]>`
				SELECT count(*)::text AS count
				FROM connection_principal_roles role_binding
				JOIN connection_principals principal
					ON principal.id = role_binding.principal_id
				WHERE role_binding.role = 'CONNECTION_ADMIN'
					AND role_binding.status = 'ACTIVE'
					AND principal.status = 'ACTIVE'
			`;
			if (Number(active?.count ?? 0) <= 1) {
				throw new ConnectionError(
					"INVALID_REQUEST",
					"At least one Connection administrator is required",
				);
			}
			await sql`
				UPDATE connection_principal_roles SET
					status = 'REVOKED',
					revoked_by_principal_id = ${input.actorPrincipalId},
					revoked_at = now(),
					revision = revision + 1
				WHERE principal_id = ${input.targetPrincipalId}
					AND role = 'CONNECTION_ADMIN'
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.actorPrincipalId},
					'CONNECTION_ADMIN_REVOKED',
					${sql.json({ targetPrincipalId: input.targetPrincipalId })}
				)
			`;
		});
	}

	async createSharedScope(input: {
		actorPrincipalId: string;
		displayName: string;
	}) {
		const displayName = normalizeSharedScopeDisplayName(input.displayName);
		return this.sql.begin(async (sql) => {
			await this.requireConnectionAdministrator(sql, input.actorPrincipalId);
			const sharedScopeId = `shared-scope-${randomUUID()}`;
			await sql`
				INSERT INTO connection_shared_scopes (
					id, display_name, state, created_by_principal_id
				)
				VALUES (
					${sharedScopeId}, ${displayName}, 'ACTIVE', ${input.actorPrincipalId}
				)
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.actorPrincipalId}, 'SHARED_SCOPE_CREATED',
					${sql.json({ sharedScopeId })}
				)
			`;
			return { sharedScopeId };
		});
	}

	async grantSharedScopePrincipal(input: {
		actorPrincipalId: string;
		sharedScopeId: string;
		targetPrincipalId: string;
	}) {
		await this.sql.begin(async (sql) => {
			await this.requireConnectionAdministrator(sql, input.actorPrincipalId);
			const [scope] = await sql<{ id: string }[]>`
				SELECT id FROM connection_shared_scopes
				WHERE id = ${input.sharedScopeId} AND state = 'ACTIVE'
				FOR UPDATE
			`;
			const [target] = await sql<{ id: string }[]>`
				SELECT id FROM connection_principals
				WHERE id = ${input.targetPrincipalId} AND status = 'ACTIVE'
				FOR SHARE
			`;
			if (!scope || !target) forbidden();
			const [existing] = await sql<{ status: string }[]>`
				SELECT status FROM connection_shared_scope_principals
				WHERE shared_scope_id = ${input.sharedScopeId}
					AND principal_id = ${input.targetPrincipalId}
				FOR UPDATE
			`;
			if (existing?.status === "ACTIVE") return;
			await sql`
				INSERT INTO connection_shared_scope_principals (
					shared_scope_id, principal_id, status, granted_by_principal_id
				)
				VALUES (
					${input.sharedScopeId}, ${input.targetPrincipalId}, 'ACTIVE',
					${input.actorPrincipalId}
				)
				ON CONFLICT (shared_scope_id, principal_id) DO UPDATE SET
					status = 'ACTIVE',
					granted_by_principal_id = EXCLUDED.granted_by_principal_id,
					revoked_by_principal_id = NULL,
					granted_at = now(),
					revoked_at = NULL,
					revision = connection_shared_scope_principals.revision + 1
			`;
			await sql`
				UPDATE connection_shared_scopes
				SET revision = revision + 1, updated_at = now()
				WHERE id = ${input.sharedScopeId}
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.actorPrincipalId}, 'SHARED_SCOPE_PRINCIPAL_GRANTED',
					${sql.json({
						sharedScopeId: input.sharedScopeId,
						targetPrincipalId: input.targetPrincipalId,
					})}
				)
			`;
		});
	}

	async revokeSharedScopePrincipal(input: {
		actorPrincipalId: string;
		sharedScopeId: string;
		targetPrincipalId: string;
	}) {
		await this.sql.begin(async (sql) => {
			await this.requireConnectionAdministrator(sql, input.actorPrincipalId);
			const [scope] = await sql<{ id: string }[]>`
				SELECT id FROM connection_shared_scopes
				WHERE id = ${input.sharedScopeId} AND state = 'ACTIVE'
				FOR UPDATE
			`;
			if (!scope) forbidden();
			const [target] = await sql<{ id: string }[]>`
				SELECT id FROM connection_principals
				WHERE id = ${input.targetPrincipalId}
				FOR UPDATE
			`;
			if (!target) forbidden();
			await sql`
				SELECT root.id
				FROM connection_authorization_roots root
				JOIN connection_grants current_grant
					ON current_grant.id = root.current_grant_id
				JOIN connection_accounts account
					ON account.id = current_grant.connection_id
				WHERE root.principal_id = ${input.targetPrincipalId}
					AND account.owner_type = 'SHARED'
					AND account.shared_scope_id = ${input.sharedScopeId}
				ORDER BY root.id
				FOR UPDATE OF root
			`;
			await sql`
				SELECT stored_grant.id
				FROM connection_grants stored_grant
				JOIN connection_accounts account
					ON account.id = stored_grant.connection_id
				WHERE stored_grant.principal_id = ${input.targetPrincipalId}
					AND account.owner_type = 'SHARED'
					AND account.shared_scope_id = ${input.sharedScopeId}
					AND stored_grant.status IN (
						'ACTIVE', 'PAUSED_CONNECTION', 'PAUSED_CREDENTIAL'
					)
				ORDER BY stored_grant.id
				FOR UPDATE OF stored_grant
			`;
			const changed = await sql`
				UPDATE connection_shared_scope_principals SET
					status = 'REVOKED',
					revoked_by_principal_id = ${input.actorPrincipalId},
					revoked_at = now(),
					revision = revision + 1
				WHERE shared_scope_id = ${input.sharedScopeId}
					AND principal_id = ${input.targetPrincipalId}
					AND status = 'ACTIVE'
			`;
			if (changed.count === 0) return;
			await sql`
				UPDATE connection_grants stored_grant SET status = 'TERMINATED'
				FROM connection_accounts account
				WHERE account.id = stored_grant.connection_id
					AND stored_grant.principal_id = ${input.targetPrincipalId}
					AND account.owner_type = 'SHARED'
					AND account.shared_scope_id = ${input.sharedScopeId}
					AND stored_grant.status IN (
						'ACTIVE', 'PAUSED_CONNECTION', 'PAUSED_CREDENTIAL'
					)
			`;
			await sql`
				UPDATE connection_authorization_roots root
				SET current_grant_id = NULL, fence = fence + 1
				WHERE root.principal_id = ${input.targetPrincipalId}
					AND EXISTS (
						SELECT 1 FROM connection_grants stored_grant
						JOIN connection_accounts account
							ON account.id = stored_grant.connection_id
						WHERE stored_grant.id = root.current_grant_id
							AND account.owner_type = 'SHARED'
							AND account.shared_scope_id = ${input.sharedScopeId}
					)
			`;
			await sql`
				UPDATE connection_shared_scopes
				SET revision = revision + 1, updated_at = now()
				WHERE id = ${input.sharedScopeId}
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.actorPrincipalId}, 'SHARED_SCOPE_PRINCIPAL_REVOKED',
					${sql.json({
						sharedScopeId: input.sharedScopeId,
						targetPrincipalId: input.targetPrincipalId,
					})}
				)
			`;
		});
	}

	async renameSharedScope(input: {
		actorPrincipalId: string;
		displayName: string;
		sharedScopeId: string;
	}) {
		const displayName = normalizeSharedScopeDisplayName(input.displayName);
		await this.sql.begin(async (sql) => {
			await this.requireConnectionAdministrator(sql, input.actorPrincipalId);
			const [scope] = await sql<{ display_name: string }[]>`
				SELECT display_name FROM connection_shared_scopes
				WHERE id = ${input.sharedScopeId}
				FOR UPDATE
			`;
			if (!scope) forbidden();
			if (scope.display_name === displayName) return;
			await sql`
				UPDATE connection_shared_scopes SET
					display_name = ${displayName},
					revision = revision + 1,
					updated_at = now()
				WHERE id = ${input.sharedScopeId}
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.actorPrincipalId}, 'SHARED_SCOPE_RENAMED',
					${sql.json({ sharedScopeId: input.sharedScopeId })}
				)
			`;
		});
	}

	async storeSharedGithubOAuthCredential(input: {
		accessToken: string;
		actorPrincipalId: string;
		displayName: string;
		externalAccount: string;
		grantedScopes: readonly string[];
		sharedScopeId: string;
	}) {
		const grantedScopes = [...new Set(input.grantedScopes)].sort();
		if (grantedScopes.length === 0) forbidden();
		return this.sql.begin(async (sql) => {
			await this.requireConnectionAdministrator(sql, input.actorPrincipalId);
			const [scope] = await sql<{ id: string }[]>`
				SELECT id FROM connection_shared_scopes
				WHERE id = ${input.sharedScopeId} AND state = 'ACTIVE'
				FOR UPDATE
			`;
			if (!scope) forbidden();
			const providerReleaseId =
				this.publishedProviderReleaseIds.get(githubProvider);
			if (!providerReleaseId) {
				throw new ConnectionError(
					"PROVIDER_FAILED",
					"GitHub catalog is unavailable",
				);
			}
			const [release] = await sql<{ id: string }[]>`
				SELECT id FROM connection_provider_releases
				WHERE id = ${providerReleaseId}
					AND provider = ${githubProvider}
					AND status = 'PUBLISHED'
			`;
			if (!release) {
				throw new ConnectionError(
					"PROVIDER_FAILED",
					"GitHub catalog is unavailable",
				);
			}
			const [existing] = await sql<{ id: string }[]>`
				SELECT id FROM connection_accounts
				WHERE owner_type = 'SHARED'
					AND shared_scope_id = ${input.sharedScopeId}
					AND provider_id = ${githubProvider}
					AND external_account = ${input.externalAccount}
			`;
			const connectionId = existing?.id ?? `connection-${randomUUID()}`;
			if (existing) {
				await sql`
					SELECT root.id
					FROM connection_authorization_roots root
					JOIN connection_grants active_grant
						ON active_grant.id = root.current_grant_id
					WHERE active_grant.connection_id = ${connectionId}
						AND active_grant.status = 'ACTIVE'
					ORDER BY root.principal_id, root.id
					FOR UPDATE OF root
				`;
				await sql`
					SELECT active_grant.id
					FROM connection_authorization_roots root
					JOIN connection_grants active_grant
						ON active_grant.id = root.current_grant_id
					WHERE active_grant.connection_id = ${connectionId}
						AND active_grant.status = 'ACTIVE'
					ORDER BY active_grant.principal_id, root.id
					FOR UPDATE OF active_grant
				`;
				const [lockedAccount] = await sql<{ id: string }[]>`
					SELECT id FROM connection_accounts
					WHERE id = ${connectionId}
						AND owner_type = 'SHARED'
						AND shared_scope_id = ${input.sharedScopeId}
						AND external_account = ${input.externalAccount}
					FOR UPDATE
				`;
				if (!lockedAccount) forbidden();
				await sql`
					UPDATE connection_accounts SET
						provider_release_id = ${release.id},
						display_name = ${input.displayName},
						status = 'ACTIVE', revision = revision + 1,
						execution_fence = execution_fence + 1
					WHERE id = ${connectionId}
				`;
			} else {
				await sql`
					INSERT INTO connection_accounts (
						id, owner_type, owner_principal_id, shared_scope_id,
						provider_release_id, provider_id, external_account,
						display_name, status
					)
					VALUES (
						${connectionId}, 'SHARED', NULL, ${input.sharedScopeId},
						${release.id}, ${githubProvider}, ${input.externalAccount},
						${input.displayName}, 'ACTIVE'
					)
				`;
			}
			await sql`
				UPDATE connection_credential_versions
				SET status = 'REVOKED', revision = revision + 1
				WHERE connection_id = ${connectionId} AND status = 'ACTIVE'
			`;
			const credentialId = `credential-${randomUUID()}`;
			const protectedCredential = this.protector.encrypt(
				input.accessToken,
				`credential:${credentialId}:${connectionId}`,
			);
			await sql`
				INSERT INTO connection_credential_versions (
					id, connection_id, ciphertext, nonce, tag, scope_json, status
				)
				VALUES (
					${credentialId}, ${connectionId}, ${protectedCredential.ciphertext},
					${protectedCredential.nonce}, ${protectedCredential.tag},
					${sql.json(grantedScopes)}, 'ACTIVE'
				)
			`;
			if (existing) {
				await this.restoreGrantsAfterReconnect(sql, connectionId);
			}
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.actorPrincipalId}, 'SHARED_CONNECTION_CONNECTED',
					${sql.json({ connectionId, provider: githubProvider })}
				)
			`;
			return { connectionId };
		});
	}

	private async restoreGrantsAfterReconnect(
		sql: postgres.TransactionSql,
		connectionId: string,
	) {
		const currentGrants = await sql<
			{
				action_version_ids: unknown;
				actor_key: string;
				confirmed_action_set_digest: string | null;
				consent_id: string | null;
				consumer_id: string;
				credential_scope_digest: string | null;
				declaration_id: string | null;
				external_account_fingerprint: string | null;
				id: string;
				principal_id: string;
				provider_id: string;
				provider_release_id: string | null;
				root_fence: string;
				root_id: string;
				root_status: string;
				shared_eligibility_path_hash: string | null;
			}[]
		>`
			SELECT active_grant.id, active_grant.root_id, active_grant.consent_id,
				active_grant.principal_id, active_grant.consumer_id,
				active_grant.actor_key, active_grant.provider_id,
				active_grant.declaration_id,
				active_grant.external_account_fingerprint,
				active_grant.shared_eligibility_path_hash,
				active_grant.credential_scope_digest,
				active_grant.provider_release_id,
				active_grant.confirmed_action_set_digest,
				root.fence::text AS root_fence, root.status AS root_status,
				COALESCE(
					(
						SELECT jsonb_agg(action_version_id ORDER BY action_version_id)
						FROM connection_grant_actions
						WHERE grant_id = active_grant.id
					),
					'[]'::jsonb
				) AS action_version_ids
			FROM connection_authorization_roots root
			JOIN connection_grants active_grant
				ON active_grant.id = root.current_grant_id
				AND active_grant.root_id = root.id
				AND active_grant.actor_key = root.actor_key
				AND active_grant.status = 'ACTIVE'
			WHERE active_grant.connection_id = ${connectionId}
			ORDER BY active_grant.principal_id, root.id
			FOR UPDATE OF root, active_grant
		`;
		for (const grant of currentGrants) {
			let target: AuthorizationTarget | undefined;
			try {
				target = await this.loadAuthorizationTarget(sql, {
					connectionId,
					consumerId: grant.consumer_id,
					principalId: grant.principal_id,
				});
			} catch (error) {
				if (!(error instanceof ConnectionError) || error.code !== "FORBIDDEN") {
					throw error;
				}
			}
			const decision = decideReconnectAuthorization({
				current: {
					actionVersionIds: grant.action_version_ids,
					actorKey: grant.actor_key,
					confirmedActionSetDigest: grant.confirmed_action_set_digest,
					consentId: grant.consent_id,
					consumerDeclarationId: grant.declaration_id,
					credentialScopeDigest: grant.credential_scope_digest,
					externalAccountFingerprint: grant.external_account_fingerprint,
					providerId: grant.provider_id,
					providerReleaseId: grant.provider_release_id,
					rootStatus: grant.root_status,
					sharedEligibilityPathHash: grant.shared_eligibility_path_hash,
				},
				target,
			});
			if (decision === "REPLACE_GRANT" && target) {
				const grantId = `grant-${randomUUID()}`;
				const snapshot = this.authorizationSnapshot(
					grant.principal_id,
					{
						currentGrantId: grant.id,
						fence: grant.root_fence,
						id: grant.root_id,
						providerId: grant.provider_id,
						status: grant.root_status,
					},
					target,
				);
				await sql`
					INSERT INTO connection_grants (
						id, principal_id, consumer_id, connection_id, status,
						root_id, consent_id, actor_key, provider_id, declaration_id,
						connection_revision, connection_execution_fence,
						external_account_fingerprint, shared_eligibility_path_hash,
						credential_version_id, credential_revision,
						credential_scope_digest, provider_release_id,
						confirmed_action_set_digest
					)
					VALUES (
						${grantId}, ${grant.principal_id}, ${grant.consumer_id},
						${connectionId}, 'ACTIVE', ${grant.root_id}, ${grant.consent_id},
						'', ${target.providerId}, ${target.consumerDeclarationId},
						${target.connectionRevision}, ${target.connectionExecutionFence},
						${target.externalAccountFingerprint},
						${target.sharedEligibilityPathHash}, ${target.credentialVersionId},
						${target.credentialRevision}, ${target.credentialScopeDigest},
						${target.providerReleaseId}, ${snapshot.actionSetDigest}
					)
				`;
				for (const action of target.actions) {
					await sql`
						INSERT INTO connection_grant_actions (
							grant_id, action_version_id, authorization_digest
						)
						VALUES (${grantId}, ${action.id}, ${snapshot.authorizationDigest})
					`;
				}
				await sql`
					UPDATE connection_grants SET status = 'REPLACED'
					WHERE id = ${grant.id} AND status = 'ACTIVE'
				`;
				const updatedRoots = await sql`
					UPDATE connection_authorization_roots
					SET current_grant_id = ${grantId}, fence = fence + 1
					WHERE id = ${grant.root_id} AND current_grant_id = ${grant.id}
				`;
				if (updatedRoots.count !== 1) {
					throw new ConnectionError(
						"PROVIDER_FAILED",
						"Authorization changed during reconnect",
					);
				}
				await sql`
					INSERT INTO connection_audit_records (principal_id, event, detail)
					VALUES (
						${grant.principal_id}, 'GRANT_RESTORED_AFTER_RECONNECT',
						${sql.json({
							connectionId,
							consumerId: grant.consumer_id,
							grantId,
							replacedGrantId: grant.id,
						})}
					)
				`;
			} else {
				await sql`
					UPDATE connection_grants SET status = 'PAUSED_CREDENTIAL'
					WHERE id = ${grant.id} AND status = 'ACTIVE'
				`;
				const updatedRoots = await sql`
					UPDATE connection_authorization_roots
					SET current_grant_id = NULL, fence = fence + 1
					WHERE id = ${grant.root_id} AND current_grant_id = ${grant.id}
				`;
				if (updatedRoots.count !== 1) {
					throw new ConnectionError(
						"PROVIDER_FAILED",
						"Authorization changed during reconnect",
					);
				}
				await sql`
					INSERT INTO connection_audit_records (principal_id, event, detail)
					VALUES (
						${grant.principal_id},
						'GRANT_RECONFIRMATION_REQUIRED_AFTER_RECONNECT',
						${sql.json({
							connectionId,
							consumerId: grant.consumer_id,
							grantId: grant.id,
							reason: "AUTHORIZATION_PROOF_CHANGED",
						})}
					)
				`;
			}
		}
	}

	async sharedGithubAdministration(actorPrincipalId: string) {
		return this.sql.begin(async (sql) => {
			await this.requireConnectionAdministrator(sql, actorPrincipalId);
			const principals = await sql<
				{ display_name: string; email: string | null; principal_id: string }[]
			>`
				SELECT id AS principal_id, display_name, email
				FROM connection_principals
				WHERE status = 'ACTIVE'
				ORDER BY display_name, id
			`;
			const scopes = await sql<
				{
					display_name: string;
					shared_scope_id: string;
					state: "ACTIVE" | "SUSPENDED" | "DISABLED";
				}[]
			>`
				SELECT id AS shared_scope_id, display_name, state
				FROM connection_shared_scopes
				ORDER BY display_name, id
			`;
			const members = await sql<
				{ principal_id: string; shared_scope_id: string }[]
			>`
				SELECT principal_id, shared_scope_id
				FROM connection_shared_scope_principals
				WHERE status = 'ACTIVE'
				ORDER BY shared_scope_id, principal_id
			`;
			const connections = await sql<
				{
					display_name: string;
					external_account: string;
					id: string;
					shared_scope_id: string;
					status: "ACTIVE" | "DISCONNECTED";
				}[]
			>`
				SELECT id, shared_scope_id, display_name, external_account, status
				FROM connection_accounts
				WHERE owner_type = 'SHARED'
				ORDER BY display_name, id
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${actorPrincipalId}, 'SHARED_GITHUB_ADMINISTRATION_QUERIED',
					'{}'::jsonb
				)
			`;
			return {
				principals: principals.map((principal) => ({
					displayName: principal.display_name,
					email: principal.email,
					principalId: principal.principal_id,
				})),
				scopes: scopes.map((scope) => ({
					connections: connections
						.filter(
							(connection) =>
								connection.shared_scope_id === scope.shared_scope_id,
						)
						.map((connection) => ({
							displayName: connection.display_name,
							externalAccount: connection.external_account,
							id: connection.id,
							status: connection.status,
						})),
					displayName: scope.display_name,
					members: members
						.filter(
							(member) => member.shared_scope_id === scope.shared_scope_id,
						)
						.map((member) => member.principal_id),
					sharedScopeId: scope.shared_scope_id,
					state: scope.state,
				})),
			};
		});
	}

	private async loadConnectionEligibility(
		sql: postgres.TransactionSql,
		input: { connectionId: string; principalId: string },
	): Promise<ConnectionEligibility> {
		const [account] = await sql<
			{
				owner_principal_id: string | null;
				owner_type: "PERSONAL" | "SHARED";
				provider_id: string;
				shared_scope_id: string | null;
			}[]
		>`
			SELECT owner_principal_id, owner_type, provider_id, shared_scope_id
			FROM connection_accounts
			WHERE id = ${input.connectionId} AND status = 'ACTIVE'
			FOR SHARE
		`;
		if (!account) forbidden();
		if (account.owner_type === "PERSONAL") {
			if (account.owner_principal_id !== input.principalId) forbidden();
			return {
				ownerType: "PERSONAL",
				providerId: account.provider_id,
				sharedEligibilityPathHash: null,
			};
		}
		if (!account.shared_scope_id) forbidden();
		const [eligibility] = await sql<{ membership_revision: string }[]>`
			SELECT membership.revision::text AS membership_revision
			FROM connection_shared_scopes scope
			JOIN connection_shared_scope_principals membership
				ON membership.shared_scope_id = scope.id
				AND membership.principal_id = ${input.principalId}
				AND membership.status = 'ACTIVE'
			WHERE scope.id = ${account.shared_scope_id} AND scope.state = 'ACTIVE'
			FOR SHARE OF scope, membership
		`;
		if (!eligibility) forbidden();
		return {
			ownerType: "SHARED",
			providerId: account.provider_id,
			sharedEligibilityPathHash: canonicalHash({
				membershipRevision: eligibility.membership_revision,
				principalId: input.principalId,
				sharedScopeId: account.shared_scope_id,
			}),
		};
	}

	private async loadAuthorizationTarget(
		sql: postgres.TransactionSql,
		input: { connectionId: string; consumerId: string; principalId: string },
	): Promise<AuthorizationTarget> {
		const [instance] = await sql<{ id: string }[]>`
			SELECT id FROM connection_consumer_instances
			WHERE consumer_id = ${input.consumerId}
				AND principal_id = ${input.principalId}
				AND status = 'ACTIVE'
			ORDER BY last_seen_at DESC NULLS LAST, id
			LIMIT 1
			FOR SHARE
		`;
		if (!instance) forbidden();
		const eligibility = await this.loadConnectionEligibility(sql, input);
		const [subject] = await sql<
			{
				connection_display_name: string;
				connection_execution_fence: string;
				connection_revision: string;
				consumer_display_name: string;
				consumer_revision: string;
				credential_version_id: string;
				credential_revision: string;
				credential_scopes: unknown;
				declaration_digest: string;
				declaration_id: string;
				declaration_revision: string;
				external_account: string;
				provider_id: string;
				provider_release_id: string;
				provider_release_revision: string;
			}[]
		>`
				SELECT account.display_name AS connection_display_name,
					account.external_account, account.provider_id,
					account.provider_release_id, account.revision::text AS connection_revision,
					account.execution_fence::text AS connection_execution_fence,
					release.revision::text AS provider_release_revision,
					consumer.display_name AS consumer_display_name,
					consumer.revision::text AS consumer_revision,
					declaration.id AS declaration_id, declaration.digest AS declaration_digest,
					declaration.revision::text AS declaration_revision,
					credential.id AS credential_version_id,
					credential.revision::text AS credential_revision,
					credential.scope_json AS credential_scopes
				FROM connection_accounts account
			JOIN connection_provider_releases release
				ON release.id = account.provider_release_id
				AND release.provider = account.provider_id
				JOIN connection_consumers consumer ON consumer.id = ${input.consumerId}
				JOIN connection_consumer_action_declarations declaration
					ON declaration.consumer_id = consumer.id
					AND declaration.provider_id = account.provider_id
					AND declaration.provider_release_id = account.provider_release_id
					AND declaration.status = 'PUBLISHED'
				JOIN connection_credential_versions credential
				ON credential.connection_id = account.id
				AND credential.status = 'ACTIVE'
			WHERE account.id = ${input.connectionId}
				AND account.status = 'ACTIVE'
				AND release.status = 'PUBLISHED'
				AND consumer.status = 'ACTIVE'
				FOR SHARE OF account, release, consumer, declaration, credential
			`;
		if (!subject) forbidden();
		const credentialScopes = Array.isArray(subject.credential_scopes)
			? subject.credential_scopes.filter(
					(scope): scope is string => typeof scope === "string",
				)
			: [];
		const actionRows = await sql<
			{
				description: string;
				effect: "READ" | "WRITE";
				id: string;
				input_schema: unknown;
				name: ActionName;
				required_scopes: unknown;
				revision: string;
			}[]
		>`
				SELECT action.id, action.name, action.description, action.effect,
					action.input_schema, action.required_scopes,
					action.revision::text AS revision
				FROM connection_consumer_declared_actions declared
				JOIN connection_action_versions action
					ON action.id = declared.action_version_id
				WHERE declared.declaration_id = ${subject.declaration_id}
					AND action.provider_release_id = ${subject.provider_release_id}
					AND action.status = 'PUBLISHED'
				ORDER BY action.id
				FOR SHARE OF declared, action
			`;
		if (actionRows.length === 0) {
			invalidAuthorizationPreview("No declared Actions are available");
		}
		const actions = actionRows.map(actionDefinition);
		const requiredScopes = new Set(
			actions.flatMap((action) => [...action.requiredScopes]),
		);
		if (
			[...requiredScopes].some((scope) => !credentialScopes.includes(scope))
		) {
			forbidden();
		}
		return {
			actions,
			catalogRevisionDigest: canonicalHash(
				actionRows.map((action) => ({
					id: action.id,
					revision: action.revision,
				})),
			),
			connection: {
				displayName: subject.connection_display_name,
				externalAccount: subject.external_account,
				id: input.connectionId,
			},
			connectionExecutionFence: subject.connection_execution_fence,
			connectionRevision: subject.connection_revision,
			consumer: {
				id: input.consumerId,
				name: subject.consumer_display_name,
			},
			consumerDeclarationDigest: subject.declaration_digest,
			consumerDeclarationId: subject.declaration_id,
			consumerDeclarationRevision: subject.declaration_revision,
			consumerRevision: subject.consumer_revision,
			credentialRevision: subject.credential_revision,
			credentialScopeDigest: canonicalHash(credentialScopes.sort()),
			credentialScopes,
			credentialVersionId: subject.credential_version_id,
			externalAccountFingerprint: canonicalHash({
				externalAccount: subject.external_account,
				providerReleaseId: subject.provider_release_id,
			}),
			providerId: subject.provider_id,
			providerReleaseId: subject.provider_release_id,
			providerReleaseRevision: subject.provider_release_revision,
			sharedEligibilityPathHash: eligibility.sharedEligibilityPathHash,
		};
	}

	private authorizationSnapshot(
		principalId: string,
		root: AuthorizationRootSnapshot,
		target: AuthorizationTarget,
	) {
		return createAuthorizationSnapshot({
			actions: target.actions,
			connection: target.connection,
			consumer: target.consumer,
			principalId,
			sourceRevisions: {
				catalogRevisionDigest: target.catalogRevisionDigest,
				connectionExecutionFence: target.connectionExecutionFence,
				connectionRevision: target.connectionRevision,
				consumerDeclarationDigest: target.consumerDeclarationDigest,
				consumerDeclarationId: target.consumerDeclarationId,
				consumerDeclarationRevision: target.consumerDeclarationRevision,
				consumerRevision: target.consumerRevision,
				credentialRevision: target.credentialRevision,
				credentialScopeDigest: target.credentialScopeDigest,
				credentialVersionId: target.credentialVersionId,
				currentGrantId: root.currentGrantId,
				externalAccountFingerprint: target.externalAccountFingerprint,
				providerReleaseId: target.providerReleaseId,
				providerReleaseRevision: target.providerReleaseRevision,
				rootFence: root.fence,
				rootStatus: root.status,
				sharedEligibilityPathHash: target.sharedEligibilityPathHash,
			},
		});
	}

	async createCurrentConsumerAuthorizationPreview(input: {
		connectionId: string;
		consumerId: string;
		principalId: string;
	}): Promise<CurrentConsumerAuthorizationPreview> {
		if (!input.connectionId || !input.consumerId || !input.principalId) {
			invalidAuthorizationPreview("Authorization preview input is incomplete");
		}
		return this.sql.begin(async (sql) => {
			const [principal] = await sql<{ id: string }[]>`
				SELECT id FROM connection_principals
				WHERE id = ${input.principalId} AND status = 'ACTIVE'
				FOR UPDATE
			`;
			if (!principal) forbidden();
			const connectionIdentity = await this.loadConnectionEligibility(
				sql,
				input,
			);
			await sql`
				INSERT INTO connection_authorization_roots (
					id, principal_id, consumer_id, current_grant_id,
					status, actor_key, provider_id
				)
				VALUES (
					${`root-${randomUUID()}`}, ${input.principalId}, ${input.consumerId},
					NULL, 'ACTIVE', '', ${connectionIdentity.providerId}
				)
				ON CONFLICT DO NOTHING
			`;
			const [rootRow] = await sql<
				{
					current_grant_id: string | null;
					fence: string;
					id: string;
					provider_id: string;
					status: string;
				}[]
			>`
				SELECT id, current_grant_id, fence::text, provider_id, status
				FROM connection_authorization_roots
				WHERE principal_id = ${input.principalId}
					AND consumer_id = ${input.consumerId}
					AND actor_key = ''
					AND provider_id = ${connectionIdentity.providerId}
				FOR UPDATE
			`;
			if (!rootRow)
				throw new Error("Connection authorization root was not created");
			if (rootRow.current_grant_id) {
				const [currentGrant] = await sql<{ id: string }[]>`
					SELECT id FROM connection_grants
					WHERE id = ${rootRow.current_grant_id} AND root_id = ${rootRow.id}
					FOR UPDATE
				`;
				if (!currentGrant)
					throw new Error("Current Connection grant was not found");
			}
			const target = await this.loadAuthorizationTarget(sql, input);
			const root: AuthorizationRootSnapshot = {
				currentGrantId: rootRow.current_grant_id,
				fence: rootRow.fence,
				id: rootRow.id,
				providerId: rootRow.provider_id,
				status: rootRow.status,
			};
			const snapshot = this.authorizationSnapshot(
				input.principalId,
				root,
				target,
			);
			const confirmationToken = randomBytes(32).toString("base64url");
			const previewId = `preview-${randomUUID()}`;
			const [stored] = await sql<{ expires_at: Date }[]>`
					INSERT INTO connection_authorization_previews (
						id, root_id, connection_id, declaration_id, confirmation_token_hash,
					action_version_ids, action_set_digest, authorization_digest,
					source_revisions, root_fence, current_grant_id, expires_at
				)
				VALUES (
						${previewId}, ${root.id}, ${input.connectionId},
						${target.consumerDeclarationId}, ${hash(confirmationToken)},
					${sql.json(target.actions.map((action) => action.id))},
					${snapshot.actionSetDigest}, ${snapshot.authorizationDigest},
					${sql.json(snapshot.sourceRevisions)}, ${root.fence},
					${root.currentGrantId},
					now() + ${this.authorizationPreviewTtlMs} * interval '1 millisecond'
				)
				RETURNING expires_at
			`;
			if (!stored) throw new Error("Authorization preview was not created");
			const [currentConnection] = root.currentGrantId
				? await sql<
						{ display_name: string; external_account: string; id: string }[]
					>`
						SELECT account.id, account.display_name, account.external_account
						FROM connection_grants grant_row
						JOIN connection_accounts account ON account.id = grant_row.connection_id
						WHERE grant_row.id = ${root.currentGrantId}
							AND grant_row.root_id = ${root.id}
					`
				: [];
			return {
				actions: target.actions.map(
					({ description, effect, id, name, requiredScopes }) => ({
						description,
						effect,
						id,
						name,
						requiredScopes,
					}),
				),
				confirmationToken,
				consumer: target.consumer,
				...(currentConnection
					? {
							currentConnection: {
								displayName: currentConnection.display_name,
								externalAccount: currentConnection.external_account,
								id: currentConnection.id,
							},
						}
					: {}),
				effectSummary: [
					...new Set(target.actions.map((action) => action.effect)),
				].sort(),
				expiresAt: stored.expires_at.toISOString(),
				previewId,
				requiredScopes: [
					...new Set(
						target.actions.flatMap((action) => [...action.requiredScopes]),
					),
				].sort(),
				targetConnection: target.connection,
			};
		});
	}

	async confirmCurrentConsumerAuthorization(input: {
		confirmationToken: string;
		idempotencyKey: string;
		previewId: string;
		principalId: string;
	}) {
		if (
			!input.confirmationToken ||
			!input.idempotencyKey ||
			!input.previewId ||
			!input.principalId
		) {
			invalidAuthorizationPreview("Authorization confirmation is incomplete");
		}
		return this.sql.begin(async (sql) => {
			const [previewIdentity] = await sql<{ root_id: string }[]>`
				SELECT preview.root_id
				FROM connection_authorization_previews preview
				JOIN connection_authorization_roots root ON root.id = preview.root_id
				WHERE preview.id = ${input.previewId}
					AND preview.confirmation_token_hash = ${hash(input.confirmationToken)}
					AND root.principal_id = ${input.principalId}
			`;
			if (!previewIdentity) forbidden();
			const [principal] = await sql<{ id: string }[]>`
				SELECT id FROM connection_principals
				WHERE id = ${input.principalId} AND status = 'ACTIVE'
				FOR UPDATE
			`;
			if (!principal) forbidden();
			const [rootRow] = await sql<
				{
					consumer_id: string;
					current_grant_id: string | null;
					fence: string;
					id: string;
					provider_id: string;
					status: string;
				}[]
			>`
				SELECT id, consumer_id, current_grant_id, fence::text, provider_id, status
				FROM connection_authorization_roots
				WHERE id = ${previewIdentity.root_id}
					AND principal_id = ${input.principalId}
					AND actor_key = ''
				FOR UPDATE
			`;
			if (!rootRow) forbidden();
			if (rootRow.current_grant_id) {
				const [currentGrant] = await sql<{ id: string }[]>`
					SELECT id FROM connection_grants
					WHERE id = ${rootRow.current_grant_id} AND root_id = ${rootRow.id}
					FOR UPDATE
				`;
				if (!currentGrant)
					throw new Error("Current Connection grant was not found");
			}
			const [preview] = await sql<
				{
					action_set_digest: string;
					action_version_ids: unknown;
					authorization_digest: string;
					confirmation_idempotency_key: string | null;
					confirmed_grant_id: string | null;
					connection_id: string;
					consumed_at: Date | null;
					current_grant_id: string | null;
					declaration_id: string | null;
					expired: boolean;
					root_fence: string;
					source_revisions: unknown;
				}[]
			>`
					SELECT action_version_ids, action_set_digest, authorization_digest,
						confirmation_idempotency_key, confirmed_grant_id, connection_id,
						consumed_at, current_grant_id, declaration_id, root_fence::text,
						source_revisions,
					expires_at <= now() AS expired
				FROM connection_authorization_previews
				WHERE id = ${input.previewId} AND root_id = ${rootRow.id}
				FOR UPDATE
			`;
			if (!preview) forbidden();
			if (preview.consumed_at) {
				if (
					preview.confirmation_idempotency_key === input.idempotencyKey &&
					preview.confirmed_grant_id
				) {
					return { grantId: preview.confirmed_grant_id };
				}
				invalidAuthorizationPreview(
					"Authorization preview was already consumed",
				);
			}
			if (preview.expired) {
				invalidAuthorizationPreview("Authorization preview has expired");
			}
			const [reusedIdempotencyKey] = await sql<{ id: string }[]>`
				SELECT id FROM connection_authorization_previews
				WHERE root_id = ${rootRow.id}
					AND confirmation_idempotency_key = ${input.idempotencyKey}
					AND id <> ${input.previewId}
			`;
			if (reusedIdempotencyKey) {
				invalidAuthorizationPreview("Idempotency key was already used");
			}
			const root: AuthorizationRootSnapshot = {
				currentGrantId: rootRow.current_grant_id,
				fence: rootRow.fence,
				id: rootRow.id,
				providerId: rootRow.provider_id,
				status: rootRow.status,
			};
			const target = await this.loadAuthorizationTarget(sql, {
				connectionId: preview.connection_id,
				consumerId: rootRow.consumer_id,
				principalId: input.principalId,
			});
			const snapshot = this.authorizationSnapshot(
				input.principalId,
				root,
				target,
			);
			if (
				target.providerId !== root.providerId ||
				preview.declaration_id !== target.consumerDeclarationId ||
				root.fence !== preview.root_fence ||
				root.currentGrantId !== preview.current_grant_id ||
				!authorizationSnapshotMatches(
					{
						actionSetDigest: preview.action_set_digest,
						actionVersionIds: preview.action_version_ids,
						authorizationDigest: preview.authorization_digest,
						sourceRevisions: preview.source_revisions,
					},
					{
						...snapshot,
						actionVersionIds: target.actions.map((action) => action.id),
					},
				)
			) {
				invalidAuthorizationPreview(
					"Authorization preview is stale; review access again",
				);
			}
			const consentId = `consent-${randomUUID()}`;
			const grantId = `grant-${randomUUID()}`;
			await sql`
				INSERT INTO connection_authorization_consents (
					id, root_id, preview_id, action_version_ids, snapshot_hash
				)
				VALUES (
					${consentId}, ${root.id}, ${input.previewId},
					${sql.json(target.actions.map((action) => action.id))},
					${snapshot.authorizationDigest}
				)
			`;
			await sql`
					INSERT INTO connection_grants (
						id, principal_id, consumer_id, connection_id, status,
						root_id, consent_id, actor_key, provider_id, declaration_id,
						connection_revision, connection_execution_fence,
						external_account_fingerprint, shared_eligibility_path_hash,
						credential_version_id, credential_revision, credential_scope_digest,
						provider_release_id, confirmed_action_set_digest
					)
					VALUES (
						${grantId}, ${input.principalId}, ${rootRow.consumer_id},
						${preview.connection_id}, 'ACTIVE', ${root.id}, ${consentId},
						'', ${target.providerId}, ${target.consumerDeclarationId},
						${target.connectionRevision}, ${target.connectionExecutionFence},
						${target.externalAccountFingerprint}, ${target.sharedEligibilityPathHash},
						${target.credentialVersionId}, ${target.credentialRevision},
						${target.credentialScopeDigest}, ${target.providerReleaseId},
						${snapshot.actionSetDigest}
					)
			`;
			for (const action of target.actions) {
				await sql`
					INSERT INTO connection_grant_actions (
						grant_id, action_version_id, authorization_digest
					)
					VALUES (${grantId}, ${action.id}, ${snapshot.authorizationDigest})
				`;
			}
			if (root.currentGrantId) {
				await sql`
					UPDATE connection_grants SET status = 'REPLACED'
					WHERE id = ${root.currentGrantId}
						AND root_id = ${root.id}
						AND status = 'ACTIVE'
				`;
			}
			const updatedRoots = await sql`
				UPDATE connection_authorization_roots
				SET current_grant_id = ${grantId}, status = 'ACTIVE', fence = fence + 1
				WHERE id = ${root.id}
					AND fence = ${root.fence}
					AND current_grant_id IS NOT DISTINCT FROM ${root.currentGrantId}
			`;
			if (updatedRoots.count !== 1) {
				invalidAuthorizationPreview(
					"Authorization preview is stale; review access again",
				);
			}
			await sql`
				UPDATE connection_authorization_previews
				SET consumed_at = now(),
					confirmation_idempotency_key = ${input.idempotencyKey},
					confirmed_grant_id = ${grantId}
				WHERE id = ${input.previewId} AND consumed_at IS NULL
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.principalId}, 'GRANT_CONFIRMED',
					${sql.json({
						authorizationDigest: snapshot.authorizationDigest,
						connectionId: preview.connection_id,
						consumerId: rootRow.consumer_id,
						grantId,
						previewId: input.previewId,
					})}
				)
			`;
			return { grantId };
		});
	}

	async resolveDirectIdentity(input: {
		consumerId: string;
		instanceId: string;
		principalId: string;
	}) {
		const invocations = await this.resolveDirectIdentities(input);
		if (invocations.length !== 1) forbidden();
		return invocations[0] as InvocationContext;
	}

	async resolveDirectIdentities(input: {
		consumerId: string;
		instanceId: string;
		principalId: string;
	}) {
		const rows = await this.sql<InvocationRow[]>`
			SELECT
				active_grant.connection_id,
				active_grant.consumer_id,
				credential.id AS credential_version_id,
				active_grant.id AS grant_id,
				instance.id AS instance_id,
				active_grant.principal_id,
				account.provider_id,
				account.provider_release_id,
				NULL::text AS actor_key
			FROM connection_consumer_instances instance
			JOIN connection_consumers consumer ON consumer.id = instance.consumer_id
			JOIN connection_authorization_roots root
				ON root.principal_id = instance.principal_id
				AND root.consumer_id = instance.consumer_id
				AND root.actor_key = ''
				AND root.status = 'ACTIVE'
			JOIN connection_grants active_grant
				ON active_grant.id = root.current_grant_id
				AND active_grant.root_id = root.id
				AND active_grant.status = 'ACTIVE'
			JOIN connection_accounts account
				ON account.id = active_grant.connection_id
				AND account.provider_id = active_grant.provider_id
				AND account.status = 'ACTIVE'
				AND (
					(
						account.owner_type = 'PERSONAL'
						AND account.owner_principal_id = active_grant.principal_id
					) OR (
						account.owner_type = 'SHARED'
						AND EXISTS (
							SELECT 1 FROM connection_shared_scopes shared_scope
							JOIN connection_shared_scope_principals membership
								ON membership.shared_scope_id = shared_scope.id
								AND membership.principal_id = active_grant.principal_id
								AND membership.status = 'ACTIVE'
							WHERE shared_scope.id = account.shared_scope_id
								AND shared_scope.state = 'ACTIVE'
						)
					)
				)
			JOIN connection_credential_versions credential
				ON credential.connection_id = account.id AND credential.status = 'ACTIVE'
			JOIN connection_principals principal
				ON principal.id = active_grant.principal_id AND principal.status = 'ACTIVE'
			WHERE instance.id = ${input.instanceId}
				AND instance.consumer_id = ${input.consumerId}
				AND instance.principal_id = ${input.principalId}
				AND instance.status = 'ACTIVE'
				AND consumer.status = 'ACTIVE'
			ORDER BY root.provider_id, root.id
		`;
		if (rows.length === 0) forbidden();
		return rows.map(invocation);
	}

	async resolveDirectSession(session: string | undefined) {
		if (!session) forbidden();
		const [instance] = await this.sql<
			{ consumer_id: string; id: string; principal_id: string }[]
		>`
			SELECT id, consumer_id, principal_id
			FROM connection_consumer_instances
			WHERE auth_subject = ${session} AND kind = 'DEVICE' AND status = 'ACTIVE'
		`;
		if (!instance) forbidden();
		return this.resolveDirectIdentity({
			consumerId: instance.consumer_id,
			instanceId: instance.id,
			principalId: instance.principal_id,
		});
	}

	async resolveDelegatedWorkload(
		workload: string | undefined,
		actorKey?: string,
	) {
		const invocations = await this.resolveDelegatedWorkloads(
			workload,
			actorKey,
		);
		if (invocations.length !== 1) forbidden();
		return invocations[0] as InvocationContext;
	}

	async resolveDelegatedWorkloads(
		workload: string | undefined,
		actorKey?: string,
	) {
		if (!workload) forbidden();
		const rows = await this.sql<InvocationRow[]>`
			SELECT
				active_grant.connection_id,
				active_grant.consumer_id,
				credential.id AS credential_version_id,
				active_grant.id AS grant_id,
				instance.id AS instance_id,
				active_grant.principal_id,
				account.provider_id,
				account.provider_release_id,
				active_grant.actor_key
			FROM connection_consumer_instances instance
			JOIN connection_authorization_roots root
				ON root.principal_id = instance.principal_id
				AND root.consumer_id = instance.consumer_id
				AND root.status = 'ACTIVE'
			JOIN connection_grants active_grant
				ON active_grant.id = root.current_grant_id
				AND active_grant.root_id = root.id
				AND active_grant.actor_key = root.actor_key
				AND active_grant.status = 'ACTIVE'
			JOIN connection_accounts account
				ON account.id = active_grant.connection_id
				AND account.provider_id = active_grant.provider_id
				AND account.provider_release_id = active_grant.provider_release_id
				AND account.status = 'ACTIVE'
			JOIN connection_credential_versions credential
				ON credential.connection_id = account.id AND credential.status = 'ACTIVE'
			WHERE instance.auth_subject = ${workload}
				AND instance.kind = 'WORKLOAD'
				AND instance.status = 'ACTIVE'
				AND root.actor_key = ${actorKey ?? ""}
		`;
		if (rows.length === 0) forbidden();
		return rows.map(invocation);
	}

	async listAuthorizedActions(input: InvocationContext) {
		await this.verifyInvocationBase(input);
		const rows = await this.sql<
			{
				description: string;
				effect: "READ" | "WRITE";
				id: string;
				input_schema: unknown;
				name: ActionName;
				required_scopes: unknown;
			}[]
		>`
			SELECT action.id, action.name, action.description, action.effect,
				action.input_schema, action.required_scopes
			FROM connection_grant_actions grant_action
			JOIN connection_grants stored_grant ON stored_grant.id = grant_action.grant_id
			JOIN connection_accounts account ON account.id = stored_grant.connection_id
			JOIN connection_action_versions action ON action.id = grant_action.action_version_id
			JOIN connection_provider_releases release ON release.id = action.provider_release_id
			WHERE grant_action.grant_id = ${input.grantId}
				AND action.provider_release_id = account.provider_release_id
				AND action.status = 'PUBLISHED'
				AND release.status = 'PUBLISHED'
			ORDER BY action.id
		`;
		return rows.map(actionDefinition);
	}

	async listAuthorizedConnections(input: InvocationContext) {
		await this.verifyInvocationBase(input);
		const rows = await this.sql<
			{
				action_version_ids: unknown;
				display_name: string;
				external_account: string;
				id: string;
				owner_type: "PERSONAL" | "SHARED";
				provider_id: string;
				provider_release_id: string;
				release_status: "DISABLED" | "PUBLISHED";
				status: "ACTIVE" | "DISCONNECTED";
			}[]
		>`
			SELECT account.id, account.external_account, account.display_name,
				account.owner_type, account.provider_id, account.provider_release_id,
				account.status, release.status AS release_status,
				COALESCE(
					jsonb_agg(action.id ORDER BY action.id)
						FILTER (WHERE action.id IS NOT NULL),
					'[]'::jsonb
				) AS action_version_ids
			FROM connection_grants stored_grant
			JOIN connection_accounts account ON account.id = stored_grant.connection_id
			JOIN connection_provider_releases release
				ON release.id = account.provider_release_id
			LEFT JOIN connection_grant_actions grant_action
				ON grant_action.grant_id = stored_grant.id
			LEFT JOIN connection_action_versions action
				ON action.id = grant_action.action_version_id
				AND action.provider_release_id = account.provider_release_id
				AND action.status = 'PUBLISHED'
			WHERE stored_grant.id = ${input.grantId}
				AND stored_grant.connection_id = ${input.connectionId}
				AND stored_grant.principal_id = ${input.principalId}
			GROUP BY account.id, account.external_account, account.display_name,
				account.owner_type, account.provider_id, account.provider_release_id,
				account.status, release.status
		`;
		return rows.map((connection) => ({
			actionVersionIds: Array.isArray(connection.action_version_ids)
				? connection.action_version_ids.filter(
						(value): value is string => typeof value === "string",
					)
				: [],
			displayName: connection.display_name,
			externalAccount: connection.external_account,
			id: connection.id,
			ownerType: connection.owner_type,
			providerId: connection.provider_id,
			requiresReconnect:
				connection.release_status !== "PUBLISHED" ||
				this.publishedProviderReleaseIds.get(connection.provider_id) !==
					connection.provider_release_id,
			status: connection.status,
		}));
	}

	async verifyInvocation(input: InvocationContext & { action: ActionName }) {
		await this.verifyInvocationBase(input, input.action);
	}

	private async verifyInvocationBase(
		input: InvocationContext,
		action?: ActionName,
	) {
		const [row] = await this.sql<{ valid: boolean }[]>`
			SELECT TRUE AS valid
			FROM connection_grants active_grant
			JOIN connection_authorization_roots root
				ON root.id = active_grant.root_id
				AND root.current_grant_id = active_grant.id
				AND root.status = 'ACTIVE'
				JOIN connection_consumers consumer
					ON consumer.id = active_grant.consumer_id AND consumer.status = 'ACTIVE'
				JOIN connection_consumer_action_declarations declaration
					ON declaration.id = active_grant.declaration_id
					AND declaration.consumer_id = active_grant.consumer_id
					AND declaration.status IN ('PUBLISHED', 'SUPERSEDED')
			JOIN connection_consumer_instances instance
				ON instance.id = ${input.instanceId}
				AND instance.consumer_id = active_grant.consumer_id
				AND instance.principal_id = active_grant.principal_id
				AND instance.status = 'ACTIVE'
			JOIN connection_principals principal
				ON principal.id = active_grant.principal_id AND principal.status = 'ACTIVE'
			JOIN connection_accounts account
				ON account.id = active_grant.connection_id
				AND account.provider_id = active_grant.provider_id
					AND account.provider_release_id = active_grant.provider_release_id
					AND account.revision = active_grant.connection_revision
					AND account.execution_fence = active_grant.connection_execution_fence
					AND account.status = 'ACTIVE'
					AND (
						(
							account.owner_type = 'PERSONAL'
							AND account.owner_principal_id = active_grant.principal_id
						) OR (
							account.owner_type = 'SHARED'
							AND EXISTS (
								SELECT 1 FROM connection_shared_scopes shared_scope
								JOIN connection_shared_scope_principals membership
									ON membership.shared_scope_id = shared_scope.id
									AND membership.principal_id = active_grant.principal_id
									AND membership.status = 'ACTIVE'
								WHERE shared_scope.id = account.shared_scope_id
									AND shared_scope.state = 'ACTIVE'
							)
						)
					)
				JOIN connection_credential_versions credential
					ON credential.id = active_grant.credential_version_id
					AND credential.id = ${input.credentialVersionId}
					AND credential.connection_id = account.id
					AND credential.revision = active_grant.credential_revision
					AND credential.status = 'ACTIVE'
			WHERE active_grant.id = ${input.grantId}
				AND active_grant.status = 'ACTIVE'
				AND active_grant.principal_id = ${input.principalId}
				AND active_grant.consumer_id = ${input.consumerId}
				AND active_grant.connection_id = ${input.connectionId}
				AND active_grant.actor_key = ${input.actorKey ?? ""}
				AND active_grant.provider_id = ${input.providerId}
				AND active_grant.provider_release_id = ${input.providerReleaseId}
				AND (
					${action ?? null}::text IS NULL OR EXISTS (
						SELECT 1 FROM connection_grant_actions grant_action
						JOIN connection_action_versions action
							ON action.id = grant_action.action_version_id
							AND action.status = 'PUBLISHED'
						JOIN connection_provider_releases release
							ON release.id = action.provider_release_id
							AND release.status = 'PUBLISHED'
							WHERE grant_action.grant_id = active_grant.id
								AND EXISTS (
									SELECT 1 FROM connection_consumer_declared_actions declared
									WHERE declared.declaration_id = declaration.id
										AND declared.action_version_id = action.id
								)
							AND action.name = ${action ?? ""}
							AND action.provider_release_id = account.provider_release_id
					)
				)
		`;
		if (!row?.valid) forbidden();
	}

	async getCredential(input: InvocationContext) {
		await this.verifyInvocationBase(input);
		const [row] = await this.sql<
			{
				ciphertext: string;
				connection_id: string;
				id: string;
				nonce: string;
				tag: string;
			}[]
		>`
			SELECT id, connection_id, ciphertext, nonce, tag
			FROM connection_credential_versions
			WHERE id = ${input.credentialVersionId}
				AND connection_id = ${input.connectionId}
				AND status = 'ACTIVE'
		`;
		if (!row) forbidden();
		return {
			accessToken: this.protector.decrypt(
				row,
				`credential:${row.id}:${row.connection_id}`,
			),
		};
	}

	async createOAuthTransaction(input: OAuthTransaction & { state: string }) {
		const stateHash = hash(input.state);
		const protectedVerifier = this.protector.encrypt(
			input.codeVerifier,
			`oauth:${stateHash}:${input.principalId}`,
		);
		await this.sql.begin(async (sql) => {
			if (input.sharedScopeId) {
				await this.requireConnectionAdministrator(sql, input.principalId);
				const [scope] = await sql<{ id: string }[]>`
					SELECT id FROM connection_shared_scopes
					WHERE id = ${input.sharedScopeId} AND state = 'ACTIVE'
					FOR SHARE
				`;
				if (!scope) forbidden();
			}
			await sql`
				INSERT INTO connection_oauth_transactions (
					state_hash, principal_id, verifier_ciphertext, verifier_nonce,
					verifier_tag, redirect_uri, shared_scope_id, expires_at
				)
				VALUES (
					${stateHash}, ${input.principalId}, ${protectedVerifier.ciphertext},
					${protectedVerifier.nonce}, ${protectedVerifier.tag},
					${input.redirectUri}, ${input.sharedScopeId ?? null},
					now() + interval '10 minutes'
				)
			`;
		});
	}

	async consumeOAuthTransaction(state: string) {
		const stateHash = hash(state);
		return this.sql.begin(async (sql) => {
			const [row] = await sql<
				{
					principal_id: string;
					redirect_uri: string;
					shared_scope_id: string | null;
					verifier_ciphertext: string;
					verifier_nonce: string;
					verifier_tag: string;
				}[]
			>`
				UPDATE connection_oauth_transactions
				SET consumed_at = now()
				WHERE state_hash = ${stateHash}
					AND consumed_at IS NULL
					AND expires_at > now()
				RETURNING principal_id, redirect_uri, shared_scope_id, verifier_ciphertext,
					verifier_nonce, verifier_tag
			`;
			if (!row) {
				throw new ConnectionError(
					"INVALID_REQUEST",
					"OAuth state is invalid, expired, or already consumed",
				);
			}
			return {
				codeVerifier: this.protector.decrypt(
					{
						ciphertext: row.verifier_ciphertext,
						nonce: row.verifier_nonce,
						tag: row.verifier_tag,
					},
					`oauth:${stateHash}:${row.principal_id}`,
				),
				principalId: row.principal_id,
				redirectUri: row.redirect_uri,
				...(row.shared_scope_id ? { sharedScopeId: row.shared_scope_id } : {}),
			};
		});
	}

	async storeGithubOAuthCredential(input: {
		accessToken: string;
		displayName: string;
		externalAccount: string;
		grantedScopes: readonly string[];
		principalId: string;
	}) {
		const providerReleaseId =
			this.publishedProviderReleaseIds.get(githubProvider);
		if (!providerReleaseId) {
			throw new ConnectionError(
				"PROVIDER_FAILED",
				"GitHub catalog is unavailable",
			);
		}
		return this.storeProviderCredential({
			...input,
			providerId: githubProvider,
			providerReleaseId,
		});
	}

	async storeProviderCredential(input: {
		accessToken: string;
		displayName: string;
		externalAccount: string;
		grantedScopes: readonly string[];
		principalId: string;
		providerId: string;
		providerReleaseId: string;
	}) {
		const grantedScopes = [...new Set(input.grantedScopes)].sort();
		if (
			grantedScopes.length === 0 ||
			!input.providerId ||
			this.publishedProviderReleaseIds.get(input.providerId) !==
				input.providerReleaseId
		) {
			forbidden();
		}
		return this.sql.begin(async (sql) => {
			const [principal] = await sql<{ id: string }[]>`
					SELECT id FROM connection_principals
					WHERE id = ${input.principalId} AND status = 'ACTIVE'
					FOR UPDATE
				`;
			if (!principal) forbidden();
			const [release] = await sql<{ id: string }[]>`
				SELECT id FROM connection_provider_releases
				WHERE id = ${input.providerReleaseId}
					AND provider = ${input.providerId}
					AND status = 'PUBLISHED'
			`;
			if (!release) {
				throw new ConnectionError(
					"PROVIDER_FAILED",
					"Provider catalog is unavailable",
				);
			}
			await sql`
					SELECT id FROM connection_authorization_roots
					WHERE principal_id = ${input.principalId}
						AND provider_id = ${input.providerId}
					ORDER BY id
					FOR UPDATE
				`;
			await sql`
				SELECT active_grant.id
				FROM connection_authorization_roots root
				JOIN connection_grants active_grant
					ON active_grant.id = root.current_grant_id
					AND active_grant.root_id = root.id
					AND active_grant.status = 'ACTIVE'
				WHERE root.principal_id = ${input.principalId}
					AND root.provider_id = ${input.providerId}
				ORDER BY root.id
				FOR UPDATE OF active_grant
			`;
			const [existing] = await sql<{ id: string }[]>`
				SELECT id FROM connection_accounts
				WHERE owner_type = 'PERSONAL'
					AND owner_principal_id = ${input.principalId}
					AND provider_id = ${input.providerId}
					AND external_account = ${input.externalAccount}
				FOR UPDATE
			`;
			const connectionId = existing?.id ?? `connection-${randomUUID()}`;
			if (existing) {
				await sql`
					UPDATE connection_accounts
					SET provider_release_id = ${release.id}, display_name = ${input.displayName},
						status = 'ACTIVE', revision = revision + 1,
						execution_fence = execution_fence + 1
					WHERE id = ${connectionId}
				`;
			} else {
				await sql`
					INSERT INTO connection_accounts (
						id, owner_type, owner_principal_id, shared_scope_id,
						provider_release_id, provider_id,
						external_account, display_name, status
					)
					VALUES (
						${connectionId}, 'PERSONAL', ${input.principalId}, NULL,
						${release.id}, ${input.providerId},
						${input.externalAccount}, ${input.displayName}, 'ACTIVE'
					)
				`;
			}
			await sql`
				UPDATE connection_credential_versions
				SET status = 'REVOKED', revision = revision + 1
				WHERE connection_id = ${connectionId} AND status = 'ACTIVE'
			`;
			const credentialId = `credential-${randomUUID()}`;
			const protectedCredential = this.protector.encrypt(
				input.accessToken,
				`credential:${credentialId}:${connectionId}`,
			);
			await sql`
				INSERT INTO connection_credential_versions (
					id, connection_id, ciphertext, nonce, tag, scope_json, status
				)
				VALUES (
					${credentialId}, ${connectionId}, ${protectedCredential.ciphertext},
					${protectedCredential.nonce}, ${protectedCredential.tag},
					${sql.json(grantedScopes)}, 'ACTIVE'
				)
			`;
			await this.restoreGrantsAfterReconnect(sql, connectionId);
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.principalId}, 'CONNECTION_CONNECTED',
					${sql.json({ connectionId, provider: input.providerId })}
				)
			`;
			return { connectionId };
		});
	}

	async getOverview(principalId: string): Promise<ConnectionOverview> {
		const currentReleaseIds = new Set(
			this.publishedProviderReleaseIds.values(),
		);
		const [principal, connections, actions, grants, consumers, calls] =
			await Promise.all([
				this.sql<{ display_name: string; id: string }[]>`
					SELECT id, display_name FROM connection_principals
					WHERE id = ${principalId} AND status = 'ACTIVE'
				`,
				this.sql<
					{
						action_version_ids: unknown;
						display_name: string;
						credential_scope_known: boolean;
						external_account: string;
						id: string;
						owner_type: "PERSONAL" | "SHARED";
						provider_id: string;
						provider_release_id: string;
						release_status: "DISABLED" | "PUBLISHED";
						status: "ACTIVE" | "DISCONNECTED";
					}[]
				>`
					SELECT account.id, account.external_account, account.display_name,
						account.owner_type, account.provider_id, account.provider_release_id,
						account.status, release.status AS release_status,
						credential.scope_json IS NOT NULL AS credential_scope_known,
						COALESCE(
							jsonb_agg(action.id ORDER BY action.id)
								FILTER (WHERE action.id IS NOT NULL),
							'[]'::jsonb
						) AS action_version_ids
					FROM connection_accounts account
					JOIN connection_provider_releases release
						ON release.id = account.provider_release_id
					LEFT JOIN connection_action_versions action
						ON action.provider_release_id = account.provider_release_id
						AND action.status = 'PUBLISHED'
					LEFT JOIN connection_credential_versions credential
						ON credential.connection_id = account.id
						AND credential.status = 'ACTIVE'
					LEFT JOIN connection_shared_scopes shared_scope
						ON shared_scope.id = account.shared_scope_id
					LEFT JOIN connection_shared_scope_principals membership
						ON membership.shared_scope_id = shared_scope.id
						AND membership.principal_id = ${principalId}
						AND membership.status = 'ACTIVE'
					WHERE (
						account.owner_type = 'PERSONAL'
						AND account.owner_principal_id = ${principalId}
					) OR (
						account.owner_type = 'SHARED'
						AND shared_scope.state = 'ACTIVE'
						AND membership.principal_id IS NOT NULL
					)
					GROUP BY account.id, account.external_account, account.display_name,
						account.owner_type, account.provider_id, account.provider_release_id,
						account.status, release.status,
						credential.scope_json
					ORDER BY account.display_name, account.id
				`,
				this.sql<
					{
						description: string;
						effect: "READ" | "WRITE";
						id: string;
						input_schema: unknown;
						name: ActionName;
						provider_release_id: string;
						required_scopes: unknown;
					}[]
				>`
					SELECT action.id, action.name, action.description, action.effect,
							action.input_schema, action.required_scopes,
							action.provider_release_id
					FROM connection_action_versions action
					JOIN connection_provider_releases release
						ON release.id = action.provider_release_id
					WHERE action.status = 'PUBLISHED' AND release.status = 'PUBLISHED'
					ORDER BY action.id
				`,
				this.sql<
					{
						action_version_ids: unknown;
						actions: unknown;
						connection_id: string;
						connection_display_name: string;
						consumer_id: string;
						consumer_name: string;
						external_account: string;
						id: string;
						provider_id: string;
						status:
							| "ACTIVE"
							| "PAUSED_CONNECTION"
							| "PAUSED_CREDENTIAL"
							| "REPLACED"
							| "REVOKED"
							| "TERMINATED";
					}[]
				>`
					SELECT stored_grant.id, stored_grant.connection_id,
						stored_grant.consumer_id, stored_grant.status,
						account.provider_id,
						account.display_name AS connection_display_name,
						account.external_account,
						consumer.display_name AS consumer_name,
						COALESCE(
							jsonb_agg(grant_action.action_version_id ORDER BY grant_action.action_version_id)
								FILTER (WHERE grant_action.action_version_id IS NOT NULL),
							'[]'::jsonb
						) AS action_version_ids
						, COALESCE(
							jsonb_agg(
								jsonb_build_object(
									'id', action.id,
									'name', action.name,
									'effect', action.effect
								) ORDER BY action.id
							) FILTER (WHERE action.id IS NOT NULL),
							'[]'::jsonb
						) AS actions
					FROM connection_grants stored_grant
					JOIN connection_consumers consumer ON consumer.id = stored_grant.consumer_id
					JOIN connection_accounts account ON account.id = stored_grant.connection_id
					LEFT JOIN connection_grant_actions grant_action
						ON grant_action.grant_id = stored_grant.id
					LEFT JOIN connection_action_versions action
						ON action.id = grant_action.action_version_id
					WHERE stored_grant.principal_id = ${principalId}
					GROUP BY stored_grant.id, consumer.display_name,
						account.provider_id, account.display_name, account.external_account
					ORDER BY stored_grant.id
				`,
				this.sql<{ id: string; name: string }[]>`
					SELECT DISTINCT consumer.id, consumer.display_name AS name
					FROM connection_consumers consumer
					JOIN connection_consumer_instances instance
						ON instance.consumer_id = consumer.id
					WHERE instance.principal_id = ${principalId}
						AND instance.status = 'ACTIVE'
						AND consumer.status = 'ACTIVE'
					ORDER BY name, id
				`,
				this.sql<
					{
						action_name: ActionName;
						connection_id: string;
						created_at: Date;
						grant_id: string;
						id: string;
						result: unknown;
						status: CallStatus;
					}[]
				>`
					SELECT call.id, call.connection_id, call.grant_id, call.status,
						call.result, call.created_at, action.name AS action_name
					FROM connection_calls call
					JOIN connection_action_versions action ON action.id = call.action_version_id
					WHERE call.principal_id = ${principalId}
					ORDER BY call.created_at DESC LIMIT 100
				`,
			]);
		if (!principal[0]) forbidden();
		return {
			actions: actions
				.filter((action) => currentReleaseIds.has(action.provider_release_id))
				.map(actionDefinition),
			calls: calls.map((call) => ({
				action: call.action_name,
				callId: call.id,
				connectionId: call.connection_id,
				createdAt: call.created_at.toISOString(),
				grantId: call.grant_id,
				result: asRecord(call.result),
				status: call.status,
			})),
			connections: connections.map((connection) => ({
				actionVersionIds:
					connection.release_status === "PUBLISHED" &&
					connection.credential_scope_known &&
					Array.isArray(connection.action_version_ids)
						? connection.action_version_ids.filter(
								(value): value is string => typeof value === "string",
							)
						: [],
				displayName: connection.display_name,
				externalAccount: connection.external_account,
				id: connection.id,
				ownerType: connection.owner_type,
				providerId: connection.provider_id,
				requiresReconnect:
					connection.release_status !== "PUBLISHED" ||
					!connection.credential_scope_known ||
					this.publishedProviderReleaseIds.get(connection.provider_id) !==
						connection.provider_release_id,
				status: connection.status,
			})),
			consumers,
			grants: grants.map((grant) => ({
				actions: Array.isArray(grant.actions)
					? grant.actions.filter(
							(
								value,
							): value is {
								effect: "READ" | "WRITE";
								id: string;
								name: ActionName;
							} =>
								typeof value === "object" &&
								value !== null &&
								typeof (value as { id?: unknown }).id === "string" &&
								typeof (value as { name?: unknown }).name === "string" &&
								((value as { effect?: unknown }).effect === "READ" ||
									(value as { effect?: unknown }).effect === "WRITE"),
						)
					: [],
				actionVersionIds: Array.isArray(grant.action_version_ids)
					? grant.action_version_ids.filter(
							(value): value is string => typeof value === "string",
						)
					: [],
				connectionId: grant.connection_id,
				connectionDisplayName: grant.connection_display_name,
				consumerId: grant.consumer_id,
				consumerName: grant.consumer_name,
				externalAccount: grant.external_account,
				id: grant.id,
				providerId: grant.provider_id,
				status: grant.status,
			})),
			principal: {
				displayName: principal[0].display_name,
				id: principal[0].id,
			},
		};
	}

	async disconnectSharedConnection(input: {
		actorPrincipalId: string;
		connectionId: string;
	}) {
		await this.sql.begin(async (sql) => {
			await this.requireConnectionAdministrator(sql, input.actorPrincipalId);
			await sql`
				SELECT root.id
				FROM connection_authorization_roots root
				JOIN connection_grants active_grant
					ON active_grant.id = root.current_grant_id
					AND active_grant.root_id = root.id
				WHERE active_grant.connection_id = ${input.connectionId}
					AND active_grant.status = 'ACTIVE'
				ORDER BY root.id
				FOR UPDATE OF root
			`;
			await sql`
				SELECT active_grant.id
				FROM connection_authorization_roots root
				JOIN connection_grants active_grant
					ON active_grant.id = root.current_grant_id
					AND active_grant.root_id = root.id
				WHERE active_grant.connection_id = ${input.connectionId}
					AND active_grant.status = 'ACTIVE'
				ORDER BY root.id
				FOR UPDATE OF active_grant
			`;
			const [account] = await sql<{ id: string }[]>`
				UPDATE connection_accounts SET
					status = 'DISCONNECTED', revision = revision + 1,
					execution_fence = execution_fence + 1
				WHERE id = ${input.connectionId}
					AND owner_type = 'SHARED'
					AND status = 'ACTIVE'
				RETURNING id
			`;
			if (!account) forbidden();
			await sql`
				UPDATE connection_credential_versions
				SET status = 'REVOKED', revision = revision + 1
				WHERE connection_id = ${input.connectionId} AND status = 'ACTIVE'
			`;
			await sql`
				UPDATE connection_grants
				SET status = 'PAUSED_CONNECTION'
				WHERE connection_id = ${input.connectionId} AND status = 'ACTIVE'
			`;
			await sql`
				UPDATE connection_authorization_roots root
				SET current_grant_id = NULL, fence = fence + 1
				WHERE EXISTS (
					SELECT 1 FROM connection_grants stored_grant
					WHERE stored_grant.id = root.current_grant_id
						AND stored_grant.connection_id = ${input.connectionId}
				)
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.actorPrincipalId}, 'SHARED_CONNECTION_DISCONNECTED',
					${sql.json({ connectionId: input.connectionId })}
				)
			`;
		});
	}

	async disconnectConnection(input: {
		connectionId: string;
		principalId: string;
	}) {
		await this.sql.begin(async (sql) => {
			const [principal] = await sql<{ id: string }[]>`
					SELECT id FROM connection_principals
					WHERE id = ${input.principalId} AND status = 'ACTIVE'
					FOR UPDATE
				`;
			if (!principal) forbidden();
			await sql`
					SELECT root.id
					FROM connection_authorization_roots root
					JOIN connection_grants active_grant
						ON active_grant.id = root.current_grant_id
						AND active_grant.root_id = root.id
					WHERE root.principal_id = ${input.principalId}
						AND active_grant.connection_id = ${input.connectionId}
						AND active_grant.status = 'ACTIVE'
					ORDER BY root.id
					FOR UPDATE OF root
				`;
			await sql`
					SELECT active_grant.id
					FROM connection_authorization_roots root
					JOIN connection_grants active_grant
						ON active_grant.id = root.current_grant_id
						AND active_grant.root_id = root.id
					WHERE root.principal_id = ${input.principalId}
						AND active_grant.connection_id = ${input.connectionId}
						AND active_grant.status = 'ACTIVE'
					ORDER BY root.id
					FOR UPDATE OF active_grant
				`;
			const [account] = await sql<{ id: string }[]>`
					UPDATE connection_accounts
					SET status = 'DISCONNECTED', revision = revision + 1,
						execution_fence = execution_fence + 1
				WHERE id = ${input.connectionId}
					AND owner_type = 'PERSONAL'
					AND owner_principal_id = ${input.principalId}
					AND status = 'ACTIVE'
				RETURNING id
			`;
			if (!account) forbidden();
			await sql`
					UPDATE connection_credential_versions
					SET status = 'REVOKED', revision = revision + 1
				WHERE connection_id = ${input.connectionId} AND status = 'ACTIVE'
			`;
			const grants = await sql<{ id: string; root_id: string }[]>`
				UPDATE connection_grants SET status = 'REVOKED'
				WHERE connection_id = ${input.connectionId} AND status = 'ACTIVE'
				RETURNING id, root_id
			`;
			for (const grant of grants) {
				await sql`
					UPDATE connection_authorization_roots
					SET current_grant_id = NULL, status = 'TERMINATED', fence = fence + 1
					WHERE id = ${grant.root_id} AND current_grant_id = ${grant.id}
				`;
			}
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.principalId}, 'CONNECTION_DISCONNECTED',
					${sql.json({ connectionId: input.connectionId })}
				)
			`;
		});
	}

	async revokeGrant(input: { grantId: string; principalId: string }) {
		await this.sql.begin(async (sql) => {
			const [principal] = await sql<{ id: string }[]>`
					SELECT id FROM connection_principals
					WHERE id = ${input.principalId} AND status = 'ACTIVE'
					FOR UPDATE
				`;
			if (!principal) forbidden();
			const [root] = await sql<{ id: string }[]>`
					SELECT root.id
					FROM connection_authorization_roots root
					JOIN connection_grants stored_grant
						ON stored_grant.root_id = root.id
					WHERE stored_grant.id = ${input.grantId}
						AND stored_grant.principal_id = ${input.principalId}
						AND stored_grant.status = 'ACTIVE'
					FOR UPDATE OF root
				`;
			if (!root) forbidden();
			const [grant] = await sql<{ id: string; root_id: string }[]>`
				UPDATE connection_grants SET status = 'REVOKED'
				WHERE id = ${input.grantId}
					AND principal_id = ${input.principalId}
					AND status = 'ACTIVE'
				RETURNING id, root_id
			`;
			if (!grant || grant.root_id !== root.id) forbidden();
			await sql`
				UPDATE connection_authorization_roots
				SET current_grant_id = NULL, status = 'TERMINATED', fence = fence + 1
				WHERE id = ${grant.root_id} AND current_grant_id = ${grant.id}
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.principalId}, 'GRANT_REVOKED',
					${sql.json({ grantId: input.grantId })}
				)
			`;
		});
	}

	async createCall(input: {
		action: ActionName;
		actionVersionId?: string;
		argsHash: string;
		idempotencyKey?: string;
		input: Record<string, unknown>;
		invocation: InvocationContext;
	}) {
		await this.verifyInvocation({ ...input.invocation, action: input.action });
		return this.sql.begin(async (sql) => {
			const [action] = await sql<{ effect: "READ" | "WRITE"; id: string }[]>`
				SELECT action.id, action.effect
				FROM connection_grant_actions grant_action
				JOIN connection_action_versions action ON action.id = grant_action.action_version_id
				WHERE grant_action.grant_id = ${input.invocation.grantId}
					AND action.name = ${input.action}
					AND action.status = 'PUBLISHED'
					AND (${input.actionVersionId ?? null}::text IS NULL
						OR action.id = ${input.actionVersionId ?? ""})
			`;
			if (!action) forbidden();
			const callId = `call-${randomUUID()}`;
			const [row] = await sql<StoredCallRow[]>`
					INSERT INTO connection_calls (
					id, principal_id, consumer_id, instance_id, grant_id, connection_id,
					credential_version_id, action_version_id, request_hash, request_input,
					idempotency_key, status, actor_key
				)
				VALUES (
					${callId}, ${input.invocation.principalId}, ${input.invocation.consumerId},
					${input.invocation.instanceId}, ${input.invocation.grantId},
					${input.invocation.connectionId}, ${input.invocation.credentialVersionId},
					${action.id}, ${input.argsHash}, ${sql.json(input.input as postgres.JSONValue)},
						${input.idempotencyKey ?? null}, 'AUTHORIZED',
						${input.invocation.actorKey ?? null}
					)
					ON CONFLICT (
						principal_id, consumer_id, COALESCE(actor_key, ''), idempotency_key
					) WHERE idempotency_key IS NOT NULL DO NOTHING
					RETURNING id, principal_id, consumer_id, instance_id, grant_id,
					connection_id, credential_version_id, request_hash, idempotency_key,
					status, result, created_at, actor_key, ${input.action}::text AS action_name
			`;
			if (!row) {
				const existing = input.idempotencyKey
					? await this.findIdempotentCall({
							action: input.action,
							idempotencyKey: input.idempotencyKey,
							invocation: input.invocation,
						})
					: undefined;
				if (!existing) throw new Error("Connection call was not created");
				return { call: existing, created: false };
			}
			if (action.effect === "WRITE") {
				const effectId = `effect-${randomUUID()}`;
				await sql`
					INSERT INTO connection_effects (id, call_id, status)
					VALUES (${effectId}, ${callId}, 'PREPARED')
				`;
				await sql`
					INSERT INTO connection_dispatches (id, effect_id, status)
					VALUES (${`dispatch-${randomUUID()}`}, ${effectId}, 'PENDING')
				`;
			}
			await sql`
				INSERT INTO connection_audit_records (principal_id, call_id, event, detail)
				VALUES (
					${input.invocation.principalId}, ${callId}, 'CALL_AUTHORIZED',
					${sql.json({ action: input.action, consumerId: input.invocation.consumerId })}
				)
			`;
			return { call: storedCall(row), created: true };
		});
	}

	async findIdempotentCall(input: {
		action: ActionName;
		idempotencyKey: string;
		invocation: InvocationContext;
	}) {
		const [row] = await this.sql<StoredCallRow[]>`
			SELECT call.id, call.principal_id, call.consumer_id, call.instance_id,
				call.grant_id, call.connection_id, call.credential_version_id,
				call.request_hash, call.idempotency_key, call.status, call.result,
				call.created_at, call.actor_key, action.name AS action_name
			FROM connection_calls call
			JOIN connection_action_versions action ON action.id = call.action_version_id
			WHERE call.principal_id = ${input.invocation.principalId}
				AND call.consumer_id = ${input.invocation.consumerId}
				AND COALESCE(call.actor_key, '') = ${input.invocation.actorKey ?? ""}
				AND call.idempotency_key = ${input.idempotencyKey}
				AND action.name = ${input.action}
		`;
		if (!row) return undefined;
		await this.verifyInvocation({ ...input.invocation, action: input.action });
		return storedCall(row);
	}

	async startDispatch(input: {
		action: ActionName;
		callId: string;
		invocation: InvocationContext;
	}) {
		const rows = await this.sql<{ id: string }[]>`
			WITH authorized AS (
				SELECT dispatch.id
				FROM connection_dispatches dispatch
				JOIN connection_effects effect ON dispatch.effect_id = effect.id
				JOIN connection_calls call ON effect.call_id = call.id
				JOIN connection_grants active_grant ON active_grant.id = call.grant_id
				JOIN connection_authorization_roots root ON root.id = active_grant.root_id
					JOIN connection_consumers consumer ON consumer.id = call.consumer_id
					JOIN connection_consumer_action_declarations declaration
						ON declaration.id = active_grant.declaration_id
					JOIN connection_consumer_declared_actions declared
						ON declared.declaration_id = declaration.id
					JOIN connection_consumer_instances instance ON instance.id = call.instance_id
				JOIN connection_principals principal ON principal.id = call.principal_id
				JOIN connection_accounts account ON account.id = call.connection_id
				JOIN connection_credential_versions credential
					ON credential.id = call.credential_version_id
				JOIN connection_grant_actions grant_action
					ON grant_action.grant_id = active_grant.id
				JOIN connection_action_versions action
					ON action.id = grant_action.action_version_id
				JOIN connection_provider_releases release
					ON release.id = action.provider_release_id
				WHERE dispatch.effect_id = effect.id
				AND effect.call_id = call.id
				AND effect.status = 'PREPARED'
				AND call.id = ${input.callId}
				AND call.status = 'AUTHORIZED'
				AND call.principal_id = ${input.invocation.principalId}
				AND call.consumer_id = ${input.invocation.consumerId}
				AND call.instance_id = ${input.invocation.instanceId}
				AND call.grant_id = ${input.invocation.grantId}
				AND call.connection_id = ${input.invocation.connectionId}
				AND call.credential_version_id = ${input.invocation.credentialVersionId}
				AND COALESCE(call.actor_key, '') = ${input.invocation.actorKey ?? ""}
				AND active_grant.id = call.grant_id AND active_grant.status = 'ACTIVE'
				AND active_grant.principal_id = call.principal_id
				AND active_grant.consumer_id = call.consumer_id
				AND active_grant.connection_id = call.connection_id
				AND active_grant.actor_key = COALESCE(call.actor_key, '')
				AND root.id = active_grant.root_id
				AND root.current_grant_id = active_grant.id
				AND root.status = 'ACTIVE'
					AND consumer.id = call.consumer_id AND consumer.status = 'ACTIVE'
					AND declaration.consumer_id = call.consumer_id
					AND declaration.status IN ('PUBLISHED', 'SUPERSEDED')
				AND instance.id = call.instance_id
				AND instance.consumer_id = call.consumer_id
				AND instance.principal_id = call.principal_id
				AND instance.status = 'ACTIVE'
				AND principal.id = call.principal_id AND principal.status = 'ACTIVE'
				AND account.id = call.connection_id
				AND account.provider_id = active_grant.provider_id
					AND account.provider_release_id = active_grant.provider_release_id
					AND account.revision = active_grant.connection_revision
					AND account.execution_fence = active_grant.connection_execution_fence
					AND account.status = 'ACTIVE'
					AND (
						(
							account.owner_type = 'PERSONAL'
							AND account.owner_principal_id = call.principal_id
						) OR (
							account.owner_type = 'SHARED'
							AND EXISTS (
								SELECT 1 FROM connection_shared_scopes shared_scope
								JOIN connection_shared_scope_principals membership
									ON membership.shared_scope_id = shared_scope.id
									AND membership.principal_id = call.principal_id
									AND membership.status = 'ACTIVE'
								WHERE shared_scope.id = account.shared_scope_id
									AND shared_scope.state = 'ACTIVE'
							)
						)
					)
					AND credential.id = call.credential_version_id
					AND credential.id = active_grant.credential_version_id
					AND credential.connection_id = account.id
					AND credential.revision = active_grant.credential_revision
					AND credential.status = 'ACTIVE'
				AND grant_action.grant_id = active_grant.id
				AND action.id = grant_action.action_version_id
					AND action.id = call.action_version_id
					AND declared.action_version_id = action.id
				AND action.name = ${input.action}
				AND action.status = 'PUBLISHED'
				AND action.provider_release_id = account.provider_release_id
				AND release.id = action.provider_release_id
				AND release.status = 'PUBLISHED'
					AND dispatch.status = 'PENDING'
					FOR UPDATE OF dispatch, effect, call, active_grant, root, consumer,
						declaration, declared, instance, principal, account, credential,
						grant_action, action, release
			)
			UPDATE connection_dispatches dispatch SET status = 'SUBMISSION_STARTED'
			FROM authorized
			WHERE dispatch.id = authorized.id AND dispatch.status = 'PENDING'
			RETURNING dispatch.id
		`;
		if (rows.length !== 1) forbidden();
	}

	async setCallResult(input: {
		callId: string;
		result?: Record<string, unknown>;
		status: CallStatus;
	}) {
		await this.sql.begin(async (sql) => {
			const [call] = await sql<
				{ effect: "READ" | "WRITE"; principal_id: string }[]
			>`
				SELECT action.effect, call.principal_id
				FROM connection_calls call
				JOIN connection_action_versions action ON action.id = call.action_version_id
				WHERE call.id = ${input.callId}
				FOR UPDATE OF call
			`;
			if (!call) return;
			if (call.effect === "WRITE") {
				const effectStatus =
					input.status === "DENIED_LOCAL" ? "FAILED" : input.status;
				await sql`
					UPDATE connection_dispatches dispatch
					SET status = ${effectStatus}
					FROM connection_effects effect
					WHERE dispatch.effect_id = effect.id
						AND effect.call_id = ${input.callId}
						AND dispatch.status IN ('PENDING', 'SUBMISSION_STARTED')
				`;
				await sql`
					UPDATE connection_effects
					SET status = ${effectStatus}
					WHERE call_id = ${input.callId} AND status = 'PREPARED'
				`;
			}
			await sql`
				UPDATE connection_calls
				SET status = ${input.status}, result = ${
					input.result ? sql.json(input.result as postgres.JSONValue) : null
				}
				WHERE id = ${input.callId}
			`;
			if (input.status === "UNCERTAIN") {
				await sql`
					INSERT INTO connection_reconciliation_jobs (call_id, status)
					VALUES (${input.callId}, 'PENDING')
					ON CONFLICT (call_id) DO NOTHING
				`;
			}
			await sql`
				INSERT INTO connection_audit_records (principal_id, call_id, event, detail)
				VALUES (
					${call.principal_id}, ${input.callId}, ${`CALL_${input.status}`},
					'{}'::jsonb
				)
			`;
		});
	}

	async claimReconciliationJob(): Promise<ReconciliationJob | undefined> {
		return this.sql.begin(async (sql) => {
			await sql`
				UPDATE connection_reconciliation_jobs
				SET status = 'PENDING', lease_id = NULL, leased_at = NULL,
					lease_expires_at = NULL, updated_at = now()
				WHERE status = 'LEASED' AND lease_expires_at <= now()
			`;
			const leaseId = `lease-${randomUUID()}`;
			const [row] = await sql<
				(InvocationRow & {
					action_version_id: string;
					action_name: ActionName;
					call_id: string;
					request_input: unknown;
				})[]
			>`
				WITH pending AS (
					SELECT call_id FROM connection_reconciliation_jobs
					WHERE status = 'PENDING' AND next_attempt_at <= now()
					ORDER BY next_attempt_at, call_id
					FOR UPDATE SKIP LOCKED LIMIT 1
				), leased AS (
					UPDATE connection_reconciliation_jobs job
					SET status = 'LEASED', lease_id = ${leaseId}, leased_at = now(),
						lease_expires_at = now() + interval '30 seconds',
						attempts = attempts + 1, updated_at = now()
					FROM pending WHERE job.call_id = pending.call_id
					RETURNING job.call_id
				)
				SELECT call.id AS call_id, call.principal_id, call.consumer_id,
					call.instance_id, call.grant_id, call.connection_id,
					call.credential_version_id, call.actor_key, call.request_input,
					account.provider_id, account.provider_release_id,
					action.id AS action_version_id, action.name AS action_name
				FROM leased
				JOIN connection_calls call ON call.id = leased.call_id
				JOIN connection_accounts account ON account.id = call.connection_id
				JOIN connection_action_versions action ON action.id = call.action_version_id
			`;
			if (!row) return undefined;
			return {
				action: row.action_name,
				actionVersionId: row.action_version_id,
				callId: row.call_id,
				input: asRecord(row.request_input) ?? {},
				invocation: invocation(row),
				leaseId,
			};
		});
	}

	async completeReconciliationJob(input: {
		callId: string;
		leaseId: string;
		result: Record<string, unknown>;
	}) {
		await this.sql.begin(async (sql) => {
			const [job] = await sql<{ call_id: string }[]>`
				SELECT call_id FROM connection_reconciliation_jobs
				WHERE call_id = ${input.callId} AND lease_id = ${input.leaseId}
					AND status = 'LEASED' AND lease_expires_at > now()
				FOR UPDATE
			`;
			if (!job) return;
			await sql`
				UPDATE connection_dispatches dispatch SET status = 'SUCCEEDED'
				FROM connection_effects effect
				WHERE dispatch.effect_id = effect.id AND effect.call_id = ${input.callId}
					AND dispatch.status = 'UNCERTAIN'
			`;
			await sql`
				UPDATE connection_effects SET status = 'SUCCEEDED'
				WHERE call_id = ${input.callId} AND status = 'UNCERTAIN'
			`;
			await sql`
				UPDATE connection_calls
					SET status = 'SUCCEEDED', result = ${sql.json(input.result as postgres.JSONValue)}
				WHERE id = ${input.callId} AND status = 'UNCERTAIN'
			`;
			await sql`
				UPDATE connection_reconciliation_jobs
				SET status = 'SUCCEEDED', updated_at = now()
				WHERE call_id = ${input.callId} AND lease_id = ${input.leaseId}
			`;
		});
	}

	async rescheduleReconciliationJob(input: {
		callId: string;
		leaseId: string;
		reason: string;
	}) {
		await this.sql`
			UPDATE connection_reconciliation_jobs
			SET status = 'PENDING', lease_id = NULL, leased_at = NULL,
				lease_expires_at = NULL, next_attempt_at = now() + interval '30 seconds',
					reason = ${input.reason.slice(0, 500)}, updated_at = now()
				WHERE call_id = ${input.callId} AND lease_id = ${input.leaseId}
					AND status = 'LEASED' AND lease_expires_at > now()
			`;
	}
}
