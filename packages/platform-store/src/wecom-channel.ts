import { randomUUID } from "node:crypto";
import {
	createConversationExecutionUseCaseV1,
	createWecomAuthorizationV1,
	isWecomMediaRejectionV1,
	parseCurrentTaskUserV1,
	parseTaskAuthorizationBoundaryV1,
	sameWecomConnectionAuthorizationFactV1,
	type TaskAuthorizationBoundaryV1,
	type TaskUserDirectoryV1,
	type WecomAcceptancePlanV1,
	type WecomAcceptanceV1,
	type WecomAuthorityStateV1,
	type WecomAuthorityV1,
	type WecomChannelStorePortV1,
	type WecomConnectionAuthorizationFactV1,
	type WecomConnectionAuthorizationPortV1,
	type WecomConversationPreparationV1,
	type WecomDeliveryClaimV1,
	type WecomDeliveryStatusV1,
	type WecomDeliveryStorePortV1,
	type WecomIdentityPortV1,
	type WecomMediaProgressStatusV1,
	type WecomMediaRejectionV1,
	type WecomOutboundMediaV1,
	type WecomReceiptStatusV1,
	type WecomScopeV1,
	wecomConversationKeyForRotationV1,
	wecomReplyTimeoutNoticeLeadMsV1,
} from "@agent-infra/platform-core";
import { decodeVersionedAgentConfigurationRecord } from "./agent-configuration-record.js";
import { PostgresAgentManagementTransactionV1 } from "./agent-management.js";
import { agentManagementStateJsonSql } from "./agent-management-state-sql.js";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import postgres from "./observed-postgres.js";
import {
	awaitTaskAuthorizationDependencyV1,
	awaitTaskAuthorizationQueryV1,
} from "./personal-api-task-durable-use.js";
import {
	recordTaskSystemControlInTransactionV1,
	TaskAuthorizationStoreError,
} from "./task-authorization.js";

class WecomAuthorizationRevoked extends Error {}
class WecomAuthorizationDenied extends Error {}

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
		action === "denied" ||
		action === "conflict" ||
		action === "conversation_unavailable" ||
		action === "media_rejected"
			? "rejected"
			: ["failed", "unavailable", "unknown", "expired"].includes(action)
				? "failed"
				: "succeeded";
	const query = sql`insert into platform.audit_events (id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,request_id,agent_id,details) values (${randomUUID()},${eventKey},'system',${component},${`wecom.${action}`},'agent',${metadata.agentId},${outcome},${eventKey},${metadata.agentId},${sql.json({ originalPrincipal: principal, component, receiptId: eventKey, status: action })})`;
	await (signal ? awaitTaskAuthorizationQueryV1(query, signal) : query);
}

/**
 * #3229：回执结束（或发送中断转为 unknown）时收拢媒体进度：已开始但没有结果的媒体保持未确认
 * （unknown），尚未开始的媒体不再发送（failed）。
 */
async function settleReceiptMedia(
	sql: postgres.Sql | postgres.TransactionSql,
	receiptIds: readonly string[],
) {
	await sql`update platform.wecom_receipt_media set status=case when status='sending' then 'unknown' else 'failed' end,updated_at=now() where receipt_id in ${sql(receiptIds)} and status in ('pending','sending')`;
}

interface Row {
	id: string;
	request_digest: string;
	scope: WecomScopeV1;
	actor_id: string;
	task_boundary: TaskAuthorizationBoundaryV1;
	channel_revision: string;
	authorization_revision: string;
	connection_authorization_fact: WecomConnectionAuthorizationFactV1 | null;
	acceptance_status:
		| "accepted"
		| "busy"
		| "unavailable"
		| "new_conversation"
		| "media_rejected";
	conversation_id: string | null;
	execution_id: string | null;
	reply_handle: string;
	expires_at: Date;
	connection_bot_id: string | null;
	connection_fence: string | null;
	delivery_status: WecomDeliveryStatusV1;
	fence: number;
	media_rejection_reason: string | null;
	media_rejection_max_bytes: string | null;
}
function receipt(row: Row) {
	return {
		receiptId: row.id,
		status: row.acceptance_status,
		conversationId: row.conversation_id,
		executionId: row.execution_id,
	};
}
/** #3227：媒体拒绝回执的原因；数据库约束之外再校验一次，不认识的值按接收失败说明。 */
function mediaRejection(row: Row): WecomMediaRejectionV1 {
	const value = {
		reason: row.media_rejection_reason,
		maxBytes:
			row.media_rejection_max_bytes === null
				? null
				: Number(row.media_rejection_max_bytes),
	};
	return isWecomMediaRejectionV1(value)
		? value
		: { reason: "failed", maxBytes: null };
}
/** #2982：把有界读取的思考过程行转成 claim 字段；少读或不认识的行都按「没有读完」处理。 */
function thinkingClaim(
	rows: readonly { kind: string | null; text: string | null; total: string }[],
): Pick<WecomDeliveryClaimV1, "thinking"> {
	const parts = rows.flatMap(
		(row): { kind: "raw" | "summary"; text: string }[] => {
			const kind = row.kind;
			return (kind === "raw" || kind === "summary") && row.text
				? [{ kind, text: row.text }]
				: [];
		},
	);
	return parts.length
		? {
				thinking: {
					parts,
					complete: parts.length === Number(rows[0]?.total),
				},
			}
		: {};
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
	readonly #connectionAuthorization:
		| WecomConnectionAuthorizationPortV1
		| undefined;
	readonly #observe: (status: WecomDeliveryStatusV1) => void;
	constructor(options: {
		readonly databaseUrl: string;
		readonly userDirectory?: TaskUserDirectoryV1;
		readonly identity: WecomIdentityPortV1;
		readonly connectionAuthorization?: WecomConnectionAuthorizationPortV1;
		readonly connectionHolderId?: string;
		readonly observe?: (status: WecomDeliveryStatusV1) => void;
	}) {
		if (!options.identity) throw new Error("WeCom identity is required");
		this.#connectionHolderId = options.connectionHolderId ?? null;
		this.#userDirectory = options.userDirectory;
		this.#identity = options.identity;
		this.#connectionAuthorization = options.connectionAuthorization;
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
					configuration: decodeVersionedAgentConfigurationRecord(
						row.configuration,
					),
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
	async #readAdmissionAuthorityState(
		transaction: postgres.TransactionSql,
		agentId: string,
		signal: AbortSignal,
	): Promise<WecomAuthorityStateV1 | null> {
		const [row] = await awaitTaskAuthorizationQueryV1(
			transaction<
				{
					configuration: unknown;
					authorization_revision: string;
					management: WecomAuthorityStateV1["management"];
				}[]
			>`
				select c.configuration, a.authorization_revision,
					${transaction.unsafe(agentManagementStateJsonSql("app"))} as management
				from platform.agents a
				join platform.agent_applications app on app.agent_id = a.id
				join platform.agent_configuration_revisions c on c.agent_id = a.id and c.revision = a.current_configuration_revision
				where a.id = ${agentId}
			`,
			signal,
		);
		return row
			? {
					management: row.management,
					configuration: decodeVersionedAgentConfigurationRecord(
						row.configuration,
					),
					authorizationRevision: row.authorization_revision,
				}
			: null;
	}
	async #currentAuthorityInTransaction(
		transaction: postgres.TransactionSql,
		plan: WecomAcceptancePlanV1,
		boundary: TaskAuthorizationBoundaryV1,
		signal: AbortSignal,
	): Promise<
		| { readonly outcome: "allowed"; readonly authority: WecomAuthorityV1 }
		| { readonly outcome: "revoked"; readonly userId: string }
		| { readonly outcome: "denied" | "unavailable" }
	> {
		const run = <T extends readonly (object | undefined)[]>(
			query: postgres.PendingQuery<T>,
		) => awaitTaskAuthorizationQueryV1(query, signal);
		const resolved = await awaitTaskAuthorizationDependencyV1(
			() => this.#identity.resolveSender(plan.message),
			signal,
		);
		const user = resolved ? parseCurrentTaskUserV1(resolved) : null;
		if (!user || user.userId !== boundary.principal.id)
			return { outcome: "denied" };
		const [platformDisabled] = await run(
			transaction<{ user_id: string }[]>`
				select user_id from platform.platform_user_disables
				where user_id=${user.userId}
			`,
		);
		if (user.accountStatus === "disabled" || platformDisabled)
			return { outcome: "revoked", userId: user.userId };
		if (user.authorizationRevision !== boundary.identityRevision)
			return { outcome: "denied" };
		const authorization = createWecomAuthorizationV1({
			identity: {
				resolveSender: async () => user,
				activeUsers: async (ids) => {
					if (ids.length === 0) return [];
					const active = await awaitTaskAuthorizationDependencyV1(
						() => this.#identity.activeUsers(ids),
						signal,
					);
					const disabled = await run(
						transaction<{ user_id: string }[]>`
							select user_id from platform.platform_user_disables
							where user_id in ${transaction(ids)}
						`,
					);
					const disabledIds = new Set(disabled.map((row) => row.user_id));
					return active.filter((id) => !disabledIds.has(id));
				},
			},
			state: {
				readAuthorityState: (currentAgentId) =>
					this.#readAdmissionAuthorityState(
						transaction,
						currentAgentId,
						signal,
					),
			},
			connectionAuthorization: this.#connectionAuthorization,
		});
		const current = await awaitTaskAuthorizationDependencyV1(
			() =>
				authorization.authorize(
					plan.message,
					"use",
					boundary,
					plan.message.providerId,
				),
			signal,
		);
		if (current.outcome !== "allowed") return current;
		if (
			current.authority.actor.actorId !== plan.authority.actor.actorId ||
			current.authority.actor.agentId !== plan.authority.actor.agentId ||
			current.authority.actor.channelId !== plan.authority.actor.channelId ||
			current.authority.actor.authorizationRevision !==
				plan.authority.actor.authorizationRevision ||
			current.authority.channelRevision !== plan.authority.channelRevision ||
			current.authority.managementRevision !==
				plan.authority.managementRevision ||
			!sameWecomConnectionAuthorizationFactV1(
				current.authority.connectionAuthorizationFact,
				plan.authority.connectionAuthorizationFact,
			)
		)
			return { outcome: "denied" };
		return current;
	}
	async accept(
		plan: WecomAcceptancePlanV1,
		execute: Parameters<WecomChannelStorePortV1["accept"]>[1],
		callerSignal?: AbortSignal,
	): Promise<WecomAcceptanceV1> {
		return (await this.#admit(
			plan,
			{ execute },
			callerSignal,
		)) as WecomAcceptanceV1;
	}
	/**
	 * #3227：入站媒体在受理事务之外写入附件前，按与受理相同的授权复核、映射锁与当前轮次，
	 * 经同一幂等 createConversation 路径确定并提交当前 Conversation。不写回执，也不能轮换映射。
	 */
	async prepareConversation(
		plan: WecomAcceptancePlanV1,
		prepare: Parameters<
			NonNullable<WecomChannelStorePortV1["prepareConversation"]>
		>[1],
		callerSignal?: AbortSignal,
	): Promise<WecomConversationPreparationV1> {
		return (await this.#admit(
			plan,
			{ prepare },
			callerSignal,
		)) as WecomConversationPreparationV1;
	}
	async #admit(
		plan: WecomAcceptancePlanV1,
		work:
			| { readonly execute: Parameters<WecomChannelStorePortV1["accept"]>[1] }
			| {
					readonly prepare: Parameters<
						NonNullable<WecomChannelStorePortV1["prepareConversation"]>
					>[1];
			  },
		callerSignal?: AbortSignal,
	): Promise<WecomAcceptanceV1 | WecomConversationPreparationV1> {
		if (this.#closed) throw new TaskAuthorizationStoreError();
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
			const config = decodeVersionedAgentConfigurationRecord(
				agent.configuration,
			);
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
			const boundary = parseTaskAuthorizationBoundaryV1(
				plan.authority.actor.taskBoundary,
			);
			const current = await this.#currentAuthorityInTransaction(
				sql,
				plan,
				boundary,
				signal,
			);
			if (current.outcome === "revoked") {
				await revokeUserTasksInTransaction(
					sql,
					current.userId,
					{
						workerId: this.#connectionHolderId ?? "platform-api",
						traceId: plan.eventKey,
						requestId: plan.eventKey,
					},
					signal,
				);
				return readyToCommit({ outcome: "denied" as const });
			}
			if (current.outcome !== "allowed") return reject(current.outcome);
			const conversationUseCase = (business: postgres.TransactionSql) =>
				createConversationExecutionUseCaseV1({
					transaction: new PostgresConversationExecutionTransactionV1({
						transaction: business,
						userDirectory: this.#userDirectory,
						signal,
					}),
					authorization: {
						async authorize() {
							return {
								outcome: "allowed",
								authority: plan.authority.actor,
							};
						},
					},
				});
			// #3184：同一映射的消息与 `/new` 在事务内串行，轮次读写与 Conversation 创建原子提交。
			const lockMapping = async (business: postgres.TransactionSql) => {
				await run(
					business`select pg_advisory_xact_lock(hashtextextended(${`wecom-conversation:${plan.conversationKey}`},0))`,
				);
				const [stored] = await run(
					business<
						{ rotation: number }[]
					>`select rotation from platform.wecom_conversation_rotations where mapping_key=${plan.conversationKey}`,
				);
				return stored?.rotation ?? 0;
			};
			const requireFinalAuthority = async (
				business: postgres.TransactionSql,
			) => {
				const final = await this.#currentAuthorityInTransaction(
					business,
					plan,
					boundary,
					signal,
				);
				if (final.outcome === "revoked") throw new WecomAuthorizationRevoked();
				if (final.outcome === "denied") throw new WecomAuthorizationDenied();
				if (final.outcome !== "allowed")
					throw new TaskAuthorizationStoreError();
			};
			if ("prepare" in work) {
				// 已有回执时由受理路径重放，这里不再创建或读取会话。
				const [received] = await run(
					sql<
						{ id: string }[]
					>`select id from platform.wecom_receipts where id=${plan.eventKey}`,
				);
				if (received) return readyToCommit({ outcome: "received" as const });
				let prepared: { conversationId: string; unavailable: boolean } | null =
					null;
				try {
					await sql.savepoint(async (business) => {
						const rotation = await lockMapping(business);
						const result = await awaitTaskAuthorizationDependencyV1(
							() =>
								work.prepare(conversationUseCase(business), {
									conversationKey: wecomConversationKeyForRotationV1(
										plan.conversationKey,
										rotation,
									),
									// 映射只在受理事务里轮换。
									startNewConversation: async () => {
										throw new TaskAuthorizationStoreError();
									},
								}),
							signal,
						);
						if (
							typeof result?.conversationId !== "string" ||
							!result.conversationId ||
							typeof result.unavailable !== "boolean"
						)
							throw new TaskAuthorizationStoreError();
						prepared = {
							conversationId: result.conversationId,
							unavailable: result.unavailable,
						};
						await requireFinalAuthority(business);
					});
				} catch (error) {
					if (error instanceof WecomAuthorizationDenied)
						return reject("denied");
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
				if (!prepared) throw new TaskAuthorizationStoreError();
				return readyToCommit({
					outcome: "prepared" as const,
					...(prepared as { conversationId: string; unavailable: boolean }),
				});
			}
			const execute = work.execute;
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
						const final = await this.#currentAuthorityInTransaction(
							business,
							plan,
							boundary,
							signal,
						);
						if (final.outcome === "revoked")
							throw new WecomAuthorizationRevoked();
						if (final.outcome === "denied")
							throw new WecomAuthorizationDenied();
						if (final.outcome !== "allowed")
							throw new TaskAuthorizationStoreError();
					});
				} catch (error) {
					if (error instanceof WecomAuthorizationDenied)
						return reject("denied");
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
						status: WecomReceiptStatusV1;
						conversationId: string | null;
						executionId: string | null;
				  }
				| undefined;
			try {
				await sql.savepoint(async (business) => {
					const rotation = await lockMapping(business);
					let rotated = false;
					const executionResult = await awaitTaskAuthorizationDependencyV1(
						() =>
							execute(conversationUseCase(business), {
								conversationKey: wecomConversationKeyForRotationV1(
									plan.conversationKey,
									rotation,
								),
								startNewConversation: async () => {
									if (rotated) throw new TaskAuthorizationStoreError();
									rotated = true;
									const changed = await run(
										business<
											{ rotation: number }[]
										>`insert into platform.wecom_conversation_rotations (mapping_key,agent_id,rotation,created_at,updated_at) values (${plan.conversationKey},${plan.message.agentId},${rotation + 1},now(),now())
    on conflict (mapping_key) do update set rotation=${rotation + 1},updated_at=now() where platform.wecom_conversation_rotations.rotation=${rotation} returning rotation`,
									);
									// 映射锁之外有人改过轮次时失败关闭，不静默丢掉这次 /new。
									if (changed.length !== 1)
										throw new TaskAuthorizationStoreError();
								},
							}),
						signal,
					);
					// 新会话与入站媒体拒绝（#3227）的回执不关联 Conversation；其余状态都必须关联映射到的
					// Conversation。只有媒体拒绝带原因，且原因必须完整。
					const mediaRejection = executionResult.mediaRejection;
					if (
						executionResult.status === "new_conversation"
							? !rotated ||
								executionResult.conversationId !== null ||
								executionResult.executionId !== null ||
								mediaRejection !== undefined
							: executionResult.status === "media_rejected"
								? rotated ||
									executionResult.conversationId !== null ||
									executionResult.executionId !== null ||
									!isWecomMediaRejectionV1(mediaRejection)
								: rotated ||
									!executionResult.conversationId ||
									mediaRejection !== undefined
					)
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
					// 回执只保存拒绝原因与上限，不保存下载地址、aeskey 或媒体内容。
					await run(business`insert into platform.wecom_receipts (id,request_digest,scope,actor_id,task_boundary,channel_revision,authorization_revision,connection_authorization_fact,acceptance_status,conversation_id,execution_id,reply_handle,expires_at,created_at,updated_at,connection_bot_id,connection_fence,media_rejection_reason,media_rejection_max_bytes)
    values (${plan.eventKey},${plan.requestDigest},${business.json(scope)},${plan.authority.actor.actorId},${business.json(parseTaskAuthorizationBoundaryV1(plan.authority.actor.taskBoundary) as unknown as postgres.JSONValue)},${plan.authority.channelRevision},${plan.authority.actor.authorizationRevision},${plan.authority.connectionAuthorizationFact ? business.json(plan.authority.connectionAuthorizationFact as unknown as postgres.JSONValue) : null},${accepted.status},${accepted.conversationId},${accepted.executionId},${plan.message.replyHandle},${new Date(plan.message.replyExpiresAt)},now(),now(),${plan.connectionFence?.botId ?? null},${plan.connectionFence?.fence ?? null},${mediaRejection?.reason ?? null},${mediaRejection?.maxBytes ?? null})`);
					await audit(
						business,
						plan.eventKey,
						accepted.status === "unavailable"
							? "conversation_unavailable"
							: accepted.status === "new_conversation"
								? "conversation_started"
								: accepted.status === "media_rejected"
									? "media_rejected"
									: "accepted",
						{
							agentId: plan.message.agentId,
							actorId: plan.authority.actor.actorId,
						},
						plan.connectionFence ? "platform-worker" : "platform-api",
						signal,
					);
					await requireFinalAuthority(business);
				});
			} catch (error) {
				if (error instanceof WecomAuthorizationDenied) return reject("denied");
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
			// #3229：发送中断的回执里，已开始的媒体保持未确认，尚未开始的媒体不再发送。
			if (expired.length)
				await settleReceiptMedia(
					sql,
					expired.map((row) => row.id),
				);
			for (const row of expired)
				await audit(
					sql,
					row.id,
					"unknown",
					{ agentId: row.scope.agentId, actorId: row.actor_id },
					"platform-worker",
				);
			// #3076：状态响应或恢复路径可能先把执行记为 completed，Runtime 事件稍后才排空入库。
			// 答案只来自已落库的 text.delta，所以 completed 要等 Runtime 的终态事件落库（它之前的
			// 正文与结果文件都已按序提交，同 #1524 关闭 outbox 的判据）；failed、cancelled 只发固定
			// 文案，不必等待。
			// #3077：回答未就绪的已受理回执在有效期最后 30 秒内领取，由 Core 发送超时提示；已过期的照旧领取。
			// #3374：同一 Execution 有更晚受理的回执时，这条附件消息已与随后的消息合并为一个任务，立即领取，
			// 由 Core 以“已合并”说明结束它的 stream；回复只由最晚受理的回执承担。
			const [row] = await sql<
				(Row & {
					execution_status: string | null;
					answer_ready: boolean;
					merged: boolean;
					conversation_status: string | null;
					conversation_isolation_pending: boolean;
				})[]
			>`select r.*,e.status as execution_status,ready.answer_ready,merging.merged,c.status as conversation_status,exists (select 1 from platform.conversation_generation_tombstones t where t.conversation_id=r.conversation_id and t.status='pending') as conversation_isolation_pending from platform.wecom_receipts r left join platform.conversation_executions e on e.execution_id=r.execution_id left join platform.conversations c on c.id=r.conversation_id
    cross join lateral (select coalesce(e.status in ('failed','cancelled') or (e.status='completed' and exists (select 1 from platform.conversation_events t where t.conversation_id=e.conversation_id and t.execution_id=e.execution_id and t.source='runtime' and t.event_type='execution.status' and t.event_payload->>'status'='completed' and t.runtime_cursor is not null)),false) as answer_ready) ready
    cross join lateral (select r.acceptance_status='accepted' and r.execution_id is not null and exists (select 1 from platform.wecom_receipts later where later.execution_id=r.execution_id and later.acceptance_status='accepted' and (later.created_at,later.id)>(r.created_at,r.id)) as merged) merging
    where (r.connection_bot_id is null or r.expires_at<=now() or exists (select 1 from platform.wecom_connections w where w.bot_id=r.connection_bot_id and w.fence=r.connection_fence and w.holder_id=${this.#connectionHolderId} and w.lease_until>clock_timestamp())) and (r.delivery_status='pending' or (r.delivery_status='claimed' and r.lease_until<=now())) and (r.acceptance_status!='accepted' or merging.merged or ready.answer_ready or r.expires_at<=now()+(${wecomReplyTimeoutNoticeLeadMsV1}::bigint*interval '1 millisecond')) order by r.created_at limit 1 for update of r skip locked`;
			if (!row) return null;
			await sql`update platform.wecom_receipts set delivery_status='claimed',fence=fence+1,lease_until=now()+interval '30 seconds',updated_at=now() where id=${row.id}`;
			// 已合并的回执只发固定说明，不读取答案、结果文件或思考过程。
			const answerExecutionId = row.merged ? null : row.execution_id;
			const [size] = answerExecutionId
				? await sql<
						{ bytes: string; count: string }[]
					>`select coalesce(sum(octet_length(event_payload->>'text')),0) as bytes,count(*) as count from platform.conversation_events where execution_id=${answerExecutionId} and event_type='text.delta'`
				: [];
			const deltas =
				answerExecutionId &&
				size &&
				Number(size.bytes) <= 20480 &&
				Number(size.count) <= 10000
					? await sql<
							{ event_payload: { text?: string } }[]
						>`select event_payload from platform.conversation_events where execution_id=${answerExecutionId} and event_type='text.delta' order by sequence`
					: [];
			// #3229：正文超限时不读取，并明确告诉 Core，回复按原规则失败而不是只发结果文件。
			const answerTooLong = Boolean(
				answerExecutionId &&
					size &&
					(Number(size.bytes) > 20480 || Number(size.count) > 10000),
			);
			const resultFiles =
				answerExecutionId && row.execution_status === "completed"
					? await sql<
							{
								file_id: string;
								name: string;
								media_type: string;
								size_bytes: string;
								workspace_reference: string | null;
								sequence: string;
							}[]
						>`select file_id,name,media_type,size_bytes,workspace_reference,sequence from (
							select distinct on (e.event_payload->>'fileId')
								e.event_payload->>'fileId' as file_id,
								e.event_payload->>'name' as name,
								e.event_payload->>'mediaType' as media_type,
								e.event_payload->>'sizeBytes' as size_bytes,
								e.event_payload->>'workspaceReference' as workspace_reference,
								e.sequence::text as sequence
							from platform.conversation_events e
							join platform.files f
								on f.file_id=e.event_payload->>'fileId'
								and f.conversation_id=e.conversation_id
								and f.record->>'executionId'=e.execution_id
								and f.record->>'kind'='result'
								and f.record->>'status'='available'
								and coalesce(f.record->>'objectVersion','')<>''
								and coalesce(f.record->>'etag','')<>''
								and f.record->'descriptor'->>'name'=e.event_payload->>'name'
								and f.record->'descriptor'->>'mediaType'=e.event_payload->>'mediaType'
								and f.record->'descriptor'->>'sizeBytes'=e.event_payload->>'sizeBytes'
								and coalesce(f.record->>'workspaceReference','')=coalesce(e.event_payload->>'workspaceReference','')
							where e.execution_id=${row.execution_id}
								and e.event_type='result.file'
							order by e.event_payload->>'fileId',e.sequence
						) confirmed order by sequence::bigint`
					: [];
			// #2982：只有完成的回答读取思考过程。按顺序只取到累计约 20480 字节（最多 10000 条）的前缀，
			// 读取量有界；没有读完时 Core 截短并附提示，答案照常发送。
			const thinking =
				answerExecutionId &&
				row.acceptance_status === "accepted" &&
				row.execution_status === "completed"
					? await sql<
							{ kind: string | null; text: string | null; total: string }[]
						>`select kind,text,total from (
							select e.event_payload->>'kind' as kind,
								e.event_payload->>'text' as text,
								e.sequence,
								coalesce(sum(octet_length(e.event_payload->>'text')) over (order by e.sequence rows between unbounded preceding and 1 preceding),0) as before_bytes,
								count(*) over () as total
							from platform.conversation_events e
							where e.execution_id=${row.execution_id}
								and e.event_type='reasoning.delta'
								and e.source='runtime'
						) reasoning where before_bytes<20480 order by sequence limit 10000`
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
				...(row.connection_authorization_fact
					? { connectionAuthorizationFact: row.connection_authorization_fact }
					: {}),
				acceptanceStatus: row.acceptance_status,
				...(row.acceptance_status === "media_rejected"
					? { mediaRejection: mediaRejection(row) }
					: {}),
				executionStatus: row.execution_status,
				answerReady: row.answer_ready,
				...(row.merged ? { merged: true } : {}),
				// #3184：失败文案按回执所属会话的当前状态附带 /new 指引；代次隔离与
				// status=unavailable 一样拒绝后续消息（ConversationExecutionTask 的提交判据），
				// 所以同样算作会话不可用。
				...(row.conversation_status === "unavailable" ||
				row.conversation_isolation_pending
					? { conversationUnavailable: true }
					: {}),
				textDeltas: deltas.map((d) => d.event_payload.text ?? ""),
				...(answerTooLong ? { answerTooLong: true } : {}),
				conversationId: row.conversation_id,
				executionId: row.execution_id,
				media: resultFiles.flatMap((file) => {
					const sizeBytes = Number(file.size_bytes);
					return Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
						? [
								{
									fileId: file.file_id,
									name: file.name,
									mediaType: file.media_type,
									sizeBytes,
									workspaceReference: file.workspace_reference ?? null,
								},
							]
						: [];
				}),
				...thinkingClaim(thinking),
			};
		});
		for (let i = 0; i < unknown; i++) this.#observe("unknown");
		return claim;
	}
	async prepare(
		claim: WecomDeliveryClaimV1,
		authority: WecomAuthorityV1,
		media: readonly WecomOutboundMediaV1[] = [],
	): Promise<boolean> {
		if (
			!sameWecomConnectionAuthorizationFactV1(
				authority.connectionAuthorizationFact,
				claim.connectionAuthorizationFact,
			)
		)
			return false;
		// #3229：每次回复最多 10 个媒体，按发送顺序记录；文件引用必须是本次领取给出的结果文件。
		const claimed = new Set((claim.media ?? []).map((file) => file.fileId));
		if (
			media.length > 10 ||
			new Set(media.map((file) => file.fileId)).size !== media.length ||
			media.some(
				(file) =>
					!claimed.has(file.fileId) ||
					!["image", "video", "file"].includes(file.kind),
			)
		)
			throw new TaskAuthorizationStoreError();
		return this.#sql.begin(async (sql) => {
			// 20,480 bytes can need eleven UTF-8 parts with 10-second sends.
			const rows =
				await sql`update platform.wecom_receipts set delivery_status='sending',lease_until=now()+(case when scope->>'kind'='wecom_app' then interval '3 minutes' else interval '30 seconds' end),updated_at=now() where id=${claim.receiptId} and fence=${claim.fence} and delivery_status='claimed' and lease_until>now() and expires_at>now() and (connection_bot_id is null or exists (select 1 from platform.wecom_connections w where w.bot_id=connection_bot_id and w.fence=connection_fence and w.holder_id=${this.#connectionHolderId} and w.lease_until>clock_timestamp())) and exists (
    select 1 from platform.agents a join platform.agent_applications m on m.agent_id=a.id join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision
    where a.id=${claim.scope.agentId} and a.authorization_revision=${authority.actor.authorizationRevision} and m.management_revision=${authority.managementRevision} and m.status='available' and m.service_availability='ready' and c.configuration->>'channelRevision'=${claim.channelRevision}
   ) returning id`;
			if (rows.length) {
				for (const [ordinal, file] of media.entries())
					await sql`insert into platform.wecom_receipt_media (receipt_id,ordinal,file_id,kind,status,created_at,updated_at) values (${claim.receiptId},${ordinal},${file.fileId},${file.kind},'pending',now(),now())`;
				await audit(
					sql,
					claim.receiptId,
					"sending",
					{ agentId: claim.scope.agentId, actorId: claim.actorId },
					"platform-worker",
				);
			}
			return rows.length === 1;
		});
	}
	/**
	 * #3229：按文件记录发送进度。`sending` 要求回执仍由本次领取持有（fence、发送中、租约与回复
	 * 有效期、长连接持有者）且该文件尚未开始，同时延长发送租约，覆盖读取与分片上传；结果只能跟在
	 * `sending` 之后。回执行锁与 claim 的租约到期处理互斥。
	 */
	async progressMedia(
		claim: WecomDeliveryClaimV1,
		ordinal: number,
		status: WecomMediaProgressStatusV1,
	): Promise<boolean> {
		if (
			!Number.isSafeInteger(ordinal) ||
			ordinal < 0 ||
			ordinal > 9 ||
			!["sending", "sent", "failed", "unknown"].includes(status)
		)
			throw new TaskAuthorizationStoreError();
		const starting = status === "sending";
		return this.#sql.begin(async (sql) => {
			const [receipt] = starting
				? await sql`select id from platform.wecom_receipts where id=${claim.receiptId} and fence=${claim.fence} and delivery_status='sending' and lease_until>now() and expires_at>now() and (connection_bot_id is null or exists (select 1 from platform.wecom_connections w where w.bot_id=connection_bot_id and w.fence=connection_fence and w.holder_id=${this.#connectionHolderId} and w.lease_until>clock_timestamp())) for update`
				: await sql`select id from platform.wecom_receipts where id=${claim.receiptId} and fence=${claim.fence} and delivery_status='sending' for update`;
			if (!receipt) return false;
			const changed =
				await sql`update platform.wecom_receipt_media set status=${status},updated_at=now() where receipt_id=${claim.receiptId} and ordinal=${ordinal} and status=${starting ? "pending" : "sending"} returning ordinal`;
			if (changed.length !== 1) return false;
			if (starting)
				await sql`update platform.wecom_receipts set lease_until=greatest(lease_until,now()+interval '300 seconds'),updated_at=now() where id=${claim.receiptId}`;
			return true;
		});
	}
	async finish(
		claim: WecomDeliveryClaimV1,
		status: "sent" | "failed" | "unknown" | "cancelled" | "expired",
	): Promise<void> {
		const changed = await this.#sql.begin(async (sql) => {
			const rows =
				await sql`update platform.wecom_receipts set delivery_status=${status},updated_at=now() where id=${claim.receiptId} and fence=${claim.fence} and delivery_status in ('claimed','sending') returning id`;
			if (rows.length) {
				await settleReceiptMedia(sql, [claim.receiptId]);
				await audit(
					sql,
					claim.receiptId,
					status,
					{ agentId: claim.scope.agentId, actorId: claim.actorId },
					"platform-worker",
				);
			}
			return rows.length > 0;
		});
		if (changed) this.#observe(status);
	}
	async scopeForExecution(
		executionId: string,
		actorId: string,
		channelId: string,
	) {
		// #3374：合并后的 Execution 有多条回执，取最晚受理的一条（承担回复的文字消息）。
		const [row] = await this.#sql<
			Row[]
		>`select r.* from platform.wecom_receipts r join platform.conversation_executions e on e.execution_id=r.execution_id where r.execution_id=${executionId} and r.actor_id=${actorId} and e.channel_id=${channelId} order by r.created_at desc, r.id desc limit 1`;
		return row
			? {
					scope: row.scope,
					channelRevision: row.channel_revision,
					connectionAuthorizationFact: row.connection_authorization_fact,
				}
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
