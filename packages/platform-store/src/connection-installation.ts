import { randomUUID } from "node:crypto";
import {
	type ApprovedConnectionConsumerTargetV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	ConnectionInstallationAuthorizationV1Schema,
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	ConnectionInstallationErrorV1,
	type ConnectionInstallationSavedV1,
	type ConnectionInstallationStoreV1,
	type ConnectionInstallationTransactionV1,
	parseCurrentTaskUserV1,
	parseTaskAuthorizationBoundaryV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readAgentManagementState } from "./agent-management.js";
import {
	connectionInstallationAuthorizations as authorizations,
	connectionInstallationCommands as commands,
} from "./schema-connection-installation.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
function decode(
	row: typeof authorizations.$inferSelect,
): ConnectionInstallationSavedV1 {
	return {
		authorization: ConnectionInstallationAuthorizationV1Schema.parse({
			schemaVersion: 1,
			authorizationId: row.id,
			confirmationRevision: row.confirmationRevision,
			...row.binding,
			status: row.status,
			expiresAt: row.expiresAt.getTime(),
		}),
		identityRevision: row.identityRevision,
		agentAuthorizationRevision: row.agentAuthorizationRevision,
	};
}

/** Same Platform database and original Execution facts, with no credentials or parallel identity. */
export class PostgresConnectionInstallationAuthorizationTransactionV1
	implements ConnectionInstallationStoreV1
{
	readonly #client: ReturnType<typeof postgres>;
	readonly #database: ReturnType<typeof drizzle>;
	readonly #directory: TaskUserDirectoryV1;
	readonly #configuration: RuntimeOAuthConfigurationV1;
	readonly #target: ApprovedConnectionConsumerTargetV1;
	constructor(options: {
		databaseUrl: string;
		directory: TaskUserDirectoryV1;
		configuration: RuntimeOAuthConfigurationV1;
		profile: unknown;
		approval: unknown;
	}) {
		this.#directory = options.directory;
		this.#configuration = RuntimeOAuthConfigurationV1Schema.parse(
			structuredClone(options.configuration),
		);
		const approved = resolveApprovedConnectionConsumerProfileV1(
			options.profile,
			options.approval,
		);
		if (
			approved.status !== "available" ||
			approved.configFingerprint !== this.#configuration.configFingerprint ||
			JSON.stringify(approved.source) !==
				JSON.stringify(this.#configuration.source) ||
			approved.profile.publicOrigin + approved.profile.mcpPath !==
				this.#configuration.resource ||
			new URL(this.#configuration.issuer).origin !==
				approved.profile.publicOrigin
		)
			throw new ConnectionInstallationErrorV1("unavailable");
		this.#target = {
			...approved,
			url: approved.profile.publicOrigin + approved.profile.mcpPath,
		};
		this.#client = postgres(options.databaseUrl);
		this.#database = drizzle(this.#client);
	}
	async transaction<T>(
		work: (tx: ConnectionInstallationTransactionV1) => Promise<T>,
	): Promise<T> {
		try {
			return await this.#database.transaction(async (tx) => {
				await tx.execute(sql`set local lock_timeout = '5s'`);
				await tx.execute(sql`set local statement_timeout = '15s'`);
				return work(this.#operations(tx));
			});
		} catch (error) {
			if (error instanceof ConnectionInstallationErrorV1) throw error;
			throw new ConnectionInstallationErrorV1("unavailable");
		}
	}
	#operations(tx: Transaction): ConnectionInstallationTransactionV1 {
		const read = async (userId: string, id: string) => {
			const [row] = await tx
				.select()
				.from(authorizations)
				.where(
					and(eq(authorizations.id, id), eq(authorizations.userId, userId)),
				)
				.for("update");
			return row ? decode(row) : null;
		};
		return {
			hasUnresolvedSend: async (id) => {
				const rows = await tx
					.select({ status: commands.status })
					.from(commands)
					.where(eq(commands.authorizationId, id));
				return rows.some(
					(row) => row.status === "sending" || row.status === "unknown",
				);
			},
			commandAllowed: async (id, command) => {
				const rows = await tx
					.select({ status: commands.status })
					.from(commands)
					.where(
						and(
							eq(commands.authorizationId, id),
							eq(commands.command, command),
						),
					);
				return rows.length === 1 && rows[0]?.status === "pending";
			},
			read,
			async now() {
				const rows = await tx.execute(sql`select clock_timestamp() as now`);
				return new Date(rows[0]?.now as string).getTime();
			},
			current: async (userId, executionId) => {
				await tx.execute(
					sql`lock table platform.platform_user_disables in share mode`,
				);
				const rows = await tx.execute(sql`
					select e.execution_id, e.conversation_id, e.agent_id, e.actor_id, e.channel_id, e.principal_type,
					 e.session_generation, e.authorization_revision, c.host_session_ref, a.authorization_revision as agent_revision,
					 t.boundary, s.sandbox_id, s.resource_name, s.workspace_scope, s.resource_observation
					from platform.agents a
					join platform.conversation_executions e on e.agent_id = a.id
					join platform.conversations c on c.id=e.conversation_id and c.agent_id=e.agent_id and c.actor_id=e.actor_id and c.principal_type=e.principal_type and c.channel_id=e.channel_id and c.session_generation=e.session_generation
					join platform.task_authorization_records t on t.execution_id=e.execution_id and t.revoked_at is null
					join platform.session_sandbox_allocations s on s.sandbox_id=e.sandbox_id and s.conversation_id=e.conversation_id and s.agent_id=e.agent_id and s.actor_id=e.actor_id and s.principal_type=e.principal_type and s.channel_id=e.channel_id and s.session_generation=e.session_generation
					where e.execution_id=${executionId} and e.actor_id=${userId} and e.principal_type='user' and e.channel_id='web'
					 and e.status='processing' and e.runtime_submit_protocol='v4' and c.host_session_ref is not null
					 and s.status='ready' and s.desired_state='running'
					 and exists(select 1 from platform.outbox_items o where o.scope_type='conversation' and o.scope_id=e.conversation_id and o.payload->>'executionId'=e.execution_id and o.status='processing' and o.lease_owner is not null and o.lease_expires_at > clock_timestamp() and o.operation in ('conversation.turn.submit.v1','conversation.turn.regenerate.v1','conversation.turn.supplement.v1'))
					 and not exists(select 1 from platform.platform_user_disables where user_id=${userId})
					 and not exists(select 1 from platform.conversation_stops where execution_id=e.execution_id and status='submitted')
					 and not exists(select 1 from platform.conversation_generation_tombstones where execution_id=e.execution_id and status='pending')
					for share of a,c,e,t,s
				`);
				const row = rows[0];
				if (
					!row ||
					row.authorization_revision !== row.agent_revision ||
					row.workspace_scope !== row.sandbox_id
				)
					return null;
				const observation = row.resource_observation as {
					status: string;
					resources: { kind: string; uid: string; name: string }[];
				};
				const pods = observation?.resources?.filter((r) => r.kind === "Pod");
				if (
					observation?.status !== "ready" ||
					pods?.length !== 1 ||
					!pods[0]?.uid ||
					pods[0].name !== row.resource_name
				)
					return null;
				const userValue = await this.#directory.resolveUser(userId);
				if (!userValue) return null;
				const user = parseCurrentTaskUserV1(userValue);
				const agent = await readAgentManagementState(
					tx,
					row.agent_id as string,
				);
				if (!agent) return null;
				const reference = {
					agentId: row.agent_id as string,
					conversationId: row.conversation_id as string,
					executionId: row.execution_id as string,
					sessionGeneration: Number(row.session_generation),
				};
				return {
					user,
					agent,
					boundary: parseTaskAuthorizationBoundaryV1(row.boundary),
					agentAuthorizationRevision: row.agent_revision as string,
					reference,
					scope: {
						agentId: reference.agentId,
						sandboxId: row.sandbox_id as string,
						podUid: pods[0].uid,
						sessionGeneration: reference.sessionGeneration,
						configFingerprint: this.#target.configFingerprint,
						source: this.#target.source,
						oauthConfiguration: {
							ref: this.#configuration.ref,
							revision: this.#configuration.revision,
						},
					},
				};
			},
			receipt: async (userId, key, command, digest) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["connection_installation", userId, command, key])},0))`,
				);
				const rows = await tx.execute(
					sql`select request_digest,result from platform.idempotency_records where scope_type='connection_installation' and scope_id=${userId} and actor_id=${userId} and command_type=${command} and idempotency_key=${key}`,
				);
				if (!rows[0]) return null;
				if (rows[0].request_digest !== digest)
					throw new ConnectionInstallationErrorV1("conflict");
				const value = rows[0].result as { authorizationId: string };
				const record = await read(userId, value.authorizationId);
				if (!record) throw new ConnectionInstallationErrorV1("unavailable");
				return record.authorization;
			},
			save: async (record) => {
				const value = ConnectionInstallationAuthorizationV1Schema.parse(
					record.authorization,
				);
				const existing = await read(value.principal.id, value.authorizationId);
				if (existing) {
					if (
						existing.authorization.confirmationRevision !==
						value.confirmationRevision
					)
						throw new ConnectionInstallationErrorV1("conflict");
					await tx
						.update(authorizations)
						.set({
							status: value.status,
							revision: sql`${authorizations.revision}+1`,
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(authorizations.id, value.authorizationId),
								eq(authorizations.userId, value.principal.id),
							),
						);
				} else
					await tx.insert(authorizations).values({
						id: value.authorizationId,
						executionId: value.reference.executionId,
						userId: value.principal.id,
						confirmationRevision: value.confirmationRevision,
						binding: {
							principal: value.principal,
							reference: value.reference,
							scope: value.scope,
						},
						identityRevision: record.identityRevision,
						agentAuthorizationRevision: record.agentAuthorizationRevision,
						status: value.status,
						expiresAt: new Date(value.expiresAt),
					});
			},
			command: async (command, key) => {
				await tx.insert(commands).values({
					id: command.commandId,
					authorizationId: command.authorizationId,
					command: command.command,
					idempotencyKey: key,
					requestDigest: command.requestDigest,
					status: command.status,
					createdAt: new Date(command.createdAt),
					updatedAt: new Date(command.updatedAt),
				});
			},
			completeReceipt: async (
				userId,
				key,
				command,
				digest,
				authorizationId,
			) => {
				await tx.execute(
					sql`insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result) values (${randomUUID()},'connection_installation',${userId},${userId},${command},${key},${digest},'completed',${JSON.stringify({ authorizationId })}::jsonb)`,
				);
			},
			audit: async (userId, id, command, requestId, traceId) => {
				const installation = await read(userId, id);
				if (!installation)
					throw new ConnectionInstallationErrorV1("unavailable");
				await tx.execute(
					sql`insert into platform.audit_events(id,actor_type,actor_id,action,target_type,target_id,outcome,request_id,trace_id,details) values (${randomUUID()},'user',${userId},${`connection.installation.${command}`},'agent',${installation.authorization.reference.agentId},'succeeded',${requestId},${traceId},${JSON.stringify({ authorizationId: id })}::jsonb)`,
				);
			},
		};
	}
	async close() {
		await this.#client.end();
	}
}
