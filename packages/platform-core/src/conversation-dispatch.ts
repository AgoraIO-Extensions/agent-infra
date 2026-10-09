import {
	parseAuthority,
	parseClaim,
	parseCommand,
} from "./conversation-dispatch-input.js";
import {
	isTurnOperation,
	operationId,
	parseRuntimeEvent,
	parseRuntimeResponse,
	parseRuntimeStatusResponse,
	runtimeRequest,
} from "./conversation-dispatch-runtime.js";
import {
	acceptedTransition,
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
} from "./conversation-dispatch-types.js";
import { exactObject, unavailable } from "./conversation-dispatch-values.js";
import type {
	ConversationEventCommandV1,
	ConversationEventDecisionV1,
	ConversationEventUseCaseV1,
} from "./conversation-events.js";
import { isConversationGenerationBarrierConfirmedV1 } from "./conversation-generation-isolation.js";

export { parseConversationMetadataRecoveryV1 } from "./conversation-dispatch-input.js";
export {
	decideConversationDispatchRetryTransitionV1,
	decideConversationStopConfirmationStatusV1,
	decideConversationStopConfirmationTimeoutV1,
} from "./conversation-dispatch-transition.js";
export {
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
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEvent,
	type ConversationRuntimeEventRequestV1,
	type ConversationRuntimeEventV1,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationEventV2,
	type ConversationRuntimeOperationResponseV1,
	type ConversationRuntimeOperationResultV1,
	type ConversationRuntimeStatusRequestV2,
	type ConversationRuntimeStatusResponseV2,
	type ConversationRuntimeStatusV1,
	type DispatchConversationCommandV1,
} from "./conversation-dispatch-types.js";

/** Far below the Host bound of 256 delivered but unacknowledged cursors. */
const acknowledgementBatchSize = 32;

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
		readonly events: {
			persist(
				command: ConversationEventCommandV1 & {
					readonly dispatchLease: NonNullable<
						ConversationEventCommandV1["dispatchLease"]
					>;
				},
			): ReturnType<ConversationEventUseCaseV1["persist"]>;
		};
	},
	options: {
		readonly leaseDurationMs?: number;
		readonly retryDelayMs?: number;
	} = {},
): ConversationDispatchUseCaseV1 {
	const leaseDurationMs = options.leaseDurationMs ?? 30_000;
	const retryDelayMs = options.retryDelayMs ?? 1_000;
	if (
		!Number.isSafeInteger(leaseDurationMs) ||
		leaseDurationMs < 3 ||
		leaseDurationMs > 300_000 ||
		!Number.isSafeInteger(retryDelayMs) ||
		retryDelayMs < 0 ||
		retryDelayMs > 86_400_000
	) {
		throw new ConversationDispatchError("invalid_input");
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
		const eventHeartbeat = heartbeat(
			dependencies.store,
			claim,
			leaseDurationMs,
			!claim.metadataRecovery &&
				!authority.controlOnly &&
				dependencies.runtimeHost.renewAuthorization
				? async (signal) => {
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
								!isTurnOperation(claim.operation) ||
								!dependencies.runtimeHost.recoverOriginalStatus ||
								!(error instanceof ConversationRuntimeHostError) ||
								error.code !== "RUNTIME_GRANT_INVALID"
							)
								throw error;
							renewalRefused = true;
						}
					}
				: undefined,
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
			// Recover a committed event whose acknowledgement was lost, including
			// the last metadata event when the remaining stream is empty.
			if (claim.runtimeCursor)
				await dependencies.runtimeHost.acknowledge?.(
					{ ...eventRequest, confirmedCursor: claim.runtimeCursor },
					eventHeartbeat.signal,
				);
			for await (const eventInput of dependencies.runtimeHost.events(
				eventRequest,
				eventHeartbeat.signal,
			)) {
				const runtimeEvent = parseRuntimeEvent(eventInput, claim);
				const event = normalizedEvent(runtimeEvent);
				const transition = transitionFromEvent(event);
				const eventFinalStatus = terminalStatus(event);
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
					(finalStatus && eventFinalStatus && eventFinalStatus !== finalStatus)
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
					persisted = await dependencies.events.persist({
						schemaVersion: 1,
						conversationId: claim.conversationId,
						executionId: claim.executionId,
						sessionGeneration: claim.sessionGeneration,
						deliveryFence: claim.executionDeliveryFence,
						adapterEventKey: runtimeEvent.adapterEventKey,
						runtimeCursor: runtimeEvent.cursor,
						occurredAt: runtimeEvent.occurredAt,
						event,
						// The transaction checks the original persisted attempt and outcome.
						...(terminalEventSeen ? { operationMetadataOnly: true } : {}),
						...(transition &&
						(!(responseFinalStatus ?? confirmedFinalStatus) ||
							terminalEventSeen ||
							eventFinalStatus)
							? { transition }
							: {}),
						dispatchLease: {
							schemaVersion: 1,
							itemId: claim.itemId,
							leaseOwner: claim.leaseOwner,
							deliveryFence: claim.deliveryFence,
						},
					});
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
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"AUTHORIZATION_UNAVAILABLE",
					"retry",
					{},
				);
			}
			if (authorization.outcome === "denied") {
				if (authorization.authority !== undefined) return unavailable();
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
				return reject(
					dependencies.store,
					claim,
					"ORIGINAL_RESPONSE_ALREADY_FINISHED",
				);
			}
			const recoveringOriginalTurn =
				(claim.stopPending ||
					authority.controlOnly ||
					((claim.executionStatus === "unknown" ||
						claim.executionStatus === "processing") &&
						dependencies.runtimeHost.recoverOriginalStatus !== undefined)) &&
				(claim.operation === "conversation.turn.submit.v1" ||
					claim.operation === "conversation.turn.regenerate.v1");
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
					return reject(
						dependencies.store,
						claim,
						"ORIGINAL_RESPONSE_ALREADY_FINISHED",
					);
				}
				if (isTurnOperation(claim.operation) && claim.hostSessionRef) {
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
			const recoveringTimedOutStop =
				claim.operation === "conversation.turn.stop.v1" &&
				claim.stopConfirmationTimedOut === true;
			if (
				(claim.operation === "conversation.turn.supplement.v1" ||
					claim.operation === "conversation.turn.stop.v1") &&
				claim.executionStatus !== "processing" &&
				!recoveringMissingStop &&
				!recoveringTimedOutStop
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
				if (recoveringOriginalTurn || recoveringMissingStop) {
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
					if (status.status === "unavailable") {
						throw new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
					}
					response = {
						schemaVersion:
							isTurnOperation(claim.operation) && claim.modelOptionId !== null
								? 2
								: 1,
						hostSessionRef: status.hostSessionRef ?? unavailable(),
						operationId: operationId(claim),
						result: { outcome: "accepted", status: status.status },
					};
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
				// The Store wrote unknown before the request as a write-ahead of
				// possible delivery. When the Worker proves nothing was sent, return
				// the Turn to its original waiting position instead (HLD §8.4).
				if (
					failure.retryable &&
					failure.notSent &&
					!recoveringOriginalTurn &&
					(claim.operation === "conversation.turn.submit.v1" ||
						claim.operation === "conversation.turn.regenerate.v1") &&
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
					transition: responseTransition ?? {},
				}))
			) {
				return { schemaVersion: 1, outcome: "stale" };
			}

			if (response.result.outcome === "busy") {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"RUNTIME_BUSY",
					"busy",
				);
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
				return reject(
					dependencies.store,
					claim,
					claim.operation === "conversation.turn.supplement.v1" &&
						response.result.code === "RUNTIME_TURN_NOT_ACTIVE"
						? "ORIGINAL_RESPONSE_ALREADY_FINISHED"
						: response.result.code,
				);
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
