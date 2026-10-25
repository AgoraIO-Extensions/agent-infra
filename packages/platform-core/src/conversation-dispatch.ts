import {
	parseAuthority,
	parseClaim,
	parseCommand,
} from "./conversation-dispatch-input.js";
import {
	isNativeCapabilityOperation,
	isRuntimeEventOperation,
	isTurnOperation,
	operationId,
	parseRuntimeEvent,
	parseRuntimeResponse,
	parseRuntimeStatusResponse,
	runtimeRequest,
} from "./conversation-dispatch-runtime.js";
import {
	acceptedTransition,
	decideConversationDispatchRejectedTransitionV1,
	executionTerminal,
	heartbeat,
	normalizedEvent,
	reject,
	rejectedTransition,
	retry,
	retryTransition,
	runtimeFailure,
	terminalStatus,
	transitionFromEvent,
} from "./conversation-dispatch-transition.js";
import {
	type ConversationBrowserHandoffExecutorV1,
	type ConversationDispatchAuthorityV1,
	type ConversationDispatchAuthorizationPortV1,
	type ConversationDispatchClaimDecisionV1,
	type ConversationDispatchClaimV1,
	type ConversationDispatchDecisionV1,
	ConversationDispatchError,
	type ConversationDispatchStorePortV1,
	type ConversationDispatchUseCaseV1,
	type ConversationRuntimeEventRequestV1,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationResponseV1,
	type ConversationRuntimeStatusResponseV2,
	type ConversationRuntimeStatusV1,
	type ConversationRuntimeTurnNotSubmittedReasonV1,
} from "./conversation-dispatch-types.js";
import { exactObject, unavailable } from "./conversation-dispatch-values.js";
import {
	type ConversationEventCommandV1,
	type ConversationEventDecisionV1,
	type ConversationEventUseCaseV1,
	conversationEventBatchLimitV1,
	isBatchableConversationEventV1,
} from "./conversation-events.js";
import { isConversationGenerationBarrierConfirmedV1 } from "./conversation-generation-isolation.js";

export { parseConversationMetadataRecoveryV1 } from "./conversation-dispatch-input.js";
export {
	decideConversationDispatchRetryTransitionV1,
	decideConversationStopConfirmationStatusV1,
	decideConversationStopConfirmationTimeoutV1,
} from "./conversation-dispatch-transition.js";
export {
	type ConversationBrowserHandoffExecutorV1,
	type ConversationDispatchAuthorityV1,
	type ConversationDispatchAuthorizationPortV1,
	type ConversationDispatchClaimDecisionV1,
	type ConversationDispatchClaimV1,
	type ConversationDispatchDecisionV1,
	ConversationDispatchError,
	type ConversationDispatchExecutionStatusV1,
	type ConversationDispatchOperationV1,
	type ConversationDispatchStateTransitionV1,
	type ConversationDispatchStorePortV1,
	type ConversationDispatchUseCaseV1,
	type ConversationMetadataRecoveryV1,
	type ConversationNativeCapabilityBindingV1,
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEvent,
	type ConversationRuntimeEventRequestV1,
	type ConversationRuntimeEventV1,
	type ConversationRuntimeFileEventV2,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationEventV2,
	type ConversationRuntimeOperationResponseV1,
	type ConversationRuntimeOperationResultV1,
	type ConversationRuntimeReasoningEventV2,
	type ConversationRuntimeStatusRequestV2,
	type ConversationRuntimeStatusResponseV2,
	type ConversationRuntimeStatusV1,
	type DispatchConversationCommandV1,
} from "./conversation-dispatch-types.js";

/** Far below the Host bound of 256 delivered but unacknowledged cursors. */
const acknowledgementBatchSize = 32;

/** #3378：缓冲的增量在没有新事件时最多等待 50 ms 再提交。 */
const bufferedEventIdleMs = 50;

/**
 * #3373：Runtime 报告未提交后最多重提 3 次，且只在首次重提起 2 分钟内重提（Runtime HLD §7.3）。
 */
const notSubmittedResubmitLimit = 3;
const notSubmittedResubmitWindowMs = 120_000;

/** A standard tool call waits for its persisted fact to be acknowledged before
 * the Runtime calls the tool or reports its result. The terminal event closes
 * the batch, so acknowledging it costs no extra round trip. */
function acknowledgeNow(event: ReturnType<typeof normalizedEvent>) {
	return (
		(event.type === "execution.operation" && event.fact.kind === "tool") ||
		terminalStatus(event) !== undefined
	);
}

export function createConversationDispatchUseCaseV1(
	dependencies: {
		readonly store: ConversationDispatchStorePortV1;
		readonly authorization: ConversationDispatchAuthorizationPortV1;
		readonly runtimeHost: ConversationRuntimeHostPortV1;
		readonly browserHandoff?: ConversationBrowserHandoffExecutorV1;
		readonly events: {
			persist(
				command: ConversationEventCommandV1 & {
					readonly dispatchLease: NonNullable<
						ConversationEventCommandV1["dispatchLease"]
					>;
				},
			): ReturnType<ConversationEventUseCaseV1["persist"]>;
			/** #3378：未提供时逐个持久化。 */
			persistBatch?(
				commands: readonly (ConversationEventCommandV1 & {
					readonly dispatchLease: NonNullable<
						ConversationEventCommandV1["dispatchLease"]
					>;
				})[],
			): Promise<readonly ConversationEventDecisionV1[]>;
		};
	},
	options: {
		readonly leaseDurationMs?: number;
		readonly retryDelayMs?: number;
		/** Maximum durable claims spent recovering terminal Execution metadata. */
		readonly maxRecoveryAttempts?: number;
		/**
		 * #3373：Execution 处于 `unknown` 后恢复的墙钟预算（毫秒），用尽时以
		 * `RUNTIME_RECOVERY_TIMEOUT` 收敛为失败。默认 5 分钟，由部署配置。
		 */
		readonly recoveryBudgetMs?: number;
	} = {},
): ConversationDispatchUseCaseV1 {
	const leaseDurationMs = options.leaseDurationMs ?? 30_000;
	const retryDelayMs = options.retryDelayMs ?? 1_000;
	const maxRecoveryAttempts = options.maxRecoveryAttempts ?? 120;
	const recoveryBudgetMs = options.recoveryBudgetMs ?? 300_000;
	if (
		!Number.isSafeInteger(leaseDurationMs) ||
		leaseDurationMs < 3 ||
		leaseDurationMs > 300_000 ||
		!Number.isSafeInteger(retryDelayMs) ||
		retryDelayMs < 0 ||
		retryDelayMs > 86_400_000 ||
		!Number.isSafeInteger(maxRecoveryAttempts) ||
		maxRecoveryAttempts < 1 ||
		maxRecoveryAttempts > 1_000_000 ||
		!Number.isSafeInteger(recoveryBudgetMs) ||
		recoveryBudgetMs < 1 ||
		recoveryBudgetMs > 86_400_000
	) {
		throw new ConversationDispatchError("invalid_input");
	}
	// 元数据恢复仍按认领次数；接受结果不确定的恢复按 Execution 进入 unknown 以来的墙钟时间
	// （#3373，Runtime HLD §7.3）。
	const recoveryExhausted = (claim: ConversationDispatchClaimV1) =>
		claim.metadataRecovery !== undefined
			? claim.attemptCount !== undefined &&
				claim.attemptCount >= maxRecoveryAttempts
			: claim.executionStatus === "unknown" &&
				claim.recoveryElapsedMs !== undefined &&
				claim.recoveryElapsedMs >= recoveryBudgetMs &&
				(isRuntimeEventOperation(claim.operation) ||
					claim.operation === "conversation.turn.stop.v1");
	/**
	 * #3375：补充指令无法进入原回复时转入排队（工程 Spec §12.5）。Store 在同一 Conversation 锁事务
	 * 内完成转换并终结本次补充指令；未装配转换时沿用原规则标记“原回复已结束”。
	 */
	async function queueSupplement(
		claim: ConversationDispatchClaimV1,
	): Promise<ConversationDispatchDecisionV1> {
		if (!dependencies.store.queueSupplement)
			return reject(
				dependencies.store,
				claim,
				"ORIGINAL_RESPONSE_ALREADY_FINISHED",
			);
		return (await dependencies.store.queueSupplement({ claim }))
			? { schemaVersion: 1, outcome: "rejected" }
			: { schemaVersion: 1, outcome: "stale" };
	}
	/**
	 * #3373：Runtime 已核实本次 Turn 在原生提交点之前未提交。2 分钟内最多重提 3 次：
	 * Execution 退回投递前状态，下一次认领重新授权、提升 fence 并签发新的 Grant；
	 * 次数或窗口用尽后按阶段明确失败（Runtime HLD §7.3）。
	 */
	async function settleUnsubmittedTurn(
		claim: ConversationDispatchClaimV1,
		hostSessionRef: string,
		reason: ConversationRuntimeTurnNotSubmittedReasonV1,
	): Promise<ConversationDispatchDecisionV1> {
		const previous = claim.notSubmittedResubmissions;
		const resubmissions = previous?.count ?? 0;
		if (
			resubmissions < notSubmittedResubmitLimit &&
			(previous === undefined ||
				previous.elapsedMs < notSubmittedResubmitWindowMs) &&
			dependencies.store.releaseUnsentDispatch
		) {
			try {
				return (await dependencies.store.releaseUnsentDispatch({
					claim,
					// 退避给暂时不可达的依赖留出恢复时间，总时长仍在窗口之内；不超过 Store 接受的
					// 最大延迟（部署配置的重试间隔可达 24 小时）。
					retryDelayMs: Math.min(retryDelayMs * 3 ** resubmissions, 86_400_000),
					errorCode: "RUNTIME_TURN_NOT_SUBMITTED",
					hostSessionRef,
				}))
					? { schemaVersion: 1, outcome: "retry", retryScheduled: true }
					: { schemaVersion: 1, outcome: "stale" };
			} catch {
				return { schemaVersion: 1, outcome: "retry", retryScheduled: false };
			}
		}
		return reject(
			dependencies.store,
			claim,
			reason === "file_input_unavailable"
				? "RUNTIME_FILE_INPUT_UNAVAILABLE"
				: "RUNTIME_SESSION_PREPARATION_FAILED",
		);
	}
	async function persistRuntimeEvents(
		claim: ConversationDispatchClaimV1,
		authority: ConversationDispatchAuthorityV1,
		hostSessionRef: string,
		responseStatus: ConversationRuntimeStatusV1,
	): Promise<ConversationDispatchDecisionV1> {
		const responseFinalStatus =
			responseStatus === "completed" ||
			responseStatus === "failed" ||
			responseStatus === "cancelled"
				? responseStatus
				: undefined;
		let finalStatus = responseFinalStatus;
		// Host-confirmed terminal status for a Turn that finished while its
		// events were still being drained (#1554); it guards later transitions
		// exactly like a terminal status response does.
		let confirmedFinalStatus: typeof responseFinalStatus;
		// The Host refused renewing the business authority. That alone is
		// ambiguous (finished, stopped, revoked or fenced); the drain loop
		// resolves it before persisting the next event.
		let renewalRefused = false;
		let terminalEventSeen =
			claim.runtimeTerminalEventSeen === true ||
			claim.metadataRecovery !== undefined;
		// A terminal event may have committed even if persistence lost its response.
		let terminalCommitPossible =
			executionTerminal(claim.executionStatus) ||
			responseFinalStatus !== undefined;
		const eventRequest: ConversationRuntimeEventRequestV1 = {
			schemaVersion: 1,
			requestId: claim.metadataRecovery?.id ?? claim.requestId,
			traceId: claim.traceId,
			agentId: claim.agentId,
			actorId: claim.actorId,
			channelId: claim.channelId,
			conversationId: claim.conversationId,
			executionId: claim.executionId,
			turnId: claim.turnId,
			sessionGeneration: claim.sessionGeneration,
			deliveryFence: claim.executionDeliveryFence,
			hostSessionRef: hostSessionRef,
			...(claim.runtimeCursor ? { afterCursor: claim.runtimeCursor } : {}),
			runtimeGrant: authority.runtimeGrant,
		};
		// Renews the business authority while the original Turn runs. A refusal
		// is resolved by the drain below rather than failing the Turn.
		const renewBusinessAuthority =
			!claim.metadataRecovery &&
			!authority.controlOnly &&
			dependencies.runtimeHost.renewAuthorization
				? async (signal: AbortSignal) => {
						if (terminalCommitPossible || renewalRefused) return;
						try {
							await dependencies.runtimeHost.renewAuthorization?.(
								eventRequest,
								signal,
							);
						} catch (error) {
							// The Host renews only a running Turn. A Turn that finished
							// before its events were read is drained in this same claim
							// once the Host confirms the finish (Spec §9.3).
							if (
								!isRuntimeEventOperation(claim.operation) ||
								!dependencies.runtimeHost.recoverOriginalStatus ||
								!(error instanceof ConversationRuntimeHostError) ||
								error.code !== "RUNTIME_GRANT_INVALID"
							)
								throw error;
							renewalRefused = true;
						}
					}
				: undefined;
		const eventHeartbeat = heartbeat(
			dependencies.store,
			claim,
			leaseDurationMs,
			renewBusinessAuthority,
		);
		// Positive Host proof that the original Turn finished. It is persisted
		// under the live lease like a terminal status response, so the Worker
		// continues the drain with the control-purpose recovery Grant.
		const confirmFinished = async (): Promise<"drain" | "interrupted"> => {
			const recover = dependencies.runtimeHost.recoverOriginalStatus;
			if (!recover) return "interrupted";
			let status: ConversationRuntimeStatusResponseV2;
			try {
				status = parseRuntimeStatusResponse(
					await recover(
						{
							schemaVersion: 2,
							requestId: claim.requestId,
							traceId: claim.traceId,
							agentId: claim.agentId,
							actorId: claim.actorId,
							channelId: claim.channelId,
							conversationId: claim.conversationId,
							executionId: claim.executionId,
							turnId: claim.turnId,
							sessionGeneration: claim.sessionGeneration,
							deliveryFence: claim.executionDeliveryFence,
							hostSessionRef,
							runtimeGrant: authority.runtimeGrant,
						},
						eventHeartbeat.signal,
					),
					{ ...claim, hostSessionRef },
				);
			} catch {
				return "interrupted";
			}
			if (
				status.outcome !== "found" ||
				(status.status !== "completed" &&
					status.status !== "failed" &&
					status.status !== "cancelled")
			)
				return "interrupted";
			const transition = acceptedTransition(status.status);
			try {
				if (
					!transition ||
					!(await dependencies.store.recordRuntimeResponse({
						claim,
						hostSessionRef,
						...(isRuntimeEventOperation(claim.operation)
							? { originalOperationAccepted: true as const }
							: {}),
						transition,
					}))
				)
					return "interrupted";
			} catch {
				return "interrupted";
			}
			confirmedFinalStatus = status.status;
			finalStatus = status.status;
			terminalCommitPossible = true;
			return "drain";
		};
		// An authorization renewal can fail after the lease was renewed, notably
		// when stop changes the stream to control-only recovery. The Store must
		// recheck ownership before releasing it; heartbeat failure alone is not
		// evidence that another Worker owns the lease.
		const retryInterruptedDrain = () =>
			retry(
				dependencies.store,
				claim,
				retryDelayMs,
				"RUNTIME_HEARTBEAT_INTERRUPTED",
				"retry",
				{},
			);
		// Host acknowledgement is cumulative, so one ACK of the last committed
		// cursor confirms every earlier event (#1525). Batch it, except for facts
		// the Runtime waits on before continuing, and stay far below the Host's
		// bound on delivered but unacknowledged cursors.
		let unacknowledgedCursor: string | undefined;
		let unacknowledgedEvents = 0;
		const acknowledgeCommitted = async () => {
			if (!unacknowledgedCursor || !dependencies.runtimeHost.acknowledge)
				return;
			const confirmedCursor = unacknowledgedCursor;
			unacknowledgedCursor = undefined;
			unacknowledgedEvents = 0;
			await dependencies.runtimeHost.acknowledge(
				{ ...eventRequest, confirmedCursor },
				eventHeartbeat.signal,
			);
		};
		try {
			// A drain resumed for an accepted Turn follows a gap, such as an
			// interrupted heartbeat, that may have outlived the Host's 30 s business
			// authority. Renew it before the first event request, so an expired
			// lease is not reported as a refusal that fails the Turn (#1888). A
			// refusal here is resolved like one seen while draining: drain under
			// the control Grant once the finish is proven, otherwise re-claim
			// (HLD §8.2). A fresh submit has just established its authority.
			try {
				if (
					claim.executionStatus === "processing" ||
					claim.executionStatus === "unknown"
				)
					await renewBusinessAuthority?.(eventHeartbeat.signal);
			} catch (error) {
				// Business authority is no longer current, for example after a
				// stop or revocation: the drain continues under its control Grant.
				// Any other failure is like a failed heartbeat renewal; it never
				// fails the Turn, and the same outbox item re-claims the drain.
				if (
					!(error instanceof ConversationRuntimeHostError) ||
					error.code !== "AUTHORIZATION_REVOKED"
				)
					return retryInterruptedDrain();
			}
			if (
				renewalRefused &&
				!terminalCommitPossible &&
				(await confirmFinished()) === "interrupted"
			)
				return retryInterruptedDrain();
			// Recover a committed event whose acknowledgement was lost, including
			// the last metadata event when the remaining stream is empty.
			if (claim.runtimeCursor)
				await dependencies.runtimeHost.acknowledge?.(
					{ ...eventRequest, confirmedCursor: claim.runtimeCursor },
					eventHeartbeat.signal,
				);
			const dispatchLease = {
				schemaVersion: 1 as const,
				itemId: claim.itemId,
				leaseOwner: claim.leaseOwner,
				deliveryFence: claim.deliveryFence,
			};
			const eventCommand = (
				runtimeEvent: ReturnType<typeof parseRuntimeEvent>,
				event: ReturnType<typeof normalizedEvent>,
				transition: ReturnType<typeof transitionFromEvent>,
				eventFinalStatus: ReturnType<typeof terminalStatus>,
			) => ({
				schemaVersion: 1 as const,
				conversationId: claim.conversationId,
				executionId: claim.executionId,
				sessionGeneration: claim.sessionGeneration,
				deliveryFence: claim.executionDeliveryFence,
				adapterEventKey: runtimeEvent.adapterEventKey,
				runtimeCursor: runtimeEvent.cursor,
				occurredAt: runtimeEvent.occurredAt,
				event,
				// The transaction checks the original persisted attempt and outcome.
				...(terminalEventSeen ? { operationMetadataOnly: true as const } : {}),
				...(transition &&
				(!(responseFinalStatus ?? confirmedFinalStatus) ||
					terminalEventSeen ||
					eventFinalStatus)
					? { transition }
					: {}),
				dispatchLease,
			});
			// #3378：连续的正文与思考增量在一个事务内持久化，避免每个事件一次往返。批次在
			// 遇到其他事件、达到上限、空闲 50 ms 或流结束时提交；提交后才确认游标。
			const batching = dependencies.events.persistBatch !== undefined;
			const buffered: ReturnType<typeof eventCommand>[] = [];
			const flushBuffered = async (): Promise<"stale" | undefined> => {
				if (buffered.length === 0) return undefined;
				const commands = buffered.splice(0);
				let decisions: readonly ConversationEventDecisionV1[];
				try {
					const result = await dependencies.events.persistBatch?.(commands);
					if (!result) throw new Error("unavailable");
					decisions = result;
				} catch {
					throw new ConversationRuntimeHostError(
						"EVENT_PERSISTENCE_UNAVAILABLE",
						true,
					);
				}
				if (
					decisions.length !== commands.length ||
					decisions.some((decision) => decision.outcome === "stale")
				)
					return "stale";
				unacknowledgedCursor = commands.at(-1)?.runtimeCursor;
				unacknowledgedEvents += commands.length;
				if (unacknowledgedEvents >= acknowledgementBatchSize)
					await acknowledgeCommitted();
				return undefined;
			};
			const iterator = dependencies.runtimeHost
				.events(eventRequest, eventHeartbeat.signal)
				[Symbol.asyncIterator]();
			let pending: Promise<IteratorResult<unknown>> | undefined;
			try {
				while (true) {
					pending ??= iterator.next();
					let step: IteratorResult<unknown> | "idle";
					try {
						step =
							buffered.length === 0
								? await pending
								: await new Promise<IteratorResult<unknown> | "idle">(
										(resolve, reject) => {
											const timer = setTimeout(
												() => resolve("idle"),
												bufferedEventIdleMs,
											);
											pending?.then(
												(value) => {
													clearTimeout(timer);
													resolve(value);
												},
												(error: unknown) => {
													clearTimeout(timer);
													reject(error);
												},
											);
										},
									);
					} catch (error) {
						// 流中断前已读到的增量照常提交，恢复时从已提交游标继续。提交失败或已失去
						// 租约时以提交结果为准，不用流错误掩盖。
						pending = undefined;
						if ((await flushBuffered()) === "stale")
							return { schemaVersion: 1, outcome: "stale" };
						throw error;
					}
					if (step === "idle") {
						if ((await flushBuffered()) === "stale")
							return { schemaVersion: 1, outcome: "stale" };
						continue;
					}
					pending = undefined;
					if (step.done) break;
					const runtimeEvent = parseRuntimeEvent(step.value, claim);
					const event = normalizedEvent(runtimeEvent);
					const transition = transitionFromEvent(event);
					const eventFinalStatus = terminalStatus(event);
					if (batching && !(renewalRefused && !terminalCommitPossible)) {
						const command = eventCommand(
							runtimeEvent,
							event,
							transition,
							eventFinalStatus,
						);
						if (isBatchableConversationEventV1(command)) {
							buffered.push(command);
							if (
								buffered.length >= conversationEventBatchLimitV1 &&
								(await flushBuffered()) === "stale"
							)
								return { schemaVersion: 1, outcome: "stale" };
							continue;
						}
					}
					// 其他事件改变执行状态或操作历史，先提交此前的增量以保持顺序。
					if ((await flushBuffered()) === "stale")
						return { schemaVersion: 1, outcome: "stale" };
					if (
						renewalRefused &&
						!terminalCommitPossible &&
						!eventFinalStatus &&
						(await confirmFinished()) === "interrupted"
					)
						return retryInterruptedDrain();
					const connectionMetadata =
						event.type === "execution.operation" &&
						event.fact.kind === "tool" &&
						event.fact.connection !== undefined &&
						["completed", "failed", "unknown"].includes(event.fact.phase);
					if (
						(terminalEventSeen && !connectionMetadata) ||
						(finalStatus &&
							eventFinalStatus &&
							eventFinalStatus !== finalStatus)
					) {
						const finished = await dependencies.store.finish({
							claim,
							status: "failed",
							transition: {},
							errorCode: "RUNTIME_EVENT_CONFLICT",
						});
						return finished
							? { schemaVersion: 1, outcome: "rejected" }
							: { schemaVersion: 1, outcome: "stale" };
					}
					if (eventFinalStatus) terminalCommitPossible = true;
					let persisted: ConversationEventDecisionV1;
					try {
						persisted = await dependencies.events.persist(
							eventCommand(runtimeEvent, event, transition, eventFinalStatus),
						);
					} catch {
						throw new ConversationRuntimeHostError(
							"EVENT_PERSISTENCE_UNAVAILABLE",
							true,
						);
					}
					if (persisted.outcome === "stale") {
						return { schemaVersion: 1, outcome: "stale" };
					}
					if (eventFinalStatus) {
						terminalEventSeen = true;
						finalStatus = eventFinalStatus;
					}
					unacknowledgedCursor = runtimeEvent.cursor;
					unacknowledgedEvents++;
					if (
						acknowledgeNow(event) ||
						unacknowledgedEvents >= acknowledgementBatchSize
					)
						await acknowledgeCommitted();
				}
				if ((await flushBuffered()) === "stale")
					return { schemaVersion: 1, outcome: "stale" };
			} finally {
				// 提前结束时关闭 Host 事件流。仍有未完成的读取时，生成器的 return 会排在它之后，
				// 不等待它；随后停止心跳会中止该读取。
				if (pending) {
					pending.catch(() => undefined);
					void Promise.resolve(iterator.return?.()).catch(() => undefined);
				} else await iterator.return?.()?.catch?.(() => undefined);
			}
			await acknowledgeCommitted();
		} catch (error) {
			const current = await eventHeartbeat.stop();
			// An unresolved refusal keeps today's recovery path; it never turns
			// an expired business read into a failed Turn.
			if (!current || (renewalRefused && !terminalCommitPossible))
				return retryInterruptedDrain();
			const failure = runtimeFailure(error);
			return failure.retryable
				? retry(
						dependencies.store,
						claim,
						retryDelayMs,
						failure.code,
						"retry",
						terminalCommitPossible ? {} : retryTransition(claim),
					)
				: reject(
						dependencies.store,
						claim,
						failure.code,
						terminalCommitPossible ? {} : rejectedTransition(claim),
					);
		} finally {
			await eventHeartbeat.stop();
		}
		if (
			eventHeartbeat.signal.aborted ||
			(renewalRefused && !terminalCommitPossible)
		) {
			return retryInterruptedDrain();
		}
		if (!finalStatus) {
			return retry(
				dependencies.store,
				claim,
				retryDelayMs,
				"RUNTIME_STREAM_INCOMPLETE",
				"retry",
			);
		}
		// A status response proves the Runtime finished, not that its journal was
		// drained. Close the item only after the terminal event itself persisted;
		// otherwise resume from the committed cursor (#1524).
		if (!terminalEventSeen) {
			return retry(
				dependencies.store,
				claim,
				retryDelayMs,
				"RUNTIME_STREAM_INCOMPLETE",
				"retry",
				{},
			);
		}
		const finished = await dependencies.store.finish({
			claim,
			status: "succeeded",
			// The terminal response or event already committed the business state.
			// A later Execution may now own the Conversation's active status.
			transition: {},
		});
		return finished
			? { schemaVersion: 1, outcome: "accepted" }
			: { schemaVersion: 1, outcome: "stale" };
	}
	return {
		async dispatch(commandInput) {
			const command = parseCommand(commandInput);
			let claimDecision: ConversationDispatchClaimDecisionV1;
			try {
				claimDecision = await dependencies.store.claim({
					...command,
					leaseDurationMs,
				});
			} catch {
				return { schemaVersion: 1, outcome: "retry", retryScheduled: false };
			}
			const claimResult = exactObject(claimDecision, ["outcome"], ["claim"]);
			if (claimResult.outcome !== "claimed") {
				if (claimResult.claim !== undefined) return unavailable();
				if (claimResult.outcome === "busy") {
					return { schemaVersion: 1, outcome: "busy", retryScheduled: false };
				}
				if (claimResult.outcome === "succeeded") {
					return { schemaVersion: 1, outcome: "already_completed" };
				}
				if (claimResult.outcome === "stale") {
					return { schemaVersion: 1, outcome: "stale" };
				}
				if (claimResult.outcome === "failed") {
					return { schemaVersion: 1, outcome: "rejected" };
				}
				return unavailable();
			}
			if (claimResult.claim === undefined) return unavailable();
			const claim = parseClaim(claimResult.claim);
			if (
				claim.itemId !== command.itemId ||
				claim.leaseOwner !== command.workerId
			) {
				return unavailable();
			}

			let authorityDecision: Awaited<
				ReturnType<ConversationDispatchAuthorizationPortV1["authorize"]>
			>;
			try {
				authorityDecision = await dependencies.authorization.authorize({
					claim,
					schemaVersion: 1,
					operation: claim.operation,
					agentId: claim.agentId,
					actorId: claim.actorId,
					channelId: claim.channelId,
					conversationId: claim.conversationId,
					executionId: claim.executionId,
					turnId: claim.turnId,
					sessionGeneration: claim.sessionGeneration,
					authorizationRevision: claim.authorizationRevision,
					traceId: claim.traceId,
				});
			} catch {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"AUTHORIZATION_UNAVAILABLE",
					"retry",
					{},
				);
			}
			const authorization = exactObject(
				authorityDecision,
				["outcome"],
				["authority"],
			);
			if (authorization.outcome === "unavailable") {
				if (authorization.authority !== undefined) return unavailable();
				// 执行已终态、且从未被 Runtime 受理（没有 hostSessionRef）的 native capability
				// 没有可续读的事件，也不再需要授权：直接按已完成关闭，不再无限重试（#2919）。
				if (
					!claim.metadataRecovery &&
					claim.hostSessionRef === null &&
					executionTerminal(claim.executionStatus) &&
					isNativeCapabilityOperation(claim.operation)
				) {
					const finished = await dependencies.store.finish({
						claim,
						status: "succeeded",
						transition: {},
					});
					return finished
						? { schemaVersion: 1, outcome: "already_completed" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"AUTHORIZATION_UNAVAILABLE",
					"retry",
					{},
				);
			}
			// A stop on a submitted/waiting Turn may be authorized as a durable
			// control record (for example after Agent lifecycle stop/revocation),
			// rather than as an outright denied decision. The Runtime has never
			// accepted this Turn, so settle it locally before the generic
			// control-only recovery barrier turns it into an endless retry.
			if (
				authorization.outcome === "allowed" &&
				authorization.authority !== undefined &&
				typeof authorization.authority === "object" &&
				authorization.authority !== null &&
				"controlOnly" in authorization.authority &&
				authorization.authority.controlOnly === true &&
				claim.operation === "conversation.turn.stop.v1" &&
				claim.stopPending &&
				(claim.executionStatus === "submitted" ||
					claim.executionStatus === "waiting")
			) {
				const cancelled = await dependencies.store.cancelUnaccepted({
					claim,
				});
				return cancelled
					? { schemaVersion: 1, outcome: "already_completed" }
					: { schemaVersion: 1, outcome: "stale" };
			}
			if (authorization.outcome === "denied") {
				if (authorization.authority !== undefined) return unavailable();
				if (
					claim.operation === "conversation.turn.stop.v1" &&
					claim.stopPending &&
					(claim.executionStatus === "submitted" ||
						claim.executionStatus === "waiting")
				) {
					const cancelled = await dependencies.store.cancelUnaccepted({
						claim,
					});
					return cancelled
						? { schemaVersion: 1, outcome: "already_completed" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				if (
					!claim.metadataRecovery &&
					recoveryExhausted(claim) &&
					(claim.operation === "conversation.turn.submit.v1" ||
						claim.operation === "conversation.turn.regenerate.v1" ||
						claim.operation === "conversation.turn.stop.v1" ||
						isNativeCapabilityOperation(claim.operation))
				) {
					const finished = await dependencies.store.finish({
						claim,
						status: "failed",
						transition: {
							executionStatus: "failed",
							conversationStatus: "ready",
						},
						errorCode: "RUNTIME_RECOVERY_TIMEOUT",
					});
					return finished
						? { schemaVersion: 1, outcome: "rejected" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				// 同上：已终态且从未被 Runtime 受理的 native capability 授权被拒时直接关闭（#2919）。
				if (
					!claim.metadataRecovery &&
					claim.hostSessionRef === null &&
					executionTerminal(claim.executionStatus) &&
					isNativeCapabilityOperation(claim.operation)
				) {
					const finished = await dependencies.store.finish({
						claim,
						status: "succeeded",
						transition: {},
					});
					return finished
						? { schemaVersion: 1, outcome: "already_completed" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				if (
					claim.executionStatus === "processing" ||
					claim.executionStatus === "unknown" ||
					executionTerminal(claim.executionStatus)
				)
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"AUTHORIZATION_REVOKED",
						"retry",
						{},
					);
				return reject(dependencies.store, claim, "AUTHORIZATION_REVOKED");
			}
			if (
				authorization.outcome !== "allowed" ||
				authorization.authority === undefined
			) {
				return unavailable();
			}
			const authority = parseAuthority(authorization.authority, claim);
			if (claim.operation === "conversation.browser.handoff.v1") {
				const executor = dependencies.browserHandoff;
				if (!executor || !claim.browserHandoff) {
					const finished = await dependencies.store.finish({
						claim,
						status: "failed",
						transition: {},
						errorCode: "BROWSER_HANDOFF_UNAVAILABLE",
					});
					return finished
						? { schemaVersion: 1, outcome: "rejected" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				const handoffHeartbeat = heartbeat(
					dependencies.store,
					claim,
					leaseDurationMs,
				);
				let outcome: Awaited<
					ReturnType<ConversationBrowserHandoffExecutorV1["invoke"]>
				>;
				try {
					outcome = await executor.invoke({
						claim,
						authority,
						signal: handoffHeartbeat.signal,
					});
				} catch {
					outcome = { outcome: "unknown" };
				} finally {
					await handoffHeartbeat.stop();
				}
				if (outcome.outcome === "accepted" || outcome.outcome === "replayed") {
					const finished = await dependencies.store.finish({
						claim,
						status: "succeeded",
						transition: {},
					});
					return finished
						? {
								schemaVersion: 1,
								outcome:
									outcome.outcome === "replayed"
										? "already_completed"
										: "accepted",
							}
						: { schemaVersion: 1, outcome: "stale" };
				}
				if (outcome.outcome === "unavailable") {
					const finished = await dependencies.store.finish({
						claim,
						status: "failed",
						transition: {},
						errorCode: "BROWSER_HANDOFF_UNAVAILABLE",
					});
					return finished
						? { schemaVersion: 1, outcome: "rejected" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"BROWSER_HANDOFF_ACCEPTANCE_UNKNOWN",
					"unknown",
					{},
				);
			}
			if (claim.generationIsolation) {
				const isolation = claim.generationIsolation;
				const hostSessionRef = claim.hostSessionRef;
				if (
					!hostSessionRef ||
					!dependencies.runtimeHost.cancelGeneration ||
					!dependencies.runtimeHost.drainGenerationEvents ||
					!dependencies.store.confirmGenerationIsolation
				)
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"GENERATION_ISOLATION_UNAVAILABLE",
						"retry",
						{},
					);
				const request: ConversationRuntimeEventRequestV1 = {
					schemaVersion: 1,
					requestId: claim.requestId,
					traceId: claim.traceId,
					agentId: claim.agentId,
					actorId: claim.actorId,
					channelId: claim.channelId,
					conversationId: claim.conversationId,
					executionId: claim.executionId,
					turnId: claim.turnId,
					sessionGeneration: claim.sessionGeneration,
					deliveryFence: claim.executionDeliveryFence,
					hostSessionRef,
					runtimeGrant: authority.runtimeGrant,
				};
				const isolationHeartbeat = heartbeat(
					dependencies.store,
					claim,
					leaseDurationMs,
				);
				try {
					const barrier = await dependencies.runtimeHost.cancelGeneration(
						request,
						isolationHeartbeat.signal,
					);
					if (
						!isConversationGenerationBarrierConfirmedV1({
							operationId: isolation.operationId,
							hostSessionRef,
							response: barrier,
						})
					)
						throw new ConversationRuntimeHostError(
							"GENERATION_BARRIER_UNCONFIRMED",
							true,
						);
					// A prior drain may have committed its last event before ACK delivery failed.
					if (claim.runtimeCursor)
						await dependencies.runtimeHost.acknowledge?.(
							{ ...request, confirmedCursor: claim.runtimeCursor },
							isolationHeartbeat.signal,
						);
					// The barrier closes all producers; archive its remaining original events before fencing the DB generation.
					let terminalEventSeen = claim.runtimeTerminalEventSeen === true;
					for await (const raw of dependencies.runtimeHost.drainGenerationEvents(
						request,
						isolationHeartbeat.signal,
					)) {
						const runtimeEvent = parseRuntimeEvent(raw, claim);
						const event = normalizedEvent(runtimeEvent);
						const transition = transitionFromEvent(event);
						const eventFinalStatus = terminalStatus(event);
						const connectionMetadata =
							event.type === "execution.operation" &&
							event.fact.kind === "tool" &&
							event.fact.connection !== undefined &&
							["completed", "failed", "unknown"].includes(event.fact.phase);
						if (terminalEventSeen && !connectionMetadata)
							throw new ConversationRuntimeHostError(
								"RUNTIME_EVENT_CONFLICT",
								true,
							);
						const persisted = await dependencies.events.persist({
							schemaVersion: 1,
							conversationId: claim.conversationId,
							executionId: claim.executionId,
							sessionGeneration: claim.sessionGeneration,
							deliveryFence: claim.executionDeliveryFence,
							adapterEventKey: runtimeEvent.adapterEventKey,
							runtimeCursor: runtimeEvent.cursor,
							occurredAt: runtimeEvent.occurredAt,
							event,
							...(terminalEventSeen ? { operationMetadataOnly: true } : {}),
							...(transition && (!terminalEventSeen || eventFinalStatus)
								? { transition }
								: {}),
							dispatchLease: {
								schemaVersion: 1,
								itemId: claim.itemId,
								leaseOwner: claim.leaseOwner,
								deliveryFence: claim.deliveryFence,
							},
						});
						if (eventFinalStatus) terminalEventSeen = true;
						if (persisted.outcome === "stale")
							return { schemaVersion: 1, outcome: "stale" };
						await dependencies.runtimeHost.acknowledge?.(
							{ ...request, confirmedCursor: runtimeEvent.cursor },
							isolationHeartbeat.signal,
						);
					}
					if (!(await isolationHeartbeat.stop()))
						return { schemaVersion: 1, outcome: "stale" };
					return (await dependencies.store.confirmGenerationIsolation({
						claim,
						operationId: isolation.operationId,
						hostSessionRef,
					}))
						? { schemaVersion: 1, outcome: "accepted" }
						: await retry(
								dependencies.store,
								claim,
								retryDelayMs,
								"GENERATION_BARRIER_UNCONFIRMED",
								"retry",
								{},
							);
				} catch {
					if (!(await isolationHeartbeat.stop()))
						return { schemaVersion: 1, outcome: "stale" };
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"GENERATION_BARRIER_UNCONFIRMED",
						"retry",
						{},
					);
				} finally {
					await isolationHeartbeat.stop();
				}
			}
			if (
				!claim.metadataRecovery &&
				recoveryExhausted(claim) &&
				(claim.operation === "conversation.turn.submit.v1" ||
					claim.operation === "conversation.turn.regenerate.v1" ||
					claim.operation === "conversation.turn.stop.v1" ||
					isNativeCapabilityOperation(claim.operation))
			) {
				const finished = await dependencies.store.finish({
					claim,
					status: "failed",
					transition: {
						executionStatus: "failed",
						conversationStatus: "ready",
					},
					errorCode: "RUNTIME_RECOVERY_TIMEOUT",
				});
				return finished
					? { schemaVersion: 1, outcome: "rejected" }
					: { schemaVersion: 1, outcome: "stale" };
			}
			if (
				authority.controlOnly &&
				(claim.operation === "conversation.turn.supplement.v1" ||
					claim.executionStatus === "waiting" ||
					claim.executionStatus === "submitted" ||
					(!executionTerminal(claim.executionStatus) &&
						!dependencies.runtimeHost.recoverOriginalStatus))
			) {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"AUTHORIZATION_UNAVAILABLE",
					"retry",
					{},
				);
			}
			if (
				claim.stopPending &&
				claim.operation === "conversation.turn.supplement.v1"
			) {
				// #3375：原回复出现待确认的 stop，补充指令转入排队（§12.5）。
				return queueSupplement(claim);
			}
			const recoveringOriginalTurn =
				(claim.stopPending ||
					authority.controlOnly ||
					((claim.executionStatus === "unknown" ||
						claim.executionStatus === "processing") &&
						dependencies.runtimeHost.recoverOriginalStatus !== undefined)) &&
				(claim.operation === "conversation.turn.submit.v1" ||
					claim.operation === "conversation.turn.regenerate.v1");
			const recoveringNativeCapability =
				isNativeCapabilityOperation(claim.operation) &&
				(claim.executionStatus === "unknown" ||
					claim.executionStatus === "processing") &&
				claim.hostSessionRef !== null;
			if (
				recoveringOriginalTurn &&
				(claim.executionStatus === "waiting" ||
					claim.executionStatus === "submitted" ||
					(claim.hostSessionRef === null &&
						!dependencies.runtimeHost.recoverOriginalStatus))
			) {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"RUNTIME_ACCEPTANCE_UNKNOWN",
					"unknown",
					claim.executionStatus === "submitted" ? {} : retryTransition(claim),
				);
			}
			if (claim.metadataRecovery) {
				if (recoveryExhausted(claim)) {
					const finished = await dependencies.store.finish({
						claim,
						status: "failed",
						transition: {},
						errorCode: "RUNTIME_METADATA_RECOVERY_TIMEOUT",
					});
					return finished
						? { schemaVersion: 1, outcome: "rejected" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				const recover = dependencies.runtimeHost.recoverOriginalStatus;
				if (!recover || !claim.hostSessionRef)
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"RUNTIME_ACCEPTANCE_UNKNOWN",
						"retry",
						{},
					);
				const recoveryHeartbeat = heartbeat(
					dependencies.store,
					claim,
					leaseDurationMs,
				);
				try {
					const result = parseRuntimeStatusResponse(
						await recover(
							{
								schemaVersion: 2,
								requestId: claim.metadataRecovery.id,
								traceId: claim.traceId,
								agentId: claim.agentId,
								actorId: claim.actorId,
								channelId: claim.channelId,
								conversationId: claim.conversationId,
								executionId: claim.executionId,
								turnId: claim.turnId,
								sessionGeneration: claim.sessionGeneration,
								deliveryFence: claim.executionDeliveryFence,
								hostSessionRef: claim.hostSessionRef,
								runtimeGrant: authority.runtimeGrant,
							},
							recoveryHeartbeat.signal,
						),
						claim,
					);
					if (result.outcome !== "found")
						throw new ConversationRuntimeHostError(
							"RUNTIME_ACCEPTANCE_UNKNOWN",
							true,
						);
					const expectedStatus = (() => {
						switch (claim.executionStatus) {
							case "completed":
							case "failed":
							case "cancelled":
								return claim.executionStatus;
							default:
								return unavailable();
						}
					})();
					if (result.status !== expectedStatus) {
						if (!(await recoveryHeartbeat.stop()))
							return { schemaVersion: 1, outcome: "stale" };
						const finished = await dependencies.store.finish({
							claim,
							status: "failed",
							transition: {},
							errorCode: "RUNTIME_STATUS_CONFLICT",
						});
						return finished
							? { schemaVersion: 1, outcome: "rejected" }
							: { schemaVersion: 1, outcome: "stale" };
					}
					if (!(await recoveryHeartbeat.stop()))
						return { schemaVersion: 1, outcome: "stale" };
				} catch {
					if (!(await recoveryHeartbeat.stop()))
						return { schemaVersion: 1, outcome: "stale" };
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"RUNTIME_STATUS_UNAVAILABLE",
						"retry",
						{},
					);
				} finally {
					await recoveryHeartbeat.stop();
				}
				return persistRuntimeEvents(
					claim,
					authority,
					claim.hostSessionRef,
					executionTerminal(claim.executionStatus)
						? claim.executionStatus
						: unavailable(),
				);
			}
			const executionFinished = executionTerminal(claim.executionStatus);
			if (executionFinished) {
				if (claim.operation === "conversation.turn.supplement.v1") {
					// #3375：原回复已在补充指令投递前结束，补充指令转入排队（§12.5）。
					return queueSupplement(claim);
				}
				if (isRuntimeEventOperation(claim.operation) && claim.hostSessionRef) {
					return persistRuntimeEvents(
						claim,
						authority,
						claim.hostSessionRef,
						claim.executionStatus,
					);
				}
				const finished = await dependencies.store.finish({
					claim,
					status: "succeeded",
					transition: {},
				});
				return finished
					? { schemaVersion: 1, outcome: "already_completed" }
					: { schemaVersion: 1, outcome: "stale" };
			}
			const recoveringMissingStop =
				claim.operation === "conversation.turn.stop.v1" &&
				claim.hostSessionRef === null &&
				(claim.executionStatus === "unknown" ||
					claim.executionStatus === "processing") &&
				dependencies.runtimeHost.recoverOriginalStatus !== undefined;
			const acceptedStop =
				claim.operation === "conversation.turn.stop.v1" &&
				claim.stopPending &&
				claim.acceptedOriginalHostSessionRef !== undefined &&
				claim.acceptedOriginalHostSessionRef === claim.hostSessionRef;
			const recoveringStop =
				claim.operation === "conversation.turn.stop.v1" &&
				(claim.stopConfirmationTimedOut === true ||
					(acceptedStop && claim.executionStatus === "unknown")) &&
				claim.hostSessionRef !== null &&
				dependencies.runtimeHost.recoverOriginalStatus !== undefined;
			// #3375：已被 Runtime 接受的原回复在补充指令投递前转为 unknown，补充指令转入排队（§12.5）。
			if (
				claim.operation === "conversation.turn.supplement.v1" &&
				claim.executionStatus === "unknown"
			)
				return queueSupplement(claim);
			if (
				(claim.operation === "conversation.turn.supplement.v1" ||
					claim.operation === "conversation.turn.stop.v1") &&
				claim.executionStatus !== "processing" &&
				!recoveringMissingStop &&
				!recoveringStop
			) {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"ORIGINAL_RESPONSE_NOT_STARTED",
					"retry",
				);
			}
			try {
				const preparation = await dependencies.store.prepareRuntimeDispatch({
					claim,
					leaseDurationMs,
				});
				if (
					preparation === "capacity_wait" ||
					preparation === "capacity_unavailable" ||
					preparation === "sandbox_wait"
				) {
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						preparation === "capacity_wait"
							? "AGENT_CAPACITY_FULL"
							: preparation === "sandbox_wait"
								? "SESSION_SANDBOX_UPDATING"
								: "AGENT_CAPACITY_UNVERIFIED",
						"retry",
						{},
					);
				}
				// false：租约已被别人拿走；"stop_changed"：认领之后 stop 才被受理，Store 已把
				// 条目释放为可立即重新认领（下一次认领会看到 stop）。两种情况这里都只是放弃本次认领。
				if (preparation !== true) {
					return { schemaVersion: 1, outcome: "stale" };
				}
			} catch {
				return { schemaVersion: 1, outcome: "retry", retryScheduled: false };
			}
			let response: ConversationRuntimeOperationResponseV1;
			const dispatchHeartbeat = heartbeat(
				dependencies.store,
				claim,
				leaseDurationMs,
			);
			try {
				if (
					recoveringOriginalTurn ||
					recoveringNativeCapability ||
					recoveringStop ||
					recoveringMissingStop
				) {
					const status = parseRuntimeStatusResponse(
						dependencies.runtimeHost.recoverOriginalStatus
							? await dependencies.runtimeHost.recoverOriginalStatus(
									{
										schemaVersion: 2,
										requestId: claim.requestId,
										traceId: claim.traceId,
										agentId: claim.agentId,
										actorId: claim.actorId,
										channelId: claim.channelId,
										conversationId: claim.conversationId,
										executionId: claim.executionId,
										turnId: claim.turnId,
										sessionGeneration: claim.sessionGeneration,
										deliveryFence: claim.executionDeliveryFence,
										hostSessionRef: claim.hostSessionRef,
										runtimeGrant: authority.runtimeGrant,
									},
									dispatchHeartbeat.signal,
								)
							: await dependencies.runtimeHost.recoverStatus(
									{
										schemaVersion: 2,
										requestId: claim.requestId,
										traceId: claim.traceId,
										agentId: claim.agentId,
										actorId: claim.actorId,
										channelId: claim.channelId,
										conversationId: claim.conversationId,
										executionId: claim.executionId,
										turnId: claim.turnId,
										sessionGeneration: claim.sessionGeneration,
										deliveryFence: claim.executionDeliveryFence,
										hostSessionRef: claim.hostSessionRef ?? unavailable(),
										recovery: {
											schemaVersion: 1,
											input: claim.input ?? unavailable(),
											...(claim.modelOptionId && claim.reasoningLevel
												? {
														selection: {
															schemaVersion: 1 as const,
															modelOptionId: claim.modelOptionId,
															reasoningLevel: claim.reasoningLevel,
														},
													}
												: {}),
										},
										runtimeGrant: authority.runtimeGrant,
									},
									dispatchHeartbeat.signal,
								),
						claim,
					);
					if (status.outcome === "binding_found") {
						if (!(await dispatchHeartbeat.stop()))
							return { schemaVersion: 1, outcome: "stale" };
						if (
							!(await dependencies.store.recordRuntimeResponse({
								claim,
								hostSessionRef: status.hostSessionRef,
								transition: {},
							}))
						)
							return { schemaVersion: 1, outcome: "stale" };
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"RUNTIME_ACCEPTANCE_UNKNOWN",
							"unknown",
							{},
						);
					}
					if (status.outcome === "recovery_failed" && recoveringStop) {
						if (!(await dispatchHeartbeat.stop()))
							return { schemaVersion: 1, outcome: "stale" };
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							status.code,
							"unknown",
							{ executionStatus: "unknown", conversationStatus: "active" },
						);
					}
					if (recoveringMissingStop) {
						if (!(await dispatchHeartbeat.stop()))
							return { schemaVersion: 1, outcome: "stale" };
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"RUNTIME_ACCEPTANCE_UNKNOWN",
							"unknown",
							{},
						);
					}
					if (status.outcome === "not_found" && recoveringStop) {
						if (!(await dispatchHeartbeat.stop()))
							return { schemaVersion: 1, outcome: "stale" };
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"RUNTIME_ACCEPTANCE_UNKNOWN",
							"unknown",
							{ executionStatus: "unknown", conversationStatus: "active" },
						);
					}
					if (status.outcome === "recovery_failed") {
						if (!(await dispatchHeartbeat.stop()))
							return { schemaVersion: 1, outcome: "stale" };
						const started = await dependencies.store.beginGenerationIsolation?.(
							{
								claim,
								hostSessionRef: status.hostSessionRef,
								failureCode: status.code,
							},
						);
						if (!started)
							return {
								schemaVersion: 1,
								outcome: "retry",
								retryScheduled: false,
							};
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"GENERATION_ISOLATION_PENDING",
							"retry",
							{},
						);
					}
					if (status.outcome === "not_found") {
						if (!(await dispatchHeartbeat.stop())) {
							return { schemaVersion: 1, outcome: "stale" };
						}
						if (
							!claim.stopPending &&
							!authority.controlOnly &&
							!claim.metadataRecovery &&
							isRuntimeEventOperation(claim.operation)
						) {
							if (!dependencies.store.releaseUnsentDispatch)
								return retry(
									dependencies.store,
									claim,
									retryDelayMs,
									"RUNTIME_ACCEPTANCE_UNKNOWN",
									"unknown",
									retryTransition(claim),
								);
							try {
								return (await dependencies.store.releaseUnsentDispatch({
									claim,
									retryDelayMs,
									errorCode: "RUNTIME_ACCEPTANCE_NOT_SENT",
								}))
									? { schemaVersion: 1, outcome: "retry", retryScheduled: true }
									: { schemaVersion: 1, outcome: "stale" };
							} catch {
								return {
									schemaVersion: 1,
									outcome: "retry",
									retryScheduled: false,
								};
							}
						}
						if (!claim.stopPending)
							return retry(
								dependencies.store,
								claim,
								retryDelayMs,
								"RUNTIME_ACCEPTANCE_UNKNOWN",
								"unknown",
								retryTransition(claim),
							);
						const cancelled = await dependencies.store.cancelUnaccepted({
							claim,
						});
						return cancelled
							? { schemaVersion: 1, outcome: "already_completed" }
							: { schemaVersion: 1, outcome: "stale" };
					}
					if (
						(recoveringOriginalTurn || recoveringNativeCapability) &&
						status.outcome === "found" &&
						status.operationOutcome === "busy"
					) {
						if (!(await dispatchHeartbeat.stop()))
							return { schemaVersion: 1, outcome: "stale" };
						const finished = await dependencies.store.finish({
							claim,
							status: "failed",
							transition: {
								executionStatus: "failed",
								conversationStatus: "ready",
							},
							errorCode: "RUNTIME_BUSY",
						});
						return finished
							? { schemaVersion: 1, outcome: "rejected" }
							: { schemaVersion: 1, outcome: "stale" };
					}
					if (status.status === "unavailable") {
						throw new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
					}
					// 接受回执允许控制原执行；unknown 和 stop ACK 均不是终态（#3315）。
					const stopAcceptedUnknown =
						acceptedStop &&
						status.status === "unknown" &&
						status.operationOutcome !== "busy";
					if (
						recoveringStop &&
						status.status === "unknown" &&
						!stopAcceptedUnknown
					) {
						if (!(await dispatchHeartbeat.stop()))
							return { schemaVersion: 1, outcome: "stale" };
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"RUNTIME_ACCEPTANCE_UNKNOWN",
							"unknown",
							{},
						);
					}
					if (
						recoveringStop &&
						(status.status === "running" || stopAcceptedUnknown)
					) {
						response = parseRuntimeResponse(
							await dependencies.runtimeHost.dispatch(
								runtimeRequest(claim, authority),
								dispatchHeartbeat.signal,
							),
							claim,
						);
					} else {
						response = {
							schemaVersion:
								isTurnOperation(claim.operation) && claim.modelOptionId !== null
									? 2
									: 1,
							hostSessionRef: status.hostSessionRef ?? unavailable(),
							operationId: operationId(claim),
							result: { outcome: "accepted", status: status.status },
						};
					}
				} else {
					response = parseRuntimeResponse(
						await dependencies.runtimeHost.dispatch(
							runtimeRequest(claim, authority),
							dispatchHeartbeat.signal,
						),
						claim,
					);
				}
			} catch (error) {
				const current = await dispatchHeartbeat.stop();
				if (!current) return { schemaVersion: 1, outcome: "stale" };
				if (
					recoveringOriginalTurn &&
					error instanceof ConversationRuntimeHostError &&
					error.code === "RUNTIME_SESSION_RECOVERY_FAILED"
				) {
					if (!claim.hostSessionRef)
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"RUNTIME_ACCEPTANCE_UNKNOWN",
							"retry",
							{},
						);
					try {
						const started = await dependencies.store.beginGenerationIsolation?.(
							{
								claim,
								hostSessionRef: claim.hostSessionRef,
								failureCode: "RUNTIME_SESSION_RECOVERY_FAILED",
							},
						);
						if (!started)
							return {
								schemaVersion: 1,
								outcome: "retry",
								retryScheduled: false,
							};
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"GENERATION_ISOLATION_PENDING",
							"retry",
							{},
						);
					} catch {
						return {
							schemaVersion: 1,
							outcome: "retry",
							retryScheduled: false,
						};
					}
				}
				const failure = runtimeFailure(error);
				if (
					failure.code === "RUNTIME_STOP_PENDING" &&
					isRuntimeEventOperation(claim.operation) &&
					claim.executionDeliveryFence > 0
				) {
					if (!dependencies.store.cancelAccepted)
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"STOP_PENDING",
							"retry",
							{},
						);
					try {
						if (
							await dependencies.store.cancelAccepted({
								claim,
							})
						)
							return { schemaVersion: 1, outcome: "already_completed" };
					} catch {
						// A concurrently claimed stop keeps ownership of the decision;
						// retry until either side can settle the pair atomically.
					}
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"STOP_PENDING",
						"retry",
						{},
					);
				}
				// The Store wrote unknown before the request as a write-ahead of
				// possible delivery. When the Worker proves nothing was sent, return
				// the Turn to its original waiting position instead (HLD §8.4).
				if (
					failure.retryable &&
					failure.notSent &&
					!recoveringOriginalTurn &&
					!recoveringNativeCapability &&
					isRuntimeEventOperation(claim.operation) &&
					(claim.executionStatus === "submitted" ||
						claim.executionStatus === "waiting") &&
					dependencies.store.releaseUnsentDispatch
				) {
					try {
						return (await dependencies.store.releaseUnsentDispatch({
							claim,
							retryDelayMs,
							errorCode: failure.code,
						}))
							? { schemaVersion: 1, outcome: "retry", retryScheduled: true }
							: { schemaVersion: 1, outcome: "stale" };
					} catch {
						return {
							schemaVersion: 1,
							outcome: "retry",
							retryScheduled: false,
						};
					}
				}
				return failure.retryable
					? retry(
							dependencies.store,
							claim,
							retryDelayMs,
							failure.code,
							"retry",
						)
					: reject(dependencies.store, claim, failure.code);
			}
			if (!(await dispatchHeartbeat.stop())) {
				return { schemaVersion: 1, outcome: "stale" };
			}

			if (
				response.result.outcome === "rejected" &&
				response.result.code === "RUNTIME_TURN_NOT_SUBMITTED"
			)
				// 解析只对普通 Turn 的 submit V2 结果接受该成员。
				return settleUnsubmittedTurn(
					claim,
					response.hostSessionRef,
					response.result.reason,
				);

			const responseTransition =
				response.result.outcome === "accepted"
					? acceptedTransition(response.result.status)
					: response.result.outcome === "unknown"
						? retryTransition(claim)
						: {};
			if (
				response.result.outcome === "accepted" &&
				responseTransition === undefined
			) {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"RUNTIME_RESPONSE_INVALID",
					"retry",
				);
			}
			if (
				!(await dependencies.store.recordRuntimeResponse({
					claim,
					hostSessionRef: response.hostSessionRef,
					...(response.result.outcome === "accepted" &&
					isRuntimeEventOperation(claim.operation)
						? { originalOperationAccepted: true as const }
						: {}),
					transition: responseTransition ?? {},
				}))
			) {
				return { schemaVersion: 1, outcome: "stale" };
			}

			if (response.result.outcome === "busy") {
				const finished = await dependencies.store.finish({
					claim,
					status: "failed",
					transition: rejectedTransition(claim),
					errorCode: "RUNTIME_BUSY",
				});
				return finished
					? { schemaVersion: 1, outcome: "rejected" }
					: { schemaVersion: 1, outcome: "stale" };
			}
			if (response.result.outcome === "unknown") {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"RUNTIME_ACCEPTANCE_UNKNOWN",
					"unknown",
				);
			}
			if (response.result.outcome === "rejected") {
				if (
					claim.operation === "conversation.turn.stop.v1" &&
					response.result.code === "RUNTIME_TURN_NOT_ACTIVE"
				) {
					const finished = await dependencies.store.finish({
						claim,
						status: "succeeded",
						transition: {},
					});
					return finished
						? { schemaVersion: 1, outcome: "already_completed" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				if (claim.operation === "conversation.turn.stop.v1") {
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"RUNTIME_STOP_REJECTED",
						"retry",
						{},
					);
				}
				// #3375：Runtime 明确拒绝补充指令（无活跃 Turn、Turn 不符或不接受 steer），转入排队。
				if (
					claim.operation === "conversation.turn.supplement.v1" &&
					response.result.code === "RUNTIME_TURN_NOT_ACTIVE"
				)
					return queueSupplement(claim);
				return reject(
					dependencies.store,
					claim,
					response.result.code,
					decideConversationDispatchRejectedTransitionV1({
						operation: claim.operation,
						code: response.result.code,
					}),
				);
			}
			if (
				claim.operation === "conversation.turn.stop.v1" &&
				!["completed", "failed", "cancelled"].includes(response.result.status)
			) {
				// Stop acceptance is an ACK; retain its work until the original Turn confirms a terminal result.
				const scheduled = await dependencies.store.retry({
					claim,
					retryDelayMs,
					errorCode: "STOP_CONFIRMATION_PENDING",
					transition: {},
				});
				return scheduled
					? { schemaVersion: 1, outcome: "accepted" }
					: { schemaVersion: 1, outcome: "stale" };
			}
			if (
				claim.operation === "conversation.turn.supplement.v1" ||
				claim.operation === "conversation.turn.stop.v1"
			) {
				const finished = await dependencies.store.finish({
					claim,
					status: "succeeded",
					transition: responseTransition ?? {},
				});
				return finished
					? { schemaVersion: 1, outcome: "accepted" }
					: { schemaVersion: 1, outcome: "stale" };
			}

			return persistRuntimeEvents(
				claim,
				authority,
				response.hostSessionRef,
				response.result.status,
			);
		},
	};
}
