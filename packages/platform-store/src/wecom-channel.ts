import { randomUUID } from "node:crypto";
import {
	createConversationExecutionUseCaseV1,
	parseCurrentTaskUserV1,
	parseTaskAuthorizationBoundaryV1,
	type TaskAuthorizationBoundaryV1,
	type TaskUserDirectoryV1,
	type WecomAcceptancePlanV1,
	type WecomAcceptanceV1,
	type WecomAuthorityV1,
	type WecomChannelStorePortV1,
	type WecomDeliveryClaimV1,
	type WecomDeliveryStatusV1,
	type WecomDeliveryStorePortV1,
	type WecomIdentityPortV1,
	type WecomScopeV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import { PostgresAgentManagementTransactionV1 } from "./agent-management.js";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import {
	awaitTaskAuthorizationDependencyV1,
	awaitTaskAuthorizationQueryV1,
} from "./personal-api-task-durable-use.js";
import {
	recordTaskSystemControlInTransactionV1,
	TaskAuthorizationStoreError,
} from "./task-authorization.js";

class WecomAuthorizationRevoked extends Error {}

async function revokeUserTasksInTransaction(
	transaction: postgres.TransactionSql,
	userId: string,
	metadata: { workerId: string; traceId: string; requestId: string },
	signal: AbortSignal,
) {
	const targets = await awaitTaskAuthorizationQueryV1(
		transaction<
			{
				execution_id: string;
				authorization_record_id: string;
				agent_id: string;
			}[]
		>`select e.execution_id, r.id as authorization_record_id, e.agent_id
		  from platform.conversation_executions e
		  join platform.task_authorization_records r on r.execution_id=e.execution_id
		 where e.actor_id=${userId} and e.principal_type='user'
		   and e.status in ('waiting','submitted','processing','unknown')
		 order by e.agent_id,e.conversation_id,e.execution_id,r.id`,
		signal,
	);
	for (const agentId of [
		...new Set(targets.map((target) => target.agent_id)),
	].sort())
		await awaitTaskAuthorizationQueryV1(
			transaction`select id from platform.agents where id=${agentId} for key share`,
			signal,
		);
	for (const target of targets) {
		signal.throwIfAborted();
		await recordTaskSystemControlInTransactionV1(transaction, {
			executionId: target.execution_id,
			authorizationRecordId: target.authorization_record_id,
			reason: "authorization_revoked",
			workerId: metadata.workerId,
			traceId: metadata.traceId,
			requestId: metadata.requestId,
		});
	}
}

async function audit(
	sql: postgres.Sql | postgres.TransactionSql,
	eventKey: string,
	action: string,
	metadata: { agentId: string; actorId?: string },
	component: "platform-api" | "platform-worker",
	signal?: AbortSignal,
) {
	const principal = metadata.actorId
		? { kind: "user", id: metadata.actorId }
		: { kind: "unknown", id: "unknown" };
	const outcome =
		action === "denied" || action === "conflict"
			? "rejected"
			: ["failed", "unavailable", "unknown", "expired"].includes(action)
				? "failed"
				: "succeeded";
	const query = sql`insert into platform.audit_events (id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,request_id,agent_id,details) values (${randomUUID()},${eventKey},'system',${component},${`wecom.${action}`},'agent',${metadata.agentId},${outcome},${eventKey},${metadata.agentId},${sql.json({ originalPrincipal: principal, component, receiptId: eventKey, status: action })})`;
	await (signal ? awaitTaskAuthorizationQueryV1(query, signal) : query);
}

interface Row {
	id: string;
	request_digest: string;
	scope: WecomScopeV1;
	actor_id: string;
	task_boundary: TaskAuthorizationBoundaryV1;
	channel_revision: string;
	authorization_revision: string;
	acceptance_status: "accepted" | "busy" | "unavailable";
	conversation_id: string | null;
	execution_id: string | null;
	reply_handle: string;
	expires_at: Date;
	connection_bot_id: string | null;
	connection_fence: string | null;
	delivery_status: WecomDeliveryStatusV1;
	fence: number;
}
function receipt(row: Row) {
	return {
		receiptId: row.id,
		status: row.acceptance_status,
		conversationId: row.conversation_id,
		executionId: row.execution_id,
	};
}
export class PostgresWecomChannelV1
	implements WecomChannelStorePortV1, WecomDeliveryStorePortV1
{
	readonly #sql: ReturnType<typeof postgres>;
	readonly #databaseUrl: string;
	readonly #acceptSettlements = new Set<Promise<void>>();
	#closed = false;
	readonly #management: PostgresAgentManagementTransactionV1;
	readonly #connectionHolderId: string | null;
	readonly #userDirectory: TaskUserDirectoryV1 | undefined;
	readonly #identity: WecomIdentityPortV1;
	readonly #observe: (status: WecomDeliveryStatusV1) => void;
	constructor(options: {
		readonly databaseUrl: string;
		readonly userDirectory?: TaskUserDirectoryV1;
		readonly identity: WecomIdentityPortV1;
		readonly connectionHolderId?: string;
		readonly observe?: (status: WecomDeliveryStatusV1) => void;
	}) {
		if (!options.identity) throw new Error("WeCom identity is required");
		this.#connectionHolderId = options.connectionHolderId ?? null;
		this.#userDirectory = options.userDirectory;
		this.#identity = options.identity;
		this.#observe = (status) => {
			try {
				options.observe?.(status);
			} catch {
				/* Observation cannot change persisted results. */
			}
		};
		this.#sql = postgres(options.databaseUrl, { max: 5 });
		this.#databaseUrl = options.databaseUrl;
		this.#management = new PostgresAgentManagementTransactionV1(options);
	}
	async close() {
		this.#closed = true;
		const pools = await Promise.allSettled([
			this.#sql.end(),
			this.#management.close(),
		]);
		const cancellations = await Promise.allSettled(this.#acceptSettlements);
		for (const result of [...pools, ...cancellations])
			if (result.status === "rejected") throw result.reason;
	}
	async readAuthorityState(agentId: string) {
		const management = await this.#management.resolveAgentAccessState(agentId);
		if (!management) return null;
		const [row] = await this.#sql<
			{ configuration: unknown; authorization_revision: string }[]
		>`select c.configuration,a.authorization_revision from platform.agents a join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision where a.id=${agentId}`;
		return row
			? {
					management,
					configuration: decodeAgentConfigurationRecord(row.configuration),
					authorizationRevision: row.authorization_revision,
				}
			: null;
	}
	async reject(
		eventKey: string,
		outcome: "denied" | "unavailable" | "conflict",
		metadata: { agentId: string; actorId?: string },
	) {
		await audit(
			this.#sql,
			eventKey,
			outcome,
			metadata,
			this.#connectionHolderId ? "platform-worker" : "platform-api",
		);
	}

	async list(actorId: string, cursor: string | undefined) {
		const rows = await this.#sql<
			{ id: string }[]
		>`select id from platform.wecom_receipts where actor_id=${actorId} and id>${cursor ?? ""} order by id limit 25`;
		return {
			receiptIds: rows.map((row) => row.id),
			nextCursor: rows.length === 25 ? (rows.at(-1)?.id ?? null) : null,
		};
	}
	async accept(
		plan: WecomAcceptancePlanV1,
		execute: Parameters<WecomChannelStorePortV1["accept"]>[1],
		callerSignal?: AbortSignal,
	): Promise<WecomAcceptanceV1> {
		if (this.#closed) throw new TaskAuthorizationStoreError();
		const identity = this.#identity;
		const deadlineAt = Date.now() + 10_000;
		const deadline = AbortSignal.timeout(10_000);
		const signal = callerSignal
			? AbortSignal.any([callerSignal, deadline])
			: deadline;
		signal.throwIfAborted();
		while (this.#acceptSettlements.size >= 5)
			await awaitTaskAuthorizationDependencyV1(
				() => Promise.race(this.#acceptSettlements),
				signal,
			);
		if (this.#closed) throw new TaskAuthorizationStoreError();
		// Keep the backend exclusive until every in-flight cancellation has settled.
		// A shared pool releases it before begin's Promise continuation can run.
		const admissionSql = postgres(this.#databaseUrl, {
			max: 1,
			connect_timeout: 1,
		});
		const cancelSql = postgres(this.#databaseUrl, {
			max: 1,
			connect_timeout: 1,
			connection: { statement_timeout: 1000 },
		});
		let backendPid: number | undefined;
		let transactionStartedAt: string | undefined;
		let cancellation: Promise<void> | undefined;
		let transactionSettled = false;
		// Follow only this original transaction through active SQL and queued COMMIT.
		// Never cancel rollback; await its native settlement. Each probe is server bounded.
		const cancelOriginalTransaction = () => {
			cancellation = (async () => {
				while (!transactionSettled) {
					if (backendPid !== undefined && transactionStartedAt !== undefined)
						await cancelSql`select pg_cancel_backend(pid) from pg_stat_activity where pid=${backendPid} and xact_start::text=${transactionStartedAt} and state='active' and lower(query) not like 'rollback%'`.catch(
							() => undefined,
						);
					if (!transactionSettled)
						await new Promise((resolve) => setTimeout(resolve, 10));
				}
			})();
		};
		signal.addEventListener("abort", cancelOriginalTransaction, { once: true });
		const committed = admissionSql.begin(async (sql) => {
			const run = <T extends readonly (object | undefined)[]>(
				query: postgres.PendingQuery<T>,
			) => awaitTaskAuthorizationQueryV1(query, signal);
			const [backend] = await run(
				sql<
					{ pid: number; started_at: string }[]
				>`select pid,xact_start::text as started_at from pg_stat_activity where pid=pg_backend_pid()`,
			);
			backendPid = backend?.pid;
			transactionStartedAt = backend?.started_at;
			await run(sql`select set_config('statement_timeout','10s',true)`);
			await run(sql`select set_config('lock_timeout','5s',true)`);
			// Admission and revocation serialize through the same governance locks.
			await run(
				sql`lock table platform.platform_user_disables in share row exclusive mode`,
			);
			await run(sql`lock table platform.agent_principal_grants in share mode`);
			// All original accepted/replayed/rejected exits bound the ensuing driver COMMIT.
			const readyToCommit = async <T>(value: T) => {
				signal.throwIfAborted();
				await run(
					sql`select set_config('statement_timeout', ${`${Math.max(1, deadlineAt - Date.now())}ms`}, true)`,
				);
				return { value };
			};
			const reject = async (outcome: "denied" | "conflict" | "unavailable") => {
				await audit(
					sql,
					plan.eventKey,
					outcome,
					{
						agentId: plan.message.agentId,
						actorId: plan.authority.actor.actorId,
					},
					plan.connectionFence ? "platform-worker" : "platform-api",
					signal,
				);
				return readyToCommit({ outcome });
			};
			if (plan.connectionFence) {
				const fence = plan.connectionFence;
				const [lease] = await run(
					sql`select 1 from platform.wecom_connections where bot_id=${fence.botId} and bot_id=${plan.message.providerId} and agent_id=${plan.message.agentId} and binding_reference=${plan.message.bindingReference} and holder_id=${fence.holderId} and fence=${fence.fence} and lease_until>clock_timestamp() for share`,
				);
				if (!lease) return reject("unavailable");
			}
			await run(
				sql`select pg_advisory_xact_lock(hashtextextended(${plan.eventKey},0))`,
			);
			const [agent] = await run(
				sql<
					{ configuration: unknown; authorization_revision: string }[]
				>`select c.configuration,a.authorization_revision from platform.agents a join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision where a.id=${plan.message.agentId} and not exists(select 1 from jsonb_array_elements(c.configuration->'channels') channel where channel->>'kind'=${plan.message.kind} and channel->>'bindingReference'=${plan.message.bindingReference} and channel->>'enabled'='false') for share of a`,
			);
			if (!agent) return reject("denied");
			const [management] = await run(
				sql<
					{
						management_revision: string;
						status: string;
						service_availability: string;
					}[]
				>`select management_revision,status,service_availability from platform.agent_applications where agent_id=${plan.message.agentId} for share`,
			);
			if (
				!management ||
				Number(management.management_revision) !==
					plan.authority.managementRevision ||
				management.status !== "available" ||
				management.service_availability !== "ready"
			)
				return reject("denied");
			const config = decodeAgentConfigurationRecord(agent.configuration);
			if (
				config.channelRevision !== plan.authority.channelRevision ||
				agent.authorization_revision !==
					plan.authority.actor.authorizationRevision ||
				!config.channels.some(
					(b) =>
						b.kind === plan.message.kind &&
						b.bindingReference === plan.message.bindingReference,
				) ||
				(config.source.kind === "custom" &&
					config.source.interactionMode === "self-managed")
			)
				return reject("denied");
			let currentUser: ReturnType<typeof parseCurrentTaskUserV1> | null = null;
			if (identity) {
				const boundary = parseTaskAuthorizationBoundaryV1(
					plan.authority.actor.taskBoundary,
				);
				const current = await awaitTaskAuthorizationDependencyV1(
					() => identity.resolveSender(plan.message),
					signal,
				);
				currentUser = current ? parseCurrentTaskUserV1(current) : null;
				if (!currentUser || currentUser.userId !== plan.authority.actor.actorId)
					return reject("denied");
				if (currentUser.authorizationRevision !== boundary.identityRevision)
					return reject("denied");
				const [platformDisabled] = await run(
					sql<
						{ user_id: string }[]
					>`select user_id from platform.platform_user_disables where user_id=${currentUser.userId}`,
				);
				if (currentUser.accountStatus === "disabled" || platformDisabled) {
					await revokeUserTasksInTransaction(
						sql,
						currentUser.userId,
						{
							workerId: this.#connectionHolderId ?? "platform-api",
							traceId: plan.eventKey,
							requestId: plan.eventKey,
						},
						signal,
					);
					return readyToCommit({ outcome: "denied" as const });
				}
				if (currentUser.accountStatus !== "active") return reject("denied");
			}
			const [old] = await run(
				sql<
					Row[]
				>`select * from platform.wecom_receipts where id=${plan.eventKey} for update`,
			);
			if (old) {
				if (old.request_digest !== plan.requestDigest)
					return reject("conflict");
				const previouslyFenced = old.connection_bot_id !== null;
				if (
					previouslyFenced !== Boolean(plan.connectionFence) ||
					(previouslyFenced &&
						old.connection_bot_id !== plan.connectionFence?.botId)
				)
					return reject("conflict");
				try {
					await sql.savepoint(async (business) => {
						await run(
							business`update platform.wecom_receipts set reply_handle=${plan.message.replyHandle},expires_at=${new Date(plan.message.replyExpiresAt)},connection_bot_id=${plan.connectionFence?.botId ?? null},connection_fence=${plan.connectionFence?.fence ?? null},updated_at=now() where id=${plan.eventKey} and delivery_status='pending'`,
						);
						const current = await awaitTaskAuthorizationDependencyV1(
							() => this.#identity.resolveSender(plan.message),
							signal,
						);
						const finalUser = current ? parseCurrentTaskUserV1(current) : null;
						if (!finalUser || finalUser.userId !== plan.authority.actor.actorId)
							throw new TaskAuthorizationStoreError();
						if (finalUser.accountStatus === "disabled")
							throw new WecomAuthorizationRevoked();
						const [finalPlatformDisabled] = await run(
							business<
								{ user_id: string }[]
							>`select user_id from platform.platform_user_disables where user_id=${finalUser.userId}`,
						);
						if (finalPlatformDisabled) throw new WecomAuthorizationRevoked();
						if (
							finalUser.authorizationRevision !==
							parseTaskAuthorizationBoundaryV1(
								plan.authority.actor.taskBoundary,
							).identityRevision
						)
							throw new TaskAuthorizationStoreError();
					});
				} catch (error) {
					if (!(error instanceof WecomAuthorizationRevoked)) throw error;
					await revokeUserTasksInTransaction(
						sql,
						plan.authority.actor.actorId,
						{
							workerId: this.#connectionHolderId ?? "platform-api",
							traceId: plan.eventKey,
							requestId: plan.eventKey,
						},
						signal,
					);
					return readyToCommit({ outcome: "denied" as const });
				}
				return readyToCommit({
					outcome: "replayed",
					receipt: receipt(old),
				} as const);
			}
			let acceptedResult:
				| {
						status: "accepted" | "busy";
						conversationId: string;
						executionId: string | null;
				  }
				| undefined;
			try {
				await sql.savepoint(async (business) => {
					const transaction = new PostgresConversationExecutionTransactionV1({
						transaction: business,
						userDirectory: this.#userDirectory,
						signal,
					});
					const executionResult = await awaitTaskAuthorizationDependencyV1(
						() =>
							execute(
								createConversationExecutionUseCaseV1({
									transaction,
									authorization: {
										async authorize() {
											return {
												outcome: "allowed",
												authority: plan.authority.actor,
											};
										},
									},
								}),
							),
						signal,
					);
					if (
						executionResult.status !== "accepted" &&
						executionResult.status !== "busy"
					)
						throw new TaskAuthorizationStoreError();
					if (!executionResult.conversationId)
						throw new TaskAuthorizationStoreError();
					acceptedResult = {
						status: executionResult.status,
						conversationId: executionResult.conversationId,
						executionId: executionResult.executionId,
					};
					const {
						agentId,
						bindingReference,
						kind,
						senderId,
						peerId,
						conversationType,
						threadId,
					} = plan.message;
					const scope = {
						agentId,
						bindingReference,
						kind,
						senderId,
						peerId,
						conversationType,
						threadId,
					};
					const accepted = acceptedResult;
					if (!accepted) throw new TaskAuthorizationStoreError();
					await run(business`insert into platform.wecom_receipts (id,request_digest,scope,actor_id,task_boundary,channel_revision,authorization_revision,acceptance_status,conversation_id,execution_id,reply_handle,expires_at,created_at,updated_at,connection_bot_id,connection_fence)
    values (${plan.eventKey},${plan.requestDigest},${business.json(scope)},${plan.authority.actor.actorId},${business.json(parseTaskAuthorizationBoundaryV1(plan.authority.actor.taskBoundary) as unknown as postgres.JSONValue)},${plan.authority.channelRevision},${plan.authority.actor.authorizationRevision},${accepted.status},${accepted.conversationId},${accepted.executionId},${plan.message.replyHandle},${new Date(plan.message.replyExpiresAt)},now(),now(),${plan.connectionFence?.botId ?? null},${plan.connectionFence?.fence ?? null})`);
					await audit(
						business,
						plan.eventKey,
						"accepted",
						{
							agentId: plan.message.agentId,
							actorId: plan.authority.actor.actorId,
						},
						plan.connectionFence ? "platform-worker" : "platform-api",
						signal,
					);
					if (identity) {
						const current = await awaitTaskAuthorizationDependencyV1(
							() => identity.resolveSender(plan.message),
							signal,
						);
						const finalUser = current ? parseCurrentTaskUserV1(current) : null;
						if (!finalUser || finalUser.userId !== plan.authority.actor.actorId)
							throw new TaskAuthorizationStoreError();
						const [finalPlatformDisabled] = await run(
							business<
								{ user_id: string }[]
							>`select user_id from platform.platform_user_disables where user_id=${finalUser.userId}`,
						);
						if (finalUser.accountStatus === "disabled" || finalPlatformDisabled)
							throw new WecomAuthorizationRevoked();
						if (
							finalUser.authorizationRevision !==
							parseTaskAuthorizationBoundaryV1(
								plan.authority.actor.taskBoundary,
							).identityRevision
						)
							throw new TaskAuthorizationStoreError();
					}
				});
			} catch (error) {
				if (!(error instanceof WecomAuthorizationRevoked)) throw error;
				await revokeUserTasksInTransaction(
					sql,
					plan.authority.actor.actorId,
					{
						workerId: this.#connectionHolderId ?? "platform-api",
						traceId: plan.eventKey,
						requestId: plan.eventKey,
					},
					signal,
				);
				return readyToCommit({ outcome: "denied" as const });
			}
			if (!acceptedResult) throw new TaskAuthorizationStoreError();
			return readyToCommit({
				outcome: "accepted",
				receipt: { receiptId: plan.eventKey, ...acceptedResult },
			} as const);
		});
		const finishCancellation = async () => {
			transactionSettled = true;
			signal.removeEventListener("abort", cancelOriginalTransaction);
			try {
				await cancelSql.end({ timeout: 1 });
			} finally {
				try {
					await cancellation;
				} finally {
					await admissionSql.end();
				}
			}
		};
		const cancellationSettled = committed.then(
			finishCancellation,
			finishCancellation,
		);
		this.#acceptSettlements.add(cancellationSettled);
		try {
			return (await committed).value;
		} catch (error) {
			if (signal.aborted) throw new TaskAuthorizationStoreError();
			throw error;
		} finally {
			try {
				await cancellationSettled;
			} finally {
				this.#acceptSettlements.delete(cancellationSettled);
			}
		}
	}
	async claim(): Promise<WecomDeliveryClaimV1 | null> {
		let unknown = 0;
		const claim = await this.#sql.begin(async (sql) => {
			// No external send occurs until prepare changes claimed to sending.
			// Keep the old connection fence so only an ingress replay can rebind it.
			await sql`update platform.wecom_receipts r
			 set delivery_status='pending',lease_until=null,updated_at=now()
			 where r.id in (
				select candidate.id
				from platform.wecom_receipts candidate
				where candidate.connection_bot_id is not null
				  and candidate.delivery_status = 'claimed'
				  and not exists (
						select 1
						from platform.wecom_connections w
						where w.bot_id=candidate.connection_bot_id
						  and w.fence=candidate.connection_fence
						  and w.lease_until>clock_timestamp()
				  )
				order by candidate.created_at
				limit 25
				for update skip locked
			 )`;
			const expired = await sql<
				{ id: string; actor_id: string; scope: WecomScopeV1 }[]
			>`update platform.wecom_receipts set delivery_status='unknown',updated_at=now() where id in (select id from platform.wecom_receipts where delivery_status='sending' and lease_until<=now() order by created_at limit 25 for update skip locked) returning id,actor_id,scope`;
			unknown = expired.length;
			for (const row of expired)
				await audit(
					sql,
					row.id,
					"unknown",
					{ agentId: row.scope.agentId, actorId: row.actor_id },
					"platform-worker",
				);
			const [row] = await sql<
				(Row & { execution_status: string | null })[]
			>`select r.*,e.status as execution_status from platform.wecom_receipts r left join platform.conversation_executions e on e.execution_id=r.execution_id
    where (r.connection_bot_id is null or r.expires_at<=now() or exists (select 1 from platform.wecom_connections w where w.bot_id=r.connection_bot_id and w.fence=r.connection_fence and w.holder_id=${this.#connectionHolderId} and w.lease_until>clock_timestamp())) and (r.delivery_status='pending' or (r.delivery_status='claimed' and r.lease_until<=now())) and (r.acceptance_status!='accepted' or e.status in ('completed','failed','cancelled') or r.expires_at<=now()) order by r.created_at limit 1 for update of r skip locked`;
			if (!row) return null;
			await sql`update platform.wecom_receipts set delivery_status='claimed',fence=fence+1,lease_until=now()+interval '30 seconds',updated_at=now() where id=${row.id}`;
			const [size] = row.execution_id
				? await sql<
						{ bytes: string; count: string }[]
					>`select coalesce(sum(octet_length(event_payload->>'text')),0) as bytes,count(*) as count from platform.conversation_events where execution_id=${row.execution_id} and event_type='text.delta'`
				: [];
			const deltas =
				row.execution_id &&
				size &&
				Number(size.bytes) <= 20480 &&
				Number(size.count) <= 10000
					? await sql<
							{ event_payload: { text?: string } }[]
						>`select event_payload from platform.conversation_events where execution_id=${row.execution_id} and event_type='text.delta' order by sequence`
					: [];
			return {
				receiptId: row.id,
				fence: row.fence + 1,
				scope: row.scope,
				actorId: row.actor_id,
				channelRevision: row.channel_revision,
				replyHandle: row.reply_handle,
				replyExpiresAt: row.expires_at.toISOString(),
				taskBoundary: parseTaskAuthorizationBoundaryV1(row.task_boundary),
				acceptanceStatus: row.acceptance_status,
				executionStatus: row.execution_status,
				textDeltas: deltas.map((d) => d.event_payload.text ?? ""),
			};
		});
		for (let i = 0; i < unknown; i++) this.#observe("unknown");
		return claim;
	}
	async prepare(
		claim: WecomDeliveryClaimV1,
		authority: WecomAuthorityV1,
	): Promise<boolean> {
		return this.#sql.begin(async (sql) => {
			// 20,480 bytes can need eleven UTF-8 parts with 10-second sends.
			const rows =
				await sql`update platform.wecom_receipts set delivery_status='sending',lease_until=now()+(case when scope->>'kind'='wecom_app' then interval '3 minutes' else interval '30 seconds' end),updated_at=now() where id=${claim.receiptId} and fence=${claim.fence} and delivery_status='claimed' and lease_until>now() and expires_at>now() and (connection_bot_id is null or exists (select 1 from platform.wecom_connections w where w.bot_id=connection_bot_id and w.fence=connection_fence and w.holder_id=${this.#connectionHolderId} and w.lease_until>clock_timestamp())) and exists (
    select 1 from platform.agents a join platform.agent_applications m on m.agent_id=a.id join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision
    where a.id=${claim.scope.agentId} and a.authorization_revision=${authority.actor.authorizationRevision} and m.management_revision=${authority.managementRevision} and m.status='available' and m.service_availability='ready' and c.configuration->>'channelRevision'=${claim.channelRevision}
   ) returning id`;
			if (rows.length)
				await audit(
					sql,
					claim.receiptId,
					"sending",
					{ agentId: claim.scope.agentId, actorId: claim.actorId },
					"platform-worker",
				);
			return rows.length === 1;
		});
	}
	async finish(
		claim: WecomDeliveryClaimV1,
		status: "sent" | "failed" | "unknown" | "cancelled" | "expired",
	): Promise<void> {
		const changed = await this.#sql.begin(async (sql) => {
			const rows =
				await sql`update platform.wecom_receipts set delivery_status=${status},updated_at=now() where id=${claim.receiptId} and fence=${claim.fence} and delivery_status in ('claimed','sending') returning id`;
			if (rows.length)
				await audit(
					sql,
					claim.receiptId,
					status,
					{ agentId: claim.scope.agentId, actorId: claim.actorId },
					"platform-worker",
				);
			return rows.length > 0;
		});
		if (changed) this.#observe(status);
	}
	async scopeForExecution(
		executionId: string,
		actorId: string,
		channelId: string,
	) {
		const [row] = await this.#sql<
			Row[]
		>`select r.* from platform.wecom_receipts r join platform.conversation_executions e on e.execution_id=r.execution_id where r.execution_id=${executionId} and r.actor_id=${actorId} and e.channel_id=${channelId} limit 1`;
		return row
			? { scope: row.scope, channelRevision: row.channel_revision }
			: null;
	}
	async read(receiptId: string, actorId: string) {
		const [row] = await this.#sql<
			Row[]
		>`select * from platform.wecom_receipts where id=${receiptId} and actor_id=${actorId}`;
		return row
			? {
					...receipt(row),
					deliveryStatus: row.delivery_status,
					scope: row.scope,
				}
			: null;
	}
	async abandon(receiptId: string, actorId: string): Promise<boolean> {
		return await this.#sql.begin(async (sql) => {
			const rows =
				await sql`update platform.wecom_receipts set delivery_status='abandoned',updated_at=now() where id=${receiptId} and actor_id=${actorId} and delivery_status='unknown' returning id,scope`;
			if (rows.length)
				await audit(
					sql,
					receiptId,
					"abandoned",
					{ agentId: rows[0]?.scope.agentId, actorId },
					"platform-api",
				);
			return rows.length === 1;
		});
	}
}
