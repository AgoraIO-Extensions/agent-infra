import { randomUUID } from "node:crypto";
import {
	type AgentDefaultRelayKeyStorePortV1,
	ApiIdentityError,
	agentDefaultRelayKeyAuditIntentV1,
	isAgentDefaultRelayKeyAuthorizedV1,
} from "@agent-infra/platform-core";
import type { RelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import postgres from "postgres";

import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import {
	currentRelayKeyVersionInTransaction,
	replaceRelayKeyVersionInTransaction,
} from "./relay-key-versions.js";

type Transaction = postgres.TransactionSql;
type CurrentUser = {
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
	readonly authorizationRevision?: string;
};
type CurrentConfiguration = NonNullable<
	Awaited<ReturnType<AgentDefaultRelayKeyStorePortV1["current"]>>
>;

function bounded(value: string, maximum: number): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		value.includes("\0") ||
		!value.isWellFormed()
	)
		throw new Error("AGENT_DEFAULT_RELAY_KEY_INPUT_INVALID");
}

export class PostgresAgentDefaultRelayKeyStoreV1
	implements AgentDefaultRelayKeyStorePortV1
{
	private readonly sql: ReturnType<typeof postgres>;

	constructor(
		databaseUrl: string,
		private readonly currentUser: (
			userId: string,
		) => Promise<CurrentUser | null>,
		private readonly encryptor: RelayKeyEncryptorV1,
	) {
		this.sql = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: databaseUrl,
			}),
			{ max: 4 },
		);
	}

	private async authorize(
		sql: Transaction,
		agentId: string,
		actorUserId: string,
		api?: Parameters<AgentDefaultRelayKeyStorePortV1["current"]>[0]["api"],
	): Promise<Omit<CurrentConfiguration, "keyVersion"> | null> {
		bounded(agentId, 1024);
		bounded(actorUserId, 1024);
		await sql`select pg_advisory_xact_lock(hashtextextended(${actorUserId}, 0))`;
		await sql`
			select user_id from platform.ldap_identity_ids
			where user_id = ${actorUserId} for share
		`;
		const [disabled] = await sql`
			select user_id from platform.platform_user_disables
			where user_id = ${actorUserId}
		`;
		if (disabled) throw new ApiIdentityError("not_authorized");
		let currentUser: CurrentUser | null;
		try {
			currentUser = await this.currentUser(actorUserId);
		} catch {
			throw new ApiIdentityError("dependency_unavailable");
		}
		if (
			currentUser?.userId !== actorUserId ||
			currentUser.accountStatus !== "active"
		)
			throw new ApiIdentityError("not_authorized");
		const rows = await sql<
			{
				readonly current_configuration_revision: string;
				readonly authorization_revision: string | null;
				readonly configuration: unknown;
			}[]
		>`
			select a.current_configuration_revision, a.authorization_revision,
				c.configuration
			from platform.agents a
			join platform.agent_configuration_revisions c
				on c.agent_id = a.id
				and c.revision = a.current_configuration_revision
			where a.id = ${agentId}
			for update of a
		`;
		const row = rows[0];
		if (!row) return null;
		const [owner] = await sql`
			select owner_id from platform.agent_owners
			where agent_id = ${agentId} and owner_id = ${actorUserId}
			for share
		`;
		const configuration = decodeAgentConfigurationRecord(row.configuration);
		if (
			configuration.agentId !== agentId ||
			configuration.revision !== Number(row.current_configuration_revision)
		)
			return null;
		const [credential] = api
			? await sql<
					{
						readonly principal_type: string;
						readonly principal_id: string;
						readonly scopes: unknown;
						readonly expires_at: Date | null;
						readonly revoked_at: Date | null;
					}[]
				>`
					select principal_type, principal_id, scopes, expires_at, revoked_at
					from platform.platform_api_credentials
					where id = ${api.credentialId} for share
				`
			: [];
		const [grant] = api
			? await sql<
					{
						readonly authorization_revision: string;
						readonly revoked_at: Date | null;
					}[]
				>`
					select authorization_revision, revoked_at
					from platform.agent_principal_grants
					where agent_id = ${agentId} and principal_type = 'user'
						and principal_id = ${actorUserId} and grant_type = 'manage'
					for share
				`
			: [];
		if (
			!isAgentDefaultRelayKeyAuthorizedV1({
				actorUserId,
				currentUser,
				isOwner: owner !== undefined,
				source: configuration.source,
				runtime: configuration.runtimeModelConfigurationV4,
				api,
				agentAuthorizationRevision: row.authorization_revision,
				credential: credential
					? {
							principalType: credential.principal_type,
							principalId: credential.principal_id,
							scopes: credential.scopes,
							expiresAt: credential.expires_at,
							revokedAt: credential.revoked_at,
						}
					: null,
				grant: grant
					? {
							authorizationRevision: grant.authorization_revision,
							revokedAt: grant.revoked_at,
						}
					: null,
			})
		)
			return null;
		if (configuration.source.kind !== "standard") return null;
		if (!configuration.runtimeModelConfigurationV4) return null;
		return {
			configurationRevision: configuration.revision,
			source: configuration.source,
			runtime: configuration.runtimeModelConfigurationV4,
		};
	}

	private async audit(
		sql: Transaction,
		input: {
			readonly agentId: string;
			readonly actorUserId: string;
			readonly traceId: string;
			readonly requestId: string;
			readonly action: string;
			readonly outcome: "succeeded" | "rejected" | "failed";
			readonly reason?: string;
		},
	): Promise<void> {
		await sql`
			insert into platform.audit_events
				(id, trace_id, request_id, actor_type, actor_id, action,
				 target_type, target_id, outcome, details)
			values (${randomUUID()}, ${input.traceId}, ${input.requestId},
				'user', ${input.actorUserId}, ${input.action}, 'agent',
				${input.agentId}, ${input.outcome},
				${input.reason === undefined ? null : sql.json({ reason: input.reason })})
		`;
	}

	async current(
		input: Parameters<AgentDefaultRelayKeyStorePortV1["current"]>[0],
	): ReturnType<AgentDefaultRelayKeyStorePortV1["current"]> {
		bounded(input.traceId, 256);
		bounded(input.requestId, 256);
		return this.sql.begin(async (sql) => {
			const configuration = await this.authorize(
				sql,
				input.agentId,
				input.actorUserId,
				input.api,
			);
			if (!configuration) return null;
			const key = await currentRelayKeyVersionInTransaction(sql, {
				purpose: "agent-default",
				subjectId: input.agentId,
			});
			await this.audit(sql, {
				...input,
				...agentDefaultRelayKeyAuditIntentV1({ operation: "current" }),
			});
			return { ...configuration, keyVersion: key?.keyVersion ?? null };
		});
	}

	async replace(
		input: Parameters<AgentDefaultRelayKeyStorePortV1["replace"]>[0],
	): ReturnType<AgentDefaultRelayKeyStorePortV1["replace"]> {
		bounded(input.traceId, 256);
		bounded(input.requestId, 256);
		return this.sql.begin(async (sql) => {
			const configuration = await this.authorize(
				sql,
				input.agentId,
				input.actorUserId,
				input.api,
			);
			if (!configuration) throw new ApiIdentityError("resource_unavailable");
			if (
				configuration.configurationRevision !==
				input.expectedConfigurationRevision
			) {
				await this.audit(sql, {
					...input,
					...agentDefaultRelayKeyAuditIntentV1({
						operation: "replace",
						result: "stale",
					}),
				});
				return null;
			}
			const result = await replaceRelayKeyVersionInTransaction(sql, {
				purpose: "agent-default",
				subjectId: input.agentId,
				expectedCurrentVersion: input.expectedVersion,
				encrypt: (binding) =>
					this.encryptor.encrypt({ ...binding, plaintext: input.keyValue }),
			});
			await this.audit(sql, {
				...input,
				...agentDefaultRelayKeyAuditIntentV1({
					operation: "replace",
					result: result.outcome,
				}),
			});
			return result.outcome === "replaced" ? result.binding.keyVersion : null;
		});
	}

	async recordRejected(
		input: Parameters<AgentDefaultRelayKeyStorePortV1["recordRejected"]>[0],
	): Promise<void> {
		bounded(input.agentId, 1024);
		if (input.actorUserId !== null) bounded(input.actorUserId, 1024);
		bounded(input.traceId, 256);
		bounded(input.requestId, 256);
		bounded(input.reason, 64);
		const audit = agentDefaultRelayKeyAuditIntentV1({
			operation: "rejected",
			outcome: input.outcome,
			reason: input.reason,
		});
		await this.sql`
			insert into platform.audit_events
				(id, trace_id, request_id, actor_type, actor_id, action,
				 target_type, target_id, outcome, details)
			values (${randomUUID()}, ${input.traceId}, ${input.requestId},
				${input.actorUserId === null ? "unknown" : "user"},
				${input.actorUserId ?? "unresolved"}, ${audit.action}, 'agent',
				${input.agentId}, ${audit.outcome},
				${this.sql.json({ reason: audit.reason })})
		`;
	}

	async close(): Promise<void> {
		await this.sql.end();
	}
}
