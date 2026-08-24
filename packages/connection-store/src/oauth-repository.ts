import { createHash, randomUUID } from "node:crypto";
import {
	type BrowserSessionIdentity,
	type ConnectionOAuthRepository,
	type OAuthAuthorizationRecord,
	type OAuthClientRegistration,
	OAuthProtocolError,
	type OAuthTokenIdentity,
	oauthAuthorizationRequestUnavailableMessage,
	verifyPkce,
} from "@agent-infra/connection-core";
import postgres from "postgres";

type IdentityRow = {
	client_id: string;
	consumer_id: string;
	identity_reference: string;
	identity_status: string;
	instance_id: string;
	instance_status: string;
	last_verified_at: Date;
	principal_id: string;
	principal_status: string;
	recovery_generation: string;
	resource: string | null;
	session_recovery_generation: string;
	session_id: string;
	session_status: string;
};

type BrowserSessionRow = {
	display_name: string;
	email: string | null;
	identity_issuer: string;
	identity_reference: string;
	last_verified_at: Date;
	principal_id: string;
	recovery_generation: string;
	session_recovery_generation: string;
};

function hash(value: string) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalidGrant(): never {
	throw new OAuthProtocolError("invalid_grant", "Invalid or expired grant");
}

function invalidToken(): never {
	throw new OAuthProtocolError(
		"invalid_token",
		"Invalid or expired token",
		401,
	);
}

function tokenIdentity(row: IdentityRow): OAuthTokenIdentity {
	return {
		consumerId: row.consumer_id,
		identityReference: row.identity_reference,
		instanceId: row.instance_id,
		lastVerifiedAt: row.last_verified_at,
		principalId: row.principal_id,
		recoveryGeneration: row.session_recovery_generation,
		resource: row.resource,
	};
}

function activeIdentity(row: IdentityRow) {
	return (
		row.session_status === "ACTIVE" &&
		row.instance_status === "ACTIVE" &&
		row.principal_status === "ACTIVE" &&
		row.identity_status === "ACTIVE"
	);
}

function browserSessionIdentity(
	row: BrowserSessionRow,
): BrowserSessionIdentity {
	return {
		displayName: row.display_name,
		email: row.email,
		identityIssuer: row.identity_issuer,
		identityReference: row.identity_reference,
		lastVerifiedAt: row.last_verified_at,
		principalId: row.principal_id,
		recoveryGeneration: row.session_recovery_generation,
	};
}

type PrincipalIdentityInput = {
	displayName: string;
	email: string | null;
	identityIssuer: string;
	identityReference: string;
	identitySubjectHash: string;
	legacyIdentitySubjectHash: string;
	principalId: string;
};

const legacyPrincipalIdPattern = /^principal-[0-9a-f]{64}$/;

async function upsertPrincipalIdentity(
	sql: postgres.TransactionSql,
	input: PrincipalIdentityInput,
) {
	await sql`
		SELECT pg_advisory_xact_lock(
			hashtextextended(${input.identitySubjectHash}, 0)
		)
	`;
	const mappings = await sql<
		{ identity_subject_hash: string; principal_id: string }[]
	>`
		SELECT identity_subject_hash, principal_id
		FROM connection_principal_identities
		WHERE identity_issuer = ${input.identityIssuer}
			AND (
				identity_subject_hash = ${input.identitySubjectHash}
				OR identity_subject_hash = ${input.legacyIdentitySubjectHash}
			)
		FOR UPDATE
	`;
	const principalIds = new Set(mappings.map((mapping) => mapping.principal_id));
	if (principalIds.size > 1) {
		throw new OAuthProtocolError("access_denied", "Authentication failed", 401);
	}
	const mapping = mappings[0];
	let principalId = mapping?.principal_id ?? input.principalId;
	if (mapping && legacyPrincipalIdPattern.test(principalId)) {
		const [remapped] = await sql<{ id: string }[]>`
			UPDATE connection_principals SET id = ${input.principalId}
			WHERE id = ${principalId}
			RETURNING id
		`;
		if (!remapped) {
			throw new OAuthProtocolError(
				"access_denied",
				"Authentication failed",
				401,
			);
		}
		principalId = remapped.id;
	}

	await sql`
		INSERT INTO connection_principals (
			id, display_name, email, status, last_verified_at, updated_at
		)
		VALUES (
			${principalId}, ${input.displayName}, ${input.email}, 'ACTIVE', now(), now()
		)
		ON CONFLICT (id) DO UPDATE SET
			display_name = EXCLUDED.display_name,
			email = EXCLUDED.email,
			status = 'ACTIVE',
			last_verified_at = now(),
			updated_at = now()
	`;
	if (
		mapping &&
		mapping.identity_subject_hash === input.legacyIdentitySubjectHash
	) {
		await sql`
			UPDATE connection_principal_identities SET
				identity_subject_hash = ${input.identitySubjectHash},
				identity_reference = ${input.identityReference},
				status = 'ACTIVE',
				verified_at = now(),
				updated_at = now()
			WHERE identity_issuer = ${input.identityIssuer}
				AND identity_subject_hash = ${input.legacyIdentitySubjectHash}
				AND principal_id = ${principalId}
		`;
	} else {
		await sql`
			INSERT INTO connection_principal_identities (
				identity_issuer, identity_subject_hash, principal_id,
				identity_reference, status, verified_at, updated_at
			)
			VALUES (
				${input.identityIssuer}, ${input.identitySubjectHash}, ${principalId},
				${input.identityReference}, 'ACTIVE', now(), now()
			)
			ON CONFLICT (identity_issuer, identity_subject_hash) DO UPDATE SET
				identity_reference = EXCLUDED.identity_reference,
				status = 'ACTIVE',
				verified_at = now(),
				updated_at = now()
		`;
	}
	return principalId;
}

export class PostgresConnectionOAuthRepository
	implements ConnectionOAuthRepository
{
	private readonly sql;

	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 10 });
	}

	async close() {
		await this.sql.end();
	}

	async registerClient(client: OAuthClientRegistration) {
		await this.sql.begin(async (sql) => {
			const [consumer] = await sql<{ status: string }[]>`
					INSERT INTO connection_consumers (id, display_name, status)
					VALUES (${client.consumerId}, ${client.consumerName}, 'ACTIVE')
					ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
					RETURNING status
				`;
			if (consumer?.status !== "ACTIVE") {
				throw new OAuthProtocolError(
					"invalid_request",
					"OAuth client registration is disabled",
				);
			}
			await sql`
					INSERT INTO connection_consumer_instances (
						id, consumer_id, kind, auth_subject, status
					)
					VALUES (
						${client.instanceId}, ${client.consumerId}, 'DEVICE',
						${`oauth-client:${hash(client.clientId)}`}, 'ACTIVE'
					)
				`;
			await sql`
					INSERT INTO connection_oauth_clients (
						client_id, client_name, consumer_id, instance_id, redirect_uris, status
					)
					VALUES (
						${client.clientId}, ${client.clientName}, ${client.consumerId},
						${client.instanceId}, ${sql.json(client.redirectUris)}, 'ACTIVE'
					)
				`;
		});
	}

	async findClient(clientId: string) {
		const [row] = await this.sql<
			{
				client_id: string;
				client_name: string;
				consumer_id: string;
				consumer_name: string;
				instance_id: string;
				redirect_uris: unknown;
			}[]
		>`
			SELECT
				client.client_id,
				client.client_name,
				client.consumer_id,
				consumer.display_name AS consumer_name,
				client.instance_id,
				client.redirect_uris
			FROM connection_oauth_clients client
			JOIN connection_consumers consumer ON consumer.id = client.consumer_id
			JOIN connection_consumer_instances instance ON instance.id = client.instance_id
			WHERE client.client_id = ${clientId}
				AND client.status = 'ACTIVE'
				AND consumer.status = 'ACTIVE'
				AND instance.status = 'ACTIVE'
		`;
		if (!row || !Array.isArray(row.redirect_uris)) return undefined;
		if (!row.redirect_uris.every((uri) => typeof uri === "string"))
			return undefined;
		return {
			clientId: row.client_id,
			clientName: row.client_name,
			consumerId: row.consumer_id,
			consumerName: row.consumer_name,
			instanceId: row.instance_id,
			redirectUris: row.redirect_uris,
		};
	}

	async createBrowserSession(input: {
		displayName: string;
		email: string | null;
		expiresAt: Date;
		identityIssuer: string;
		identityReference: string;
		identitySubjectHash: string;
		legacyIdentitySubjectHash: string;
		principalId: string;
		sessionHash: string;
		sessionId: string;
	}) {
		return this.sql.begin(async (sql) => {
			const principalId = await upsertPrincipalIdentity(sql, input);
			const [recovery] = await sql<{ generation: string }[]>`
				SELECT generation FROM connection_recovery_control
			`;
			if (!recovery) {
				throw new Error("Connection recovery control is unavailable");
			}
			await sql`
				INSERT INTO connection_browser_sessions (
					id, session_hash, principal_id, identity_issuer,
					recovery_generation, expires_at
				)
				VALUES (
					${input.sessionId}, ${input.sessionHash}, ${principalId},
					${input.identityIssuer}, ${recovery.generation}, ${input.expiresAt}
				)
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${principalId},
					'BROWSER_SESSION_CREATED',
					jsonb_build_object('browserSessionId', ${input.sessionId}::text)
				)
			`;
			return browserSessionIdentity(
				await this.requireBrowserSession(sql, input.sessionHash),
			);
		});
	}

	async resolveBrowserSession(sessionHash: string) {
		return this.sql.begin(async (sql) =>
			browserSessionIdentity(
				await this.requireBrowserSession(sql, sessionHash),
			),
		);
	}

	async issuePersonalAccessToken(input: {
		browserSessionHash: string;
		consumerId: string;
		consumerName: string;
		instanceId: string;
		name: string;
		tokenHash: string;
		tokenId: string;
		ttlMs: number;
	}) {
		return this.sql.begin(async (sql) => {
			const browserSession = await this.requireBrowserSession(
				sql,
				input.browserSessionHash,
			);
			const principalId = browserSession.principal_id;
			const [consumer] = await sql<{ status: string }[]>`
				INSERT INTO connection_consumers (id, display_name, status)
				VALUES (${input.consumerId}, ${input.consumerName}, 'ACTIVE')
				ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
				RETURNING status
			`;
			if (consumer?.status !== "ACTIVE") {
				throw new OAuthProtocolError(
					"access_denied",
					"Authentication failed",
					401,
				);
			}
			await sql`
				INSERT INTO connection_consumer_instances (
					id, consumer_id, kind, auth_subject, status, principal_id, last_seen_at
				)
				VALUES (
						${input.instanceId}, ${input.consumerId}, 'TOKEN',
					${`pat:${input.tokenHash}`}, 'ACTIVE', ${principalId}, now()
				)
			`;
			const [recovery] = await sql<{ generation: string }[]>`
				SELECT generation FROM connection_recovery_control
			`;
			if (!recovery) {
				throw new Error("Connection recovery control is unavailable");
			}
			const [token] = await sql<{ expires_at: Date }[]>`
				INSERT INTO connection_personal_access_tokens (
					id, token_hash, principal_id, consumer_id, instance_id, name,
					recovery_generation, expires_at
				)
				VALUES (
					${input.tokenId}, ${input.tokenHash}, ${principalId},
					${input.consumerId}, ${input.instanceId}, ${input.name},
					${recovery.generation},
					now() + (${input.ttlMs}::bigint * interval '1 millisecond')
				)
				RETURNING expires_at
			`;
			if (!token) throw new Error("Connection PAT was not persisted");
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${principalId},
					'PERSONAL_ACCESS_TOKEN_ISSUED',
					jsonb_build_object(
						'consumerId', ${input.consumerId}::text,
						'consumerInstanceId', ${input.instanceId}::text,
						'tokenId', ${input.tokenId}::text
					)
				)
			`;
			return { expiresAt: token.expires_at };
		});
	}

	async listPersonalAccessTokens(browserSessionHash: string) {
		return this.sql.begin(async (sql) => {
			const session = await this.requireBrowserSession(sql, browserSessionHash);
			const rows = await sql<
				{
					created_at: Date;
					expires_at: Date;
					last_used_at: Date | null;
					name: string;
					status: "ACTIVE" | "EXPIRED" | "REVOKED";
					token_id: string;
				}[]
			>`
				SELECT
					id AS token_id,
					name,
					created_at,
					expires_at,
					last_used_at,
					CASE
						WHEN revoked_at IS NOT NULL THEN 'REVOKED'
						WHEN expires_at <= now() THEN 'EXPIRED'
						ELSE 'ACTIVE'
					END AS status
				FROM connection_personal_access_tokens
				WHERE principal_id = ${session.principal_id}
				ORDER BY created_at DESC, id DESC
			`;
			return rows.map((row) => ({
				createdAt: row.created_at,
				expiresAt: row.expires_at,
				lastUsedAt: row.last_used_at,
				name: row.name,
				status: row.status,
				tokenId: row.token_id,
			}));
		});
	}

	async revokePersonalAccessToken(input: {
		browserSessionHash: string;
		tokenId: string;
	}) {
		await this.sql.begin(async (sql) => {
			const session = await this.requireBrowserSession(
				sql,
				input.browserSessionHash,
			);
			const [token] = await sql<{ instance_id: string }[]>`
				UPDATE connection_personal_access_tokens
				SET revoked_at = now()
				WHERE id = ${input.tokenId}
					AND principal_id = ${session.principal_id}
					AND revoked_at IS NULL
				RETURNING instance_id
			`;
			if (!token) return;
			await sql`
				UPDATE connection_consumer_instances SET status = 'REVOKED'
				WHERE id = ${token.instance_id}
					AND principal_id = ${session.principal_id}
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${session.principal_id},
					'PERSONAL_ACCESS_TOKEN_REVOKED',
					jsonb_build_object(
						'consumerInstanceId', ${token.instance_id}::text,
						'tokenId', ${input.tokenId}::text
					)
				)
			`;
		});
	}

	async revokeBrowserSession(sessionHash: string) {
		await this.sql.begin(async (sql) => {
			const [session] = await sql<{ id: string; principal_id: string }[]>`
				UPDATE connection_browser_sessions
				SET revoked_at = now()
				WHERE session_hash = ${sessionHash} AND revoked_at IS NULL
				RETURNING id, principal_id
			`;
			if (!session) return;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${session.principal_id},
					'BROWSER_SESSION_REVOKED',
					jsonb_build_object('browserSessionId', ${session.id}::text)
				)
			`;
		});
	}

	async createAuthorization(record: OAuthAuthorizationRecord) {
		const authorizations = await this.sql`
			INSERT INTO connection_oauth_authorizations (
				request_id_hash, client_id, consumer_id, instance_id, code_challenge,
				redirect_uri, resource, scope, state, expires_at, recovery_generation
			)
			SELECT
				${hash(record.requestId)}, client.client_id, client.consumer_id,
				client.instance_id, ${record.codeChallenge}, ${record.redirectUri},
				${record.resource}, ${record.scope}, ${record.state}, ${record.expiresAt},
				recovery.generation
			FROM connection_oauth_clients client
			JOIN connection_consumers consumer ON consumer.id = client.consumer_id
			JOIN connection_consumer_instances instance ON instance.id = client.instance_id
			CROSS JOIN connection_recovery_control recovery
			WHERE client.client_id = ${record.clientId}
				AND client.consumer_id = ${record.consumerId}
				AND client.status = 'ACTIVE'
				AND consumer.status = 'ACTIVE'
				AND instance.status = 'ACTIVE'
			RETURNING request_id_hash
		`;
		if (authorizations.length !== 1) {
			throw new OAuthProtocolError(
				"invalid_client",
				"Unknown OAuth client",
				401,
			);
		}
	}

	async requirePendingAuthorization(requestId: string) {
		const [authorization] = await this.sql`
			SELECT request_id_hash
			FROM connection_oauth_authorizations auth
			CROSS JOIN connection_recovery_control recovery
			WHERE request_id_hash = ${hash(requestId)}
				AND approved_at IS NULL
				AND consumed_at IS NULL
				AND expires_at > now()
				AND auth.recovery_generation = recovery.generation
		`;
		if (!authorization) {
			throw new OAuthProtocolError(
				"invalid_request",
				oauthAuthorizationRequestUnavailableMessage,
			);
		}
	}

	async approveAuthorization(input: {
		codeHash: string;
		displayName: string;
		email: string | null;
		identityIssuer: string;
		identityReference: string;
		identitySubjectHash: string;
		legacyIdentitySubjectHash: string;
		principalId: string;
		requestId: string;
	}) {
		return this.sql.begin(async (sql) => {
			const [authorization] = await sql<
				{
					consumer_id: string;
					expires_at: Date;
					instance_id: string;
					redirect_uri: string;
					state: string;
				}[]
			>`
				SELECT consumer_id, instance_id, redirect_uri, state, expires_at
				FROM connection_oauth_authorizations auth
				CROSS JOIN connection_recovery_control recovery
				WHERE request_id_hash = ${hash(input.requestId)}
					AND approved_at IS NULL
					AND consumed_at IS NULL
					AND auth.recovery_generation = recovery.generation
				FOR UPDATE OF auth
			`;
			if (!authorization || authorization.expires_at.getTime() <= Date.now()) {
				throw new OAuthProtocolError(
					"invalid_request",
					oauthAuthorizationRequestUnavailableMessage,
				);
			}

			const principalId = await upsertPrincipalIdentity(sql, input);

			const instances = await sql`
				UPDATE connection_consumer_instances
				SET principal_id = ${principalId}, last_seen_at = now()
				WHERE id = ${authorization.instance_id}
					AND consumer_id = ${authorization.consumer_id}
					AND status = 'ACTIVE'
					AND (principal_id IS NULL OR principal_id = ${principalId})
				RETURNING id
			`;
			if (instances.length !== 1) {
				throw new OAuthProtocolError(
					"access_denied",
					"Authentication failed",
					401,
				);
			}

			const approved = await sql`
				UPDATE connection_oauth_authorizations
				SET principal_id = ${principalId}, code_hash = ${input.codeHash}, approved_at = now()
				WHERE request_id_hash = ${hash(input.requestId)}
					AND approved_at IS NULL
					AND consumed_at IS NULL
				RETURNING redirect_uri, state
			`;
			if (approved.length !== 1) {
				throw new OAuthProtocolError(
					"invalid_request",
					oauthAuthorizationRequestUnavailableMessage,
				);
			}
			await sql`
					INSERT INTO connection_audit_records (principal_id, event, detail)
					VALUES (
						${principalId},
						'CONNECTION_LOGIN_APPROVED',
						jsonb_build_object(
							'consumerId', ${authorization.consumer_id}::text,
							'consumerInstanceId', ${authorization.instance_id}::text
						)
					)
				`;
			return {
				redirectUri: authorization.redirect_uri,
				state: authorization.state,
			};
		});
	}

	async consumeAuthorizationCode(input: {
		accessTokenExpiresAt: Date;
		accessTokenHash: string;
		clientId: string;
		codeHash: string;
		codeVerifier: string;
		familyId: string;
		redirectUri: string;
		refreshTokenExpiresAt: Date;
		refreshTokenHash: string;
		resource: string;
	}) {
		return this.sql.begin(async (sql) => {
			const [row] = await sql<
				{
					client_id: string;
					code_challenge: string;
					consumer_id: string;
					expires_at: Date;
					identity_reference: string;
					instance_id: string;
					last_verified_at: Date;
					principal_id: string;
					redirect_uri: string;
					recovery_generation: string;
					resource: string;
					scope: string;
				}[]
			>`
				SELECT
					a.client_id, a.code_challenge, a.consumer_id, a.instance_id,
					a.principal_id, a.redirect_uri, a.resource, a.scope, a.expires_at,
					i.identity_reference, p.last_verified_at,
					a.recovery_generation
				FROM connection_oauth_authorizations a
				JOIN connection_oauth_clients c
					ON c.client_id = a.client_id
					AND c.consumer_id = a.consumer_id
					AND c.instance_id = a.instance_id
					AND c.status = 'ACTIVE'
				JOIN connection_consumers consumer ON consumer.id = a.consumer_id AND consumer.status = 'ACTIVE'
				JOIN connection_consumer_instances instance
					ON instance.id = a.instance_id
					AND instance.consumer_id = a.consumer_id
					AND instance.principal_id = a.principal_id
					AND instance.status = 'ACTIVE'
				JOIN connection_principals p ON p.id = a.principal_id AND p.status = 'ACTIVE'
				JOIN connection_principal_identities i ON i.principal_id = p.id AND i.status = 'ACTIVE'
				CROSS JOIN connection_recovery_control r
				WHERE a.code_hash = ${input.codeHash}
					AND a.approved_at IS NOT NULL
					AND a.consumed_at IS NULL
					AND a.recovery_generation = r.generation
				FOR UPDATE OF a
			`;
			if (
				!row ||
				row.expires_at.getTime() <= Date.now() ||
				row.client_id !== input.clientId ||
				row.redirect_uri !== input.redirectUri ||
				row.resource !== input.resource ||
				!verifyPkce(input.codeVerifier, row.code_challenge)
			) {
				invalidGrant();
			}
			const sessionId = `session-${randomUUID()}`;
			await sql`
				INSERT INTO connection_oauth_sessions (
					id, family_id, client_id, consumer_id, instance_id, principal_id,
					resource, scope, recovery_generation, status
				)
				VALUES (
					${sessionId}, ${input.familyId}, ${row.client_id}, ${row.consumer_id},
					${row.instance_id}, ${row.principal_id}, ${row.resource}, ${row.scope},
					${row.recovery_generation}, 'ACTIVE'
				)
			`;
			await sql`
				INSERT INTO connection_oauth_access_tokens (token_hash, session_id, expires_at)
				VALUES (${input.accessTokenHash}, ${sessionId}, ${input.accessTokenExpiresAt})
			`;
			await sql`
				INSERT INTO connection_oauth_refresh_tokens (
					token_hash, session_id, family_id, expires_at
				)
				VALUES (
					${input.refreshTokenHash}, ${sessionId}, ${input.familyId},
					${input.refreshTokenExpiresAt}
				)
			`;
			await sql`
					UPDATE connection_oauth_authorizations
					SET consumed_at = now()
					WHERE code_hash = ${input.codeHash} AND consumed_at IS NULL
				`;
			await sql`
					UPDATE connection_oauth_clients SET status = 'REVOKED'
					WHERE client_id = ${row.client_id} AND status = 'ACTIVE'
				`;
			return {
				consumerId: row.consumer_id,
				identityReference: row.identity_reference,
				instanceId: row.instance_id,
				lastVerifiedAt: row.last_verified_at,
				principalId: row.principal_id,
				recoveryGeneration: row.recovery_generation,
				resource: row.resource,
			};
		});
	}

	async resolveAccessToken(accessTokenHash: string) {
		let [row] = await this.sql<IdentityRow[]>`
			SELECT
				s.id AS session_id, s.client_id, s.consumer_id, s.instance_id,
				s.principal_id, s.resource,
				s.recovery_generation AS session_recovery_generation,
				s.status AS session_status,
				instance.status AS instance_status, p.status AS principal_status,
				p.last_verified_at, identity.status AS identity_status,
				identity.identity_reference, recovery.generation AS recovery_generation
			FROM connection_oauth_access_tokens token
			JOIN connection_oauth_sessions s ON s.id = token.session_id
			JOIN connection_consumer_instances instance
				ON instance.id = s.instance_id
				AND instance.consumer_id = s.consumer_id
				AND instance.principal_id = s.principal_id
			JOIN connection_consumers consumer ON consumer.id = s.consumer_id
			JOIN connection_principals p ON p.id = s.principal_id
			JOIN connection_principal_identities identity ON identity.principal_id = p.id
			CROSS JOIN connection_recovery_control recovery
			WHERE token.token_hash = ${accessTokenHash}
				AND token.revoked_at IS NULL
				AND token.expires_at > now()
				AND consumer.status = 'ACTIVE'
				AND instance.kind = 'DEVICE'
		`;
		if (!row) {
			[row] = await this.sql<IdentityRow[]>`
				SELECT
					token.id AS session_id, ''::text AS client_id, token.consumer_id,
					token.instance_id, token.principal_id,
					NULL::text AS resource,
					token.recovery_generation AS session_recovery_generation,
					'ACTIVE'::text AS session_status,
					instance.status AS instance_status, p.status AS principal_status,
					p.last_verified_at, identity.status AS identity_status,
					identity.identity_reference, recovery.generation AS recovery_generation
				FROM connection_personal_access_tokens token
				JOIN connection_consumers consumer ON consumer.id = token.consumer_id
				JOIN connection_consumer_instances instance
					ON instance.id = token.instance_id
					AND instance.consumer_id = token.consumer_id
					AND instance.principal_id = token.principal_id
				JOIN connection_principals p ON p.id = token.principal_id
				JOIN connection_principal_identities identity ON identity.principal_id = p.id
				CROSS JOIN connection_recovery_control recovery
				WHERE token.token_hash = ${accessTokenHash}
					AND token.revoked_at IS NULL
					AND token.expires_at > now()
					AND consumer.status = 'ACTIVE'
					AND instance.kind = 'TOKEN'
			`;
		}
		if (
			!row ||
			!activeIdentity(row) ||
			row.session_recovery_generation !== row.recovery_generation
		) {
			invalidToken();
		}
		await this.sql`
			UPDATE connection_consumer_instances SET last_seen_at = now()
			WHERE id = ${row.instance_id}
		`;
		await this.sql`
			UPDATE connection_personal_access_tokens SET last_used_at = now()
			WHERE token_hash = ${accessTokenHash}
		`;
		return tokenIdentity(row);
	}

	async readRefreshToken(input: {
		clientId: string;
		refreshTokenHash: string;
		resource: string;
	}) {
		const identity = await this.sql.begin(async (sql) => {
			const [row] = await sql<
				(IdentityRow & {
					expires_at: Date;
					refresh_family_id: string;
					revoked_at: Date | null;
					session_recovery_generation: string;
					used_at: Date | null;
				})[]
			>`
				SELECT
					s.id AS session_id, s.client_id, s.consumer_id, s.instance_id,
					s.principal_id, s.resource,
					s.recovery_generation AS session_recovery_generation,
					s.status AS session_status, token.family_id AS refresh_family_id,
					token.expires_at, token.used_at, token.revoked_at,
					instance.status AS instance_status, p.status AS principal_status,
					p.last_verified_at, identity.status AS identity_status,
					identity.identity_reference, recovery.generation AS recovery_generation
				FROM connection_oauth_refresh_tokens token
				JOIN connection_oauth_sessions s ON s.id = token.session_id
				JOIN connection_consumer_instances instance
					ON instance.id = s.instance_id
					AND instance.consumer_id = s.consumer_id
					AND instance.principal_id = s.principal_id
				JOIN connection_consumers consumer ON consumer.id = s.consumer_id
				JOIN connection_principals p ON p.id = s.principal_id
				JOIN connection_principal_identities identity ON identity.principal_id = p.id
				CROSS JOIN connection_recovery_control recovery
				WHERE token.token_hash = ${input.refreshTokenHash}
					AND consumer.status = 'ACTIVE'
					AND instance.kind = 'DEVICE'
				FOR UPDATE OF token, s
			`;
			if (!row) invalidGrant();
			if (row.used_at || row.revoked_at) {
				await this.revokeSession(sql, row.session_id);
				return undefined;
			}
			if (
				row.expires_at.getTime() <= Date.now() ||
				row.client_id !== input.clientId ||
				row.resource !== input.resource ||
				row.session_recovery_generation !== row.recovery_generation ||
				!activeIdentity(row)
			) {
				invalidGrant();
			}
			return tokenIdentity(row);
		});
		if (!identity) invalidGrant();
		return identity;
	}

	async rotateRefreshToken(input: {
		accessTokenExpiresAt: Date;
		accessTokenHash: string;
		clientId: string;
		oldRefreshTokenHash: string;
		refreshTokenExpiresAt: Date;
		refreshTokenHash: string;
		resource: string;
	}) {
		const identity = await this.sql.begin(async (sql) => {
			const [row] = await sql<
				(IdentityRow & {
					expires_at: Date;
					family_id: string;
					revoked_at: Date | null;
					session_recovery_generation: string;
					used_at: Date | null;
				})[]
			>`
				SELECT
					s.id AS session_id, s.client_id, s.consumer_id, s.instance_id,
					s.principal_id, s.resource,
					s.recovery_generation AS session_recovery_generation,
					s.status AS session_status, token.family_id, token.expires_at,
					token.used_at, token.revoked_at,
					instance.status AS instance_status, p.status AS principal_status,
					p.last_verified_at, identity.status AS identity_status,
					identity.identity_reference, recovery.generation AS recovery_generation
				FROM connection_oauth_refresh_tokens token
				JOIN connection_oauth_sessions s ON s.id = token.session_id
				JOIN connection_consumer_instances instance
					ON instance.id = s.instance_id
					AND instance.consumer_id = s.consumer_id
					AND instance.principal_id = s.principal_id
				JOIN connection_consumers consumer ON consumer.id = s.consumer_id
				JOIN connection_principals p ON p.id = s.principal_id
				JOIN connection_principal_identities identity ON identity.principal_id = p.id
				CROSS JOIN connection_recovery_control recovery
				WHERE token.token_hash = ${input.oldRefreshTokenHash}
					AND consumer.status = 'ACTIVE'
					AND instance.kind = 'DEVICE'
				FOR UPDATE OF token, s
			`;
			if (!row) invalidGrant();
			if (row.used_at || row.revoked_at) {
				await this.revokeSession(sql, row.session_id);
				return undefined;
			}
			if (
				row.expires_at.getTime() <= Date.now() ||
				row.client_id !== input.clientId ||
				row.resource !== input.resource ||
				row.session_recovery_generation !== row.recovery_generation ||
				!activeIdentity(row)
			) {
				invalidGrant();
			}
			await sql`
				UPDATE connection_oauth_refresh_tokens SET used_at = now()
				WHERE token_hash = ${input.oldRefreshTokenHash} AND used_at IS NULL
			`;
			await sql`
				INSERT INTO connection_oauth_access_tokens (token_hash, session_id, expires_at)
				VALUES (${input.accessTokenHash}, ${row.session_id}, ${input.accessTokenExpiresAt})
			`;
			await sql`
				INSERT INTO connection_oauth_refresh_tokens (
					token_hash, session_id, family_id, expires_at
				)
				VALUES (
					${input.refreshTokenHash}, ${row.session_id}, ${row.family_id},
					${input.refreshTokenExpiresAt}
				)
			`;
			return tokenIdentity(row);
		});
		if (!identity) invalidGrant();
		return identity;
	}

	async revokeToken(tokenHash: string) {
		await this.sql.begin(async (sql) => {
			const sessions = await sql<{ session_id: string }[]>`
				SELECT session_id FROM connection_oauth_access_tokens WHERE token_hash = ${tokenHash}
				UNION
				SELECT session_id FROM connection_oauth_refresh_tokens WHERE token_hash = ${tokenHash}
			`;
			for (const row of sessions) await this.revokeSession(sql, row.session_id);
			const pats = await sql<
				{ instance_id: string; principal_id: string; token_id: string }[]
			>`
				UPDATE connection_personal_access_tokens
				SET revoked_at = now()
				WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
				RETURNING id AS token_id, instance_id, principal_id
			`;
			for (const pat of pats) {
				await sql`
					UPDATE connection_consumer_instances SET status = 'REVOKED'
					WHERE id = ${pat.instance_id}
				`;
				await sql`
					INSERT INTO connection_audit_records (principal_id, event, detail)
					VALUES (
						${pat.principal_id},
						'PERSONAL_ACCESS_TOKEN_REVOKED',
						jsonb_build_object(
							'consumerInstanceId', ${pat.instance_id}::text,
							'tokenId', ${pat.token_id}::text
						)
					)
				`;
			}
		});
	}

	async revokeInstance(input: {
		consumerId: string;
		instanceId: string;
		principalId: string;
	}) {
		await this.sql.begin(async (sql) => {
			const instances = await sql`
				UPDATE connection_consumer_instances
				SET status = 'REVOKED'
				WHERE id = ${input.instanceId}
					AND consumer_id = ${input.consumerId}
					AND principal_id = ${input.principalId}
				RETURNING id
			`;
			if (instances.length !== 1) invalidToken();
			const sessions = await sql<{ id: string }[]>`
				SELECT id FROM connection_oauth_sessions
				WHERE instance_id = ${input.instanceId} AND principal_id = ${input.principalId}
			`;
			for (const row of sessions) await this.revokeSession(sql, row.id);
			await sql`
				UPDATE connection_personal_access_tokens
				SET revoked_at = COALESCE(revoked_at, now())
				WHERE instance_id = ${input.instanceId}
					AND principal_id = ${input.principalId}
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${input.principalId},
					'CONSUMER_INSTANCE_REVOKED',
					jsonb_build_object(
						'consumerId', ${input.consumerId}::text,
						'consumerInstanceId', ${input.instanceId}::text
					)
				)
			`;
		});
	}

	async disablePrincipal(principalId: string) {
		await this.sql.begin(async (sql) => {
			await sql`
				UPDATE connection_authorization_roots
				SET current_grant_id = NULL, fence = fence + 1, status = 'TERMINATED'
				WHERE principal_id = ${principalId} AND status = 'ACTIVE'
			`;
			await sql`
				UPDATE connection_grants SET status = 'REVOKED'
				WHERE principal_id = ${principalId} AND status = 'ACTIVE'
			`;
			await sql`
				UPDATE connection_principals SET status = 'DISABLED', updated_at = now()
				WHERE id = ${principalId}
			`;
			await sql`
				UPDATE connection_principal_identities SET status = 'DISABLED', updated_at = now()
				WHERE principal_id = ${principalId}
			`;
			await sql`
				UPDATE connection_consumer_instances SET status = 'REVOKED'
				WHERE principal_id = ${principalId}
			`;
			await sql`
				UPDATE connection_personal_access_tokens
				SET revoked_at = COALESCE(revoked_at, now())
				WHERE principal_id = ${principalId}
			`;
			await sql`
				UPDATE connection_browser_sessions
				SET revoked_at = COALESCE(revoked_at, now())
				WHERE principal_id = ${principalId}
			`;
			const sessions = await sql<{ id: string }[]>`
				SELECT id FROM connection_oauth_sessions WHERE principal_id = ${principalId}
			`;
			for (const row of sessions) await this.revokeSession(sql, row.id);
		});
	}

	async touchPrincipalVerification(principalId: string, verifiedAt: Date) {
		await this.sql.begin(async (sql) => {
			await sql`
				UPDATE connection_principals
				SET last_verified_at = ${verifiedAt}, updated_at = now()
				WHERE id = ${principalId} AND status = 'ACTIVE'
			`;
			await sql`
				UPDATE connection_principal_identities
				SET verified_at = ${verifiedAt}, updated_at = now()
				WHERE principal_id = ${principalId} AND status = 'ACTIVE'
			`;
		});
	}

	private async revokeSession(sql: postgres.TransactionSql, sessionId: string) {
		await sql`
			UPDATE connection_oauth_sessions
			SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, now())
			WHERE id = ${sessionId}
		`;
		await sql`
			UPDATE connection_oauth_access_tokens
			SET revoked_at = COALESCE(revoked_at, now())
			WHERE session_id = ${sessionId}
		`;
		await sql`
			UPDATE connection_oauth_refresh_tokens
			SET revoked_at = COALESCE(revoked_at, now())
			WHERE session_id = ${sessionId}
		`;
	}

	private async requireBrowserSession(
		sql: postgres.TransactionSql,
		sessionHash: string,
	) {
		const [row] = await sql<BrowserSessionRow[]>`
			SELECT
				browser_session.principal_id,
				browser_session.identity_issuer,
				browser_session.recovery_generation AS session_recovery_generation,
				principal.display_name,
				principal.email,
				principal.last_verified_at,
				identity.identity_reference,
				recovery.generation AS recovery_generation
			FROM connection_browser_sessions browser_session
			JOIN connection_principals principal
				ON principal.id = browser_session.principal_id
				AND principal.status = 'ACTIVE'
			JOIN connection_principal_identities identity
				ON identity.principal_id = browser_session.principal_id
				AND identity.identity_issuer = browser_session.identity_issuer
				AND identity.status = 'ACTIVE'
			CROSS JOIN connection_recovery_control recovery
			WHERE browser_session.session_hash = ${sessionHash}
				AND browser_session.revoked_at IS NULL
				AND browser_session.expires_at > now()
				AND browser_session.recovery_generation = recovery.generation
			FOR UPDATE OF browser_session
		`;
		if (!row) invalidToken();
		await sql`
			UPDATE connection_browser_sessions SET last_seen_at = now()
			WHERE session_hash = ${sessionHash}
		`;
		return row;
	}
}
