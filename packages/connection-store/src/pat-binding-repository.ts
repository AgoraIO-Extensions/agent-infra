import { createHash } from "node:crypto";
import {
	type ConnectionPatBindingRepository,
	OAuthProtocolError,
} from "@agent-infra/connection-core";
import postgres from "postgres";

function invalidToken(): never {
	throw new OAuthProtocolError(
		"invalid_token",
		"Invalid or expired token",
		401,
	);
}

export class PostgresConnectionPatBindingRepository
	implements ConnectionPatBindingRepository
{
	private readonly sql;

	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 10 });
	}

	async close() {
		await this.sql.end();
	}

	async authenticatePatBindingConsumer(input: {
		consumerId: string;
		secretHash: string;
	}) {
		const [profile] = await this.sql<
			{ callback_url: string; consumer_id: string; consumer_name: string }[]
		>`
			SELECT
				profile.callback_url,
				profile.consumer_id,
				consumer.display_name AS consumer_name
			FROM connection_pat_consumer_profiles profile
			JOIN connection_consumers consumer ON consumer.id = profile.consumer_id
			WHERE profile.consumer_id = ${input.consumerId}
				AND profile.secret_hash = ${input.secretHash}
				AND profile.status = 'ACTIVE'
				AND consumer.status = 'ACTIVE'
		`;
		if (!profile) {
			throw new OAuthProtocolError(
				"invalid_client",
				"Invalid PAT binding client",
				401,
			);
		}
		return {
			callbackUrl: profile.callback_url,
			consumerId: profile.consumer_id,
			consumerName: profile.consumer_name,
		};
	}

	async listPatBindingConsumers() {
		const rows = await this.sql<
			{
				callback_url: string;
				consumer_id: string;
				consumer_name: string;
				status: "ACTIVE" | "DISABLED";
			}[]
		>`
			SELECT
				profile.callback_url,
				profile.consumer_id,
				consumer.display_name AS consumer_name,
				profile.status
			FROM connection_pat_consumer_profiles profile
			JOIN connection_consumers consumer ON consumer.id = profile.consumer_id
			ORDER BY consumer.display_name, profile.consumer_id
		`;
		return rows.map((row) => ({
			callbackUrl: row.callback_url,
			consumerId: row.consumer_id,
			consumerName: row.consumer_name,
			status: row.status,
		}));
	}

	async registerPatBindingConsumer(input: {
		callbackUrl: string;
		consumerId: string;
		consumerName: string;
		secretHash: string;
	}) {
		await this.sql.begin(async (sql) => {
			await sql`
				INSERT INTO connection_consumers (id, display_name, status)
				VALUES (${input.consumerId}, ${input.consumerName}, 'ACTIVE')
				ON CONFLICT (id) DO UPDATE SET
					display_name = EXCLUDED.display_name,
					status = 'ACTIVE'
			`;
			await sql`
				INSERT INTO connection_pat_consumer_profiles (
					consumer_id, callback_url, secret_hash, status
				)
				VALUES (
					${input.consumerId}, ${input.callbackUrl}, ${input.secretHash}, 'ACTIVE'
				)
				ON CONFLICT (consumer_id) DO UPDATE SET
					callback_url = EXCLUDED.callback_url,
					secret_hash = EXCLUDED.secret_hash,
					status = 'ACTIVE',
					updated_at = now()
			`;
		});
	}

	async disablePatBindingConsumer(consumerId: string) {
		const [disabled] = await this.sql<{ consumer_id: string }[]>`
			UPDATE connection_pat_consumer_profiles
			SET status = 'DISABLED', updated_at = now()
			WHERE consumer_id = ${consumerId} AND status = 'ACTIVE'
			RETURNING consumer_id
		`;
		if (!disabled) {
			throw new OAuthProtocolError(
				"invalid_request",
				"PAT Consumer is unavailable",
				404,
			);
		}
	}

	async createPersonalAccessTokenBinding(input: {
		bindingId: string;
		consumerId: string;
		consumerName: string;
		expiresAt: Date;
		instanceId: string;
		name: string;
		principalHintHash: string;
		stateHash: string;
	}) {
		await this.sql.begin(async (sql) => {
			const [consumer] = await sql<{ status: string }[]>`
				INSERT INTO connection_consumers (id, display_name, status)
				VALUES (${input.consumerId}, ${input.consumerName}, 'ACTIVE')
				ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
				RETURNING status
			`;
			if (consumer?.status !== "ACTIVE") {
				throw new OAuthProtocolError(
					"invalid_client",
					"Invalid PAT binding client",
					401,
				);
			}
			const [profile] = await sql<{ callback_url: string }[]>`
				SELECT callback_url FROM connection_pat_consumer_profiles
				WHERE consumer_id = ${input.consumerId} AND status = 'ACTIVE'
			`;
			if (!profile) {
				throw new OAuthProtocolError(
					"invalid_client",
					"Invalid PAT binding client",
					401,
				);
			}
			await sql`
				INSERT INTO connection_pat_binding_sessions (
					id, state_hash, consumer_id, instance_id, token_name,
					principal_hint_hash, callback_url, expires_at
				)
				VALUES (
					${input.bindingId}, ${input.stateHash}, ${input.consumerId},
					${input.instanceId}, ${input.name}, ${input.principalHintHash},
					${profile.callback_url}, ${input.expiresAt}
				)
			`;
		});
	}

	async findPersonalAccessTokenBinding(stateHash: string) {
		const [binding] = await this.sql<
			{
				binding_id: string;
				consumer_id: string;
				consumer_name: string;
				expires_at: Date;
				name: string;
				callback_url: string;
			}[]
		>`
			SELECT
				binding.id AS binding_id,
				binding.consumer_id,
				consumer.display_name AS consumer_name,
				binding.expires_at,
				binding.token_name AS name,
				binding.callback_url
			FROM connection_pat_binding_sessions binding
			JOIN connection_consumers consumer ON consumer.id = binding.consumer_id
			WHERE binding.state_hash = ${stateHash}
				AND binding.status = 'PENDING'
				AND binding.expires_at > now()
				AND consumer.status = 'ACTIVE'
		`;
		if (!binding) {
			throw new OAuthProtocolError(
				"invalid_request",
				"PAT binding request is unavailable",
				404,
			);
		}
		return {
			bindingId: binding.binding_id,
			callbackUrl: binding.callback_url,
			consumerId: binding.consumer_id,
			consumerName: binding.consumer_name,
			expiresAt: binding.expires_at,
			name: binding.name,
		};
	}

	async confirmPersonalAccessTokenBinding(input: {
		browserSessionHash: string;
		protectedToken: string;
		stateHash: string;
		tokenHash: string;
		tokenId: string;
		ttlMs: number;
	}) {
		return this.sql.begin(async (sql) => {
			const browserSession = await this.requireBrowserSession(
				sql,
				input.browserSessionHash,
			);
			const [binding] = await sql<
				{
					binding_id: string;
					callback_url: string;
					consumer_id: string;
					consumer_name: string;
					instance_id: string;
					name: string;
					principal_hint_hash: string;
				}[]
			>`
				SELECT
					binding.id AS binding_id,
					binding.callback_url,
					binding.consumer_id,
					consumer.display_name AS consumer_name,
					binding.instance_id,
					binding.token_name AS name,
					binding.principal_hint_hash
				FROM connection_pat_binding_sessions binding
				JOIN connection_consumers consumer ON consumer.id = binding.consumer_id
				WHERE binding.state_hash = ${input.stateHash}
					AND binding.status = 'PENDING'
					AND binding.expires_at > now()
					AND consumer.status = 'ACTIVE'
				FOR UPDATE OF binding
			`;
			if (!binding) {
				throw new OAuthProtocolError(
					"invalid_request",
					"PAT binding request is unavailable",
					404,
				);
			}
			const currentPrincipalHintHash = createHash("sha256")
				.update(
					String(browserSession.email ?? "")
						.trim()
						.toLowerCase(),
					"utf8",
				)
				.digest("hex");
			if (currentPrincipalHintHash !== binding.principal_hint_hash) {
				throw new OAuthProtocolError(
					"access_denied",
					"PAT binding belongs to another account",
					403,
				);
			}
			await sql`
				INSERT INTO connection_consumer_instances (
					id, consumer_id, kind, auth_subject, status, principal_id, last_seen_at
				)
				VALUES (
					${binding.instance_id}, ${binding.consumer_id}, 'TOKEN',
					${`pat:${input.tokenHash}`}, 'ACTIVE',
					${browserSession.principal_id}, now()
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
					${input.tokenId}, ${input.tokenHash}, ${browserSession.principal_id},
					${binding.consumer_id}, ${binding.instance_id}, ${binding.name},
					${recovery.generation},
					now() + (${input.ttlMs}::bigint * interval '1 millisecond')
				)
				RETURNING expires_at
			`;
			if (!token) throw new Error("Connection PAT was not persisted");
			await sql`
				UPDATE connection_pat_binding_sessions SET
					status = 'ISSUED',
					token_id = ${input.tokenId},
					protected_token = ${input.protectedToken},
					issued_at = now()
				WHERE id = ${binding.binding_id}
			`;
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (
					${browserSession.principal_id},
					'PERSONAL_ACCESS_TOKEN_BOUND',
					jsonb_build_object(
						'bindingId', ${binding.binding_id}::text,
						'consumerId', ${binding.consumer_id}::text,
						'consumerInstanceId', ${binding.instance_id}::text,
						'tokenId', ${input.tokenId}::text
					)
				)
			`;
			return {
				bindingId: binding.binding_id,
				callbackUrl: binding.callback_url,
				consumerId: binding.consumer_id,
				consumerName: binding.consumer_name,
				expiresAt: token.expires_at,
				name: binding.name,
			};
		});
	}

	async claimPersonalAccessTokenBinding(input: {
		bindingId: string;
		consumerId: string;
	}) {
		return this.sql.begin(async (sql) => {
			const [binding] = await sql<
				{
					consumer_id: string;
					expires_at: Date;
					name: string;
					protected_token: string;
					token_id: string;
				}[]
			>`
				SELECT
					binding.consumer_id,
					token.expires_at,
					token.name,
					binding.protected_token,
					token.id AS token_id
				FROM connection_pat_binding_sessions binding
				JOIN connection_personal_access_tokens token
					ON token.id = binding.token_id
				WHERE binding.id = ${input.bindingId}
					AND binding.consumer_id = ${input.consumerId}
					AND binding.status = 'ISSUED'
					AND binding.expires_at > now()
					AND token.revoked_at IS NULL
					AND token.expires_at > now()
				FOR UPDATE OF binding
			`;
			if (!binding) {
				throw new OAuthProtocolError(
					"invalid_grant",
					"Invalid or expired PAT binding",
				);
			}
			await sql`
				UPDATE connection_pat_binding_sessions
				SET status = 'DELIVERED', delivered_at = now()
				WHERE id = ${input.bindingId}
			`;
			return {
				consumerId: binding.consumer_id,
				expiresAt: binding.expires_at,
				name: binding.name,
				protectedToken: binding.protected_token,
				tokenId: binding.token_id,
			};
		});
	}

	private async requireBrowserSession(
		sql: postgres.TransactionSql,
		sessionHash: string,
	) {
		const [row] = await sql<{ email: string | null; principal_id: string }[]>`
			SELECT browser_session.principal_id, principal.email
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
