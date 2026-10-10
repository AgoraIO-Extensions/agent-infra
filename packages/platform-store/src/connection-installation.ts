import { createHash, randomUUID } from "node:crypto";
import {
	type ApprovedConnectionConsumerTargetV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	ConnectionInstallationAuthorizationV1Schema,
	ConnectionInstallationCallbackV1Schema,
	ConnectionInstallationCommandV1Schema,
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	type ConnectionInstallationCommandDrainStoreV1,
	ConnectionInstallationErrorV1,
	type ConnectionInstallationPendingCommandV1,
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
function parseAuthorizationRedirect(
	value: string,
	configuration: RuntimeOAuthConfigurationV1,
	expiresAt: number,
) {
	if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
		throw new ConnectionInstallationErrorV1("invalid_input");
	const actual = new URL(value);
	const expected = new URL(configuration.authorizationEndpoint);
	const keys = [...actual.searchParams.keys()].sort().join(",");
	if (
		actual.protocol !== "https:" ||
		actual.origin !== expected.origin ||
		actual.pathname !== expected.pathname ||
		actual.username ||
		actual.password ||
		actual.hash ||
		keys !==
			"client_id,code_challenge,code_challenge_method,redirect_uri,resource,response_type,scope,state" ||
		actual.searchParams.get("client_id") !== configuration.clientId ||
		actual.searchParams.get("redirect_uri") !== configuration.callbackUrl ||
		actual.searchParams.get("resource") !== configuration.resource ||
		actual.searchParams.get("response_type") !== "code" ||
		actual.searchParams.get("scope") !== configuration.scope ||
		actual.searchParams.get("code_challenge_method") !== "S256" ||
		!/^[a-f0-9]{64}$/.test(actual.searchParams.get("state") ?? "") ||
		!/^[A-Za-z0-9_-]{43}$/.test(actual.searchParams.get("code_challenge") ?? "")
	)
		throw new ConnectionInstallationErrorV1("invalid_input");
	return actual.searchParams.get("state") as string;
}
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
	implements
		ConnectionInstallationStoreV1,
		ConnectionInstallationCommandDrainStoreV1
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
			claimCallback: async ({ stateHash, now }) => {
				await tx.execute(sql`
					update platform.connection_installation_authorizations
					set binding=jsonb_set(
						binding,
						'{callback,status}',
						to_jsonb('unknown'::text),
						true
					), revision=revision+1, updated_at=clock_timestamp()
					where binding->'callback'->>'status'='sending'
					  and (binding->'callback'->>'attemptExpiresAt')::bigint <= ${now}
				`);
				const rows = await tx.execute(sql`
					select id, binding
					from platform.connection_installation_authorizations
					where binding->'callback'->>'stateHash'=${stateHash}
					  and binding->'callback'->>'status'='pending'
					  and (binding->'callback'->>'expiresAt')::bigint > ${now}
					  and expires_at > clock_timestamp()
					  and status in ('awaiting_confirmation','confirmed')
					for update
				`);
				const row = rows[0];
				if (!row) return null;
				const binding = row.binding as Record<string, unknown>;
				const callback = ConnectionInstallationCallbackV1Schema.parse(
					binding.callback,
				);
				await tx.execute(sql`
					update platform.connection_installation_authorizations
					set binding=jsonb_set(
						jsonb_set(binding, '{callback,status}', to_jsonb('sending'::text), true),
						'{callback,attemptExpiresAt}', to_jsonb(${now + 15_000}::bigint), true
					), revision=revision+1, updated_at=clock_timestamp()
					where id=${row.id}
				`);
				return {
					authorizationId: row.id as string,
					runtimeOrigin: callback.runtimeOrigin,
					expiresAt: callback.expiresAt,
					issuer: this.#configuration.issuer,
				};
			},
			settleCallback: async ({ stateHash, status }) => {
				const result = await tx.execute(sql`
					update platform.connection_installation_authorizations
					set binding=(jsonb_set(
						binding, '{callback,status}', to_jsonb(${status}::text), true
					) #- '{callback,attemptExpiresAt}'),
						revision=revision+1, updated_at=clock_timestamp()
					where binding->'callback'->>'stateHash'=${stateHash}
					  and binding->'callback'->>'status'='sending'
				`);
				return Number(result.count ?? 0) === 1;
			},
			hasUnresolvedSend: async (id, exclude) => {
				const rows = await tx
					.select({
						status: commands.status,
						id: commands.id,
						attemptId: commands.attemptId,
						attemptOwner: commands.attemptOwner,
					})
					.from(commands)
					.where(eq(commands.authorizationId, id));
				return rows.some(
					(row) =>
						(row.status === "sending" || row.status === "unknown") &&
						(!exclude ||
							row.id !== exclude.commandId ||
							row.attemptId !== exclude.attemptId ||
							row.attemptOwner !== exclude.attemptOwner),
				);
			},
			commandAllowed: async (id, command, attempt) => {
				const rows = await tx
					.select({
						status: commands.status,
						id: commands.id,
						attemptId: commands.attemptId,
						attemptOwner: commands.attemptOwner,
					})
					.from(commands)
					.where(
						and(
							eq(commands.authorizationId, id),
							eq(commands.command, command),
						),
					);
				if (attempt) {
					return (
						rows.length === 1 &&
						rows[0]?.id === attempt.commandId &&
						rows[0]?.status === "sending" &&
						rows[0]?.attemptId === attempt.attemptId &&
						rows[0]?.attemptOwner === attempt.attemptOwner
					);
				}
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
					attemptId: command.attemptId,
					attemptOwner: command.attemptOwner,
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
	async listPending(
		limit: number,
		executionIds: readonly string[] = [],
	): Promise<readonly ConnectionInstallationPendingCommandV1[]> {
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 256 ||
			executionIds.length === 0
		)
			return [];
		try {
			const rows = await this.#database.transaction(async (tx) => {
				await tx.execute(sql`set local lock_timeout = '5s'`);
				await tx.execute(sql`set local statement_timeout = '15s'`);
				await tx.execute(
					sql`update platform.connection_installation_commands set status='unknown', updated_at=clock_timestamp() where status='sending' and attempt_expires_at is not null and attempt_expires_at <= clock_timestamp()`,
				);
				return tx.execute(sql`
				select c.*, a.binding, a.confirmation_revision, a.status as authorization_status,
				 a.expires_at, a.identity_revision, a.agent_authorization_revision
				from platform.connection_installation_commands c
				join platform.connection_installation_authorizations a on a.id=c.authorization_id
				where c.status='pending' and c.attempt_id is null and ((c.command='begin' and a.status in ('awaiting_confirmation','confirmed')) or (c.command='confirm' and a.status='confirmed'))
				 and a.expires_at > clock_timestamp()
				and (a.binding->'reference'->>'executionId') in (${sql.join(
					executionIds.map((id) => sql`${id}`),
					sql`, `,
				)})
				 and not exists (select 1 from platform.connection_installation_commands prior where prior.authorization_id=c.authorization_id and prior.created_at < c.created_at and prior.status in ('pending','sending','unknown'))
				order by c.created_at, c.id limit ${limit}
				`);
			});
			return rows.map((row) => ({
				authorization: ConnectionInstallationAuthorizationV1Schema.parse({
					schemaVersion: 1,
					authorizationId: row.authorization_id,
					confirmationRevision: row.confirmation_revision,
					...(row.binding as Record<string, unknown>),
					status: row.authorization_status,
					expiresAt: new Date(row.expires_at as string).getTime(),
				}),
				command: ConnectionInstallationCommandV1Schema.parse({
					schemaVersion: 1,
					commandId: row.id,
					authorizationId: row.authorization_id,
					command: row.command,
					requestDigest: row.request_digest,
					status: row.status,
					attemptId: row.attempt_id,
					attemptOwner: row.attempt_owner,
					createdAt: new Date(row.created_at as string).getTime(),
					updatedAt: new Date(row.updated_at as string).getTime(),
				}),
			}));
		} catch {
			throw new ConnectionInstallationErrorV1("unavailable");
		}
	}
	async claimPending(input: {
		commandId: string;
		attemptId: string;
		attemptOwner: string;
	}): Promise<ConnectionInstallationPendingCommandV1 | null> {
		try {
			return await this.#database.transaction(async (tx) => {
				await tx.execute(sql`set local lock_timeout = '5s'`);
				await tx.execute(sql`set local statement_timeout = '15s'`);
				await tx.execute(
					sql`select id from platform.connection_installation_authorizations where id=(select authorization_id from platform.connection_installation_commands where id=${input.commandId}) for update`,
				);
				const rows = await tx.execute(sql`
					update platform.connection_installation_commands c
					set status='sending', attempt_id=${input.attemptId}, attempt_owner=${input.attemptOwner}, attempt_expires_at=clock_timestamp()+interval '15 seconds', updated_at=clock_timestamp()
					from platform.connection_installation_authorizations a
					where c.id=${input.commandId} and c.status='pending' and c.attempt_id is null
					 and a.id=c.authorization_id and ((c.command='begin' and a.status in ('awaiting_confirmation','confirmed')) or (c.command='confirm' and a.status='confirmed')) and a.expires_at > clock_timestamp()
					 and not exists (select 1 from platform.connection_installation_commands prior where prior.authorization_id=c.authorization_id and prior.created_at < c.created_at and prior.status in ('pending','sending','unknown'))
					returning c.*, a.binding, a.confirmation_revision, a.status as authorization_status, a.expires_at
				`);
				const row = rows[0];
				if (!row) return null;
				return {
					authorization: ConnectionInstallationAuthorizationV1Schema.parse({
						schemaVersion: 1,
						authorizationId: row.authorization_id,
						confirmationRevision: row.confirmation_revision,
						...(row.binding as Record<string, unknown>),
						status: row.authorization_status,
						expiresAt: new Date(row.expires_at as string).getTime(),
					}),
					command: ConnectionInstallationCommandV1Schema.parse({
						schemaVersion: 1,
						commandId: row.id,
						authorizationId: row.authorization_id,
						command: row.command,
						requestDigest: row.request_digest,
						status: row.status,
						attemptId: row.attempt_id,
						attemptOwner: row.attempt_owner,
						createdAt: new Date(row.created_at as string).getTime(),
						updatedAt: new Date(row.updated_at as string).getTime(),
					}),
				};
			});
		} catch {
			throw new ConnectionInstallationErrorV1("unavailable");
		}
	}
	async settle(input: {
		commandId: string;
		attemptId: string;
		attemptOwner: string;
		status: "completed" | "unknown";
		authorizationUrl?: string;
		authorizationExpiresAt?: number;
	}): Promise<boolean> {
		try {
			const result = await this.#database.transaction(async (tx) => {
				await tx.execute(sql`set local lock_timeout = '5s'`);
				await tx.execute(sql`set local statement_timeout = '15s'`);
				const owned = await tx.execute(sql`
					select c.command, c.authorization_id, a.binding, a.expires_at
					from platform.connection_installation_commands c
					join platform.connection_installation_authorizations a on a.id=c.authorization_id
					where c.id=${input.commandId} and c.status='sending' and c.attempt_id=${input.attemptId} and c.attempt_owner=${input.attemptOwner}
					for update
				`);
				const command = owned[0];
				if (!command) return 0;
				const status = await tx.execute(sql`
				update platform.connection_installation_commands
				set status=case when attempt_expires_at is null or attempt_expires_at > clock_timestamp() then ${input.status} else 'unknown' end, attempt_expires_at=null, updated_at=clock_timestamp()
				where id=${input.commandId} and status='sending' and attempt_id=${input.attemptId} and attempt_owner=${input.attemptOwner}
				returning status
				`);
				const effectiveStatus = status[0]?.status;
				if (
					input.authorizationUrl !== undefined &&
					input.authorizationExpiresAt !== undefined &&
					effectiveStatus === "completed" &&
					command.command === "begin"
				) {
					const state = parseAuthorizationRedirect(
						input.authorizationUrl,
						this.#configuration,
						input.authorizationExpiresAt,
					);
					if (
						input.authorizationExpiresAt >
						new Date(command.expires_at as string).getTime()
					)
						throw new ConnectionInstallationErrorV1("invalid_input");
					const callback = {
						stateHash: createHash("sha256").update(state).digest("hex"),
						runtimeOrigin: this.#configuration.runtimeOrigin,
						expiresAt: input.authorizationExpiresAt,
						status: "pending" as const,
					};
					await tx.execute(sql`
						update platform.connection_installation_authorizations
						set binding=jsonb_set(
							jsonb_set(binding, '{authorizationUrl}', to_jsonb(${input.authorizationUrl}::text), true),
							'{callback}', ${JSON.stringify(callback)}::jsonb, true
						), revision=revision+1, updated_at=clock_timestamp()
						where id=${command.authorization_id}
					`);
				}
				return status.length;
			});
			return result === 1;
		} catch {
			throw new ConnectionInstallationErrorV1("unavailable");
		}
	}
}
