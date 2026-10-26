import type {
	ConversationDispatchClaimDecisionV1,
	ConversationDispatchClaimV1,
	TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import {
	executionKeyProjection,
	executionPrincipalProjection,
	maximumSafeCounter,
	type OutboxRow,
	requireSafeCounter,
	StaleDispatchLease,
	safeCounter,
	type Transaction,
} from "./conversation-dispatch-common.js";
import {
	bindingMatches,
	cancelStoppedTurn,
	isolationProjection,
	lockConversation,
	lockExecution,
	lockOutbox,
	readGenerationIsolation,
	readInitialTurnInput,
	readMessage,
	readStop,
} from "./conversation-dispatch-sql.js";
import {
	finishWaitingTask,
	lockWaitingTaskAuthority,
	observeStopConfirmationTimeout,
	recordTaskStatus,
	revalidateWaitingTask,
	waitingDecision,
} from "./conversation-dispatch-task.js";
import {
	exactPayload,
	isBrowserHandoff,
	isExecutionOperation,
	isTurn,
	operation,
	terminal,
} from "./conversation-dispatch-validation.js";

/**
 * #2919：payload 已不合当前规则的 native capability 条目（例如 #2951 之前写入的历史参数
 * 摘要）永远认领不到，却会在每次发现时被扫到。所属执行已终态时它不会再有任何工作，
 * 也不会再触达 Runtime：按有界原因关闭。执行未终态的条目保持原样，不在这里改执行。
 */
async function retireInvalidNativeCapability(
	transaction: Transaction,
	outbox: OutboxRow,
): Promise<boolean> {
	if (
		(outbox.operation !== "conversation.native-capability.invoke.v1" &&
			outbox.operation !== "conversation.native-capability.invoke.v2") ||
		(outbox.status !== "pending" && outbox.status !== "retry_scheduled")
	)
		return false;
	const raw = outbox.payload;
	const executionId =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>).executionId
			: undefined;
	if (typeof executionId !== "string" || !executionId) return false;
	const [execution] = await transaction<{ status: string }[]>`
		select status from platform.conversation_executions
		where execution_id = ${executionId} and conversation_id = ${outbox.scope_id}
		for share
	`;
	if (
		!execution ||
		!["completed", "failed", "cancelled"].includes(execution.status)
	)
		return false;
	const fence = requireSafeCounter(outbox.delivery_fence, 0) + 1;
	const closed = await transaction<{ id: string }[]>`
		update platform.outbox_items
		set status = 'failed', lease_owner = null, lease_expires_at = null,
			delivery_fence = ${fence}, updated_at = clock_timestamp()
		where id = ${outbox.id} and status in ('pending', 'retry_scheduled')
		returning id
	`;
	if (closed.length !== 1) return false;
	await transaction`
		insert into platform.persisted_events
			(event_id, stream_id, sequence, stream_cursor, event_type, payload,
			 trace_id, occurred_at)
		values
			(${`outbox:${outbox.id}:${fence}`}, ${`outbox:${outbox.id}`}, ${fence},
			 ${fence}, 'outbox.failed',
			 jsonb_build_object(
				'attemptCount', ${outbox.attempt_count}::int,
				'deliveryFence', ${String(fence)}::text,
				'errorCode', 'NATIVE_CAPABILITY_PAYLOAD_INVALID'
			 ), ${outbox.trace_id}, clock_timestamp())
	`;
	return true;
}

export async function claimWork(
	transaction: Transaction,
	input: {
		readonly schemaVersion: 1;
		readonly itemId: string;
		readonly workerId: string;
		readonly leaseDurationMs: number;
	},
	userDirectory?: TaskUserDirectoryV1,
): Promise<ConversationDispatchClaimDecisionV1> {
	// Application/use governance precedes the original Agent -> Conversation -> Outbox locks.
	await lockWaitingTaskAuthority(transaction, input.itemId);
	// Holds the Agent and its application row in the established lock order.
	await transaction`
		select aa.status, aa.desired_state, aa.service_availability
		from platform.agents a
		join platform.conversations c on c.agent_id = a.id
		join platform.outbox_items o on o.scope_id = c.id and o.scope_type = 'conversation'
		join platform.agent_applications aa on aa.agent_id = a.id
		where o.id = ${input.itemId}
		for share of a, aa
	`;
	const outbox = await lockOutbox(transaction, input.itemId);
	if (outbox?.scope_type !== "conversation") return { outcome: "stale" };
	const conversation = await lockConversation(transaction, outbox.scope_id);
	if (!conversation) return { outcome: "stale" };
	const isolation = await readGenerationIsolation(
		transaction,
		conversation.id,
		requireSafeCounter(conversation.session_generation, 1),
	);
	const isolationWork = isolation?.item_id === input.itemId;
	if (!isolationWork && outbox.status === "succeeded")
		return { outcome: "succeeded" };
	if (!isolationWork && outbox.status === "failed")
		return { outcome: "failed" };
	const decisionAt = outbox.decision_at.getTime();
	const selectedOperation = operation(outbox.operation);
	if (!selectedOperation) return { outcome: "stale" };
	const payload = exactPayload(outbox.payload, selectedOperation);
	if (!payload) {
		if (await retireInvalidNativeCapability(transaction, outbox))
			return { outcome: "failed" };
		return { outcome: "stale" };
	}
	const execution = await lockExecution(
		transaction,
		payload.conversationId,
		payload.executionId,
	);
	const stop = execution
		? await readStop(transaction, payload.executionId)
		: undefined;
	if (
		outbox.status === "processing" &&
		(outbox.lease_expires_at?.getTime() ?? Number.POSITIVE_INFINITY) >
			decisionAt &&
		!(
			selectedOperation === "conversation.turn.stop.v1" &&
			stop &&
			stop.confirmation_timed_out_at === null &&
			stop.confirmation_deadline.getTime() <= decisionAt
		)
	)
		return { outcome: "busy" };
	if (
		outbox.status !== "processing" &&
		!outbox.available_now &&
		!(
			selectedOperation === "conversation.turn.stop.v1" &&
			stop &&
			stop.confirmation_timed_out_at === null &&
			stop.confirmation_deadline.getTime() <= decisionAt
		) &&
		!(
			execution?.status === "waiting" &&
			((outbox.status === "pending" && outbox.waiting_available) ||
				(execution.task_wait_deadline?.getTime() ?? Number.POSITIVE_INFINITY) <=
					decisionAt)
		)
	)
		return { outcome: "busy" };
	if (
		!conversation ||
		!execution ||
		!bindingMatches(
			outbox,
			payload,
			conversation,
			execution,
			execution.status === "waiting" ? "waiting-settlement" : "business",
		)
	) {
		return { outcome: "stale" };
	}
	if (
		isBrowserHandoff(selectedOperation) &&
		execution.status !== "submitted" &&
		execution.status !== "processing"
	)
		return { outcome: "stale" };
	if (execution.status === "waiting") {
		if (selectedOperation !== "conversation.turn.submit.v1")
			return { outcome: "stale" };
		const [agent] = await transaction<
			{
				status: string | null;
				desired_state: string | null;
				service_availability: string | null;
			}[]
		>`
			select status, desired_state, service_availability
			from platform.agent_applications where agent_id = ${execution.agent_id}
		`;
		const state = { outbox, conversation, execution };
		if (
			!(await revalidateWaitingTask(
				transaction,
				state,
				input.workerId,
				userDirectory,
			))
		)
			return { outcome: "failed" };
		const decision = await waitingDecision(
			transaction,
			state,
			agent,
			Boolean(isolation),
		);
		if (decision.outcome === "fail") {
			await finishWaitingTask(
				transaction,
				state,
				"failed",
				decision.reason,
				input.workerId,
			);
			return { outcome: "failed" };
		}
		if (decision.outcome === "wait") return { outcome: "busy" };
	}
	// #3373：只核实状态的恢复认领（Execution 为 processing/unknown，沿原操作查询，不提交新 Turn）
	// 不以 Sandbox 就绪为前置；Sandbox、Agent Pod 或 Owner 重启期间查询失败按可重试处理，
	// 墙钟恢复预算继续计时（Runtime HLD §7.3）。首次投递与重提仍须 Sandbox 就绪。原生能力调用
	// 只有记录了 Host Session Ref 时才沿原操作查询，否则恢复会重放投递，仍须 Sandbox 就绪。
	const statusRecovery =
		isExecutionOperation(selectedOperation) &&
		(execution.status === "processing" || execution.status === "unknown") &&
		(isTurn(selectedOperation) || conversation.host_session_ref !== null);
	if (
		!conversation.sandbox_ready &&
		!isolationWork &&
		selectedOperation !== "conversation.turn.stop.v1" &&
		!payload.metadataRecovery &&
		!statusRecovery
	)
		return { outcome: "busy" };
	if (
		isolation &&
		!isolationWork &&
		selectedOperation !== "conversation.turn.stop.v1" &&
		!payload.metadataRecovery
	)
		return { outcome: "busy" };
	if (
		isolationWork &&
		(isolation?.execution_id !== execution.execution_id ||
			isolation.original_principal.id !== execution.actor_id)
	)
		return { outcome: "stale" };
	if (
		payload.metadataRecovery &&
		(!isTurn(selectedOperation) ||
			!terminal(execution.status) ||
			!execution.last_runtime_cursor ||
			!conversation.host_session_ref ||
			(isolation && isolation.original_principal.id !== execution.actor_id))
	)
		return { outcome: "stale" };
	const message = payload.messageId
		? await readMessage(transaction, payload.conversationId, payload.messageId)
		: undefined;

	if (
		(payload.messageId !== null) !== (message !== undefined) ||
		(message &&
			(message.actor_id !== execution.actor_id ||
				message.role !== "user" ||
				message.status !== "submitted" ||
				(selectedOperation !== "conversation.turn.regenerate.v1" &&
					message.execution_id !== execution.execution_id))) ||
		(selectedOperation === "conversation.turn.stop.v1" && !stop) ||
		(payload.stopRequestId !== null &&
			stop &&
			(stop.execution_id !== execution.execution_id ||
				stop.stop_request_id !== payload.stopRequestId))
	) {
		return { outcome: "stale" };
	}
	if (
		isExecutionOperation(selectedOperation) &&
		execution.status === "submitted" &&
		stop?.status === "submitted"
	) {
		await cancelStoppedTurn(
			transaction,
			outbox,
			conversation,
			execution,
			stop,
			payload,
		);
		await recordTaskStatus(
			transaction,
			{ outbox, conversation, execution },
			"cancelled",
			input.workerId,
		);
		return { outcome: "succeeded" };
	}
	const stopConfirmationTimedOut = await observeStopConfirmationTimeout(
		transaction,
		{ outbox, conversation, execution },
		input.workerId,
	);
	const previousAttempt = requireSafeCounter(outbox.attempt_count);
	const previousFence = safeCounter(outbox.delivery_fence);
	const executionFence = safeCounter(execution.delivery_fence);
	if (
		previousFence === undefined ||
		executionFence === undefined ||
		previousFence >= maximumSafeCounter ||
		previousAttempt >= maximumSafeCounter ||
		(isolationWork && executionFence > previousFence) ||
		(isExecutionOperation(selectedOperation) &&
			!isolationWork &&
			(terminal(execution.status)
				? executionFence > previousFence
				: executionFence !== previousFence))
	) {
		return { outcome: "stale" };
	}
	const nextFence = previousFence + 1;
	const claimedRows = await transaction<{ id: string }[]>`
		update platform.outbox_items
		set status = 'processing', attempt_count = attempt_count + 1,
			lease_owner = ${input.workerId},
			lease_expires_at = clock_timestamp() +
				(${input.leaseDurationMs}::bigint * interval '1 millisecond'),
			delivery_fence = ${nextFence}, updated_at = clock_timestamp()
		where id = ${outbox.id} and delivery_fence = ${previousFence}
		returning id
	`;
	if (claimedRows.length !== 1) throw new StaleDispatchLease();
	let currentExecutionFence = executionFence;
	const currentExecutionStatus = execution.status;
	if (
		isExecutionOperation(selectedOperation) &&
		(!terminal(execution.status) || isolationWork)
	) {
		const updated = await transaction<{ execution_id: string }[]>`
			update platform.conversation_executions
			set delivery_fence = ${nextFence}, updated_at = clock_timestamp()
			where execution_id = ${execution.execution_id}
				and conversation_id = ${conversation.id}
				and session_generation = ${payload.sessionGeneration}
				and delivery_fence = ${executionFence}
				and status = ${execution.status}
			returning execution_id
		`;
		if (updated.length !== 1) throw new StaleDispatchLease();
		currentExecutionFence = nextFence;
	}
	const [terminalEvent] =
		terminal(execution.status) && execution.last_runtime_cursor
			? await transaction<{ seen: boolean }[]>`
			select exists (
				select 1 from platform.conversation_events
				where conversation_id = ${conversation.id} and execution_id = ${execution.execution_id}
					and source = 'runtime' and event_type = 'execution.status'
					and event_payload->>'status' = ${execution.status} and runtime_cursor is not null
			) as seen
		`
			: [];
	// #3373：墙钟恢复预算与未提交重提窗口都按数据库时钟计算，Core 只比较时长。
	const [recovery] =
		currentExecutionStatus === "unknown"
			? await transaction<{ elapsed_ms: string | null }[]>`
			select greatest(0, floor(extract(epoch from (clock_timestamp() - unknown_since)) * 1000))::bigint::text as elapsed_ms
			from platform.conversation_executions
			where execution_id = ${execution.execution_id} and conversation_id = ${conversation.id}
		`
			: [];
	const [notSubmitted] = isTurn(selectedOperation)
		? await transaction<{ count: number; elapsed_ms: string | null }[]>`
			select count(*)::int as count,
				greatest(0, floor(extract(epoch from (clock_timestamp() - min(occurred_at))) * 1000))::bigint::text as elapsed_ms
			from platform.persisted_events
			where stream_id = ${`outbox:${outbox.id}`} and event_type = 'outbox.retry_scheduled'
				and payload->>'errorCode' = 'RUNTIME_TURN_NOT_SUBMITTED'
		`
		: [];
	// #3374：新消息 Turn 的输入包含合并窗口内并入同一 Execution 的消息；重新生成仍只读源消息。
	const turnInput =
		message && selectedOperation === "conversation.turn.submit.v1"
			? await readInitialTurnInput(
					transaction,
					conversation.id,
					execution.execution_id,
					message,
				)
			: undefined;
	const inputFiles =
		message && !turnInput
			? await transaction<{ file_id: string }[]>`
        select file_id from platform.files
        where conversation_id = ${conversation.id}
          and record->>'messageId' = ${payload.messageId}
          and record->>'kind' = 'attachment' and record->>'status' = 'available'
        order by file_id
    `
			: [];
	const claim: ConversationDispatchClaimV1 = {
		schemaVersion: 1,
		sandbox: conversation.sandbox,
		principal: executionPrincipalProjection(execution),
		...executionKeyProjection(execution),
		...(execution.task_wait_order === null
			? {}
			: { taskWaitOrder: requireSafeCounter(execution.task_wait_order, 1) }),
		itemId: outbox.id,
		leaseOwner: input.workerId,
		operation: selectedOperation,
		attemptCount: previousAttempt + 1,
		requestId: outbox.request_id as string,
		traceId: outbox.trace_id,
		...(outbox.trace_parent ? { traceParent: outbox.trace_parent } : {}),
		agentId: execution.agent_id,
		actorId: execution.actor_id,
		channelId: execution.channel_id,
		conversationId: conversation.id,
		executionId: execution.execution_id,
		turnId: execution.turn_id,
		messageId: payload.messageId,
		stopRequestId: payload.stopRequestId,
		sessionGeneration: payload.sessionGeneration,
		deliveryFence: nextFence,
		executionDeliveryFence: currentExecutionFence,
		authorizationRevision: execution.authorization_revision,
		modelConfigurationRevision:
			execution.model_configuration_revision === null
				? null
				: Number(execution.model_configuration_revision),
		modelOptionId: execution.model_option_id,
		reasoningLevel: execution.reasoning_level,
		hostSessionRef: conversation.host_session_ref,
		...(selectedOperation === "conversation.turn.stop.v1" &&
		stop?.status === "submitted" &&
		execution.runtime_submit_protocol === "v4" &&
		execution.accepted_original_host_session_ref !== null
			? {
					acceptedOriginalHostSessionRef:
						execution.accepted_original_host_session_ref,
				}
			: {}),
		runtimeCursor: execution.last_runtime_cursor,
		...(recovery?.elapsed_ms != null
			? { recoveryElapsedMs: requireSafeCounter(recovery.elapsed_ms) }
			: {}),
		...(notSubmitted &&
		notSubmitted.count > 0 &&
		notSubmitted.elapsed_ms != null
			? {
					notSubmittedResubmissions: {
						count: notSubmitted.count,
						elapsedMs: requireSafeCounter(notSubmitted.elapsed_ms),
					},
				}
			: {}),
		...(terminalEvent?.seen ? { runtimeTerminalEventSeen: true as const } : {}),
		...(payload.metadataRecovery
			? { metadataRecovery: payload.metadataRecovery }
			: {}),
		input: turnInput
			? { text: turnInput.text, attachments: turnInput.attachments }
			: message
				? {
						text: message.text,
						attachments: inputFiles.map((file) => file.file_id),
					}
				: null,
		...(payload.nativeCapability
			? { nativeCapability: payload.nativeCapability }
			: {}),
		...(payload.nativeCapabilityV6
			? { nativeCapabilityV6: payload.nativeCapabilityV6 }
			: {}),
		...(payload.browserHandoff
			? { browserHandoff: payload.browserHandoff }
			: {}),
		executionStatus: currentExecutionStatus,
		stopPending: stop?.status === "submitted",
		...(stopConfirmationTimedOut ||
		(stop !== undefined && stop.confirmation_timed_out_at !== null)
			? { stopConfirmationTimedOut: true as const }
			: {}),
		...(isolationWork && isolation
			? { generationIsolation: isolationProjection(isolation) }
			: {}),
	};
	return { outcome: "claimed", claim };
}
