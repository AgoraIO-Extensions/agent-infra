import { randomUUID } from "node:crypto";
import type {
	ObservabilitySpan,
	startObservability,
} from "@agent-infra/observability";
import { createObservedConversationEvents } from "@agent-infra/observability/worker";
import {
	type ConversationBrowserHandoffExecutorV1,
	createConversationDispatchUseCaseV1,
	createConversationEventUseCaseV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxObservationV1,
	type SessionSandboxPolicyV1,
	type SessionSandboxReconciliationClaimV1,
} from "@agent-infra/platform-core";
import {
	openPostgresConversationDispatchStoreV1,
	outboxWakeChannelV1,
	PostgresCommitWakeupListenerV1,
	PostgresConversationEventTransactionV1,
	PostgresLegacyTaskRecoveryReaderV1,
	PostgresTaskAuthorizationStoreV1,
	platformQueueResourceSnapshotTimeoutMs,
} from "@agent-infra/platform-store";
import {
	type BrowserHandoffCommandInvocationV1,
	type BrowserHandoffOperationCommandV1,
	browserHandoffFromRuntimeSnapshotV1,
	createBrowserHandoffCommandExecutorV1,
} from "./browser-handoff-command.js";
import { createBrowserHandoffEventAdapterV1 } from "./browser-handoff-events.js";
import {
	type BrowserSideEffectCommandInvocationV1,
	createBrowserSideEffectCommandExecutorV1,
	createBrowserSideEffectOperationAdapterV1,
} from "./browser-side-effect-operation.js";
import type { ConversationRuntimeBrowserSideEffectRequestV1 } from "./conversation-runtime.js";
import {
	type ConversationRuntimeBrowserHandoffRequestV1,
	type ConversationRuntimeOptionsV2,
	createConversationRuntimeV2,
} from "./conversation-runtime.js";

export interface PlatformConversationWorkerOptionsV2
	extends Omit<
		ConversationRuntimeOptionsV2,
		| "dispatchStore"
		| "taskAuthorizationStore"
		| "legacyControlStore"
		| "resolveCurrentApplication"
		| "resolveCurrentApiUseGrant"
	> {
	readonly databaseUrl: string;
	/** Closes deployment-owned stores assembled outside the Worker process. */
	readonly closeDeployment?: () => Promise<void>;
	readonly sandboxPolicy: SessionSandboxPolicyV1;
	readonly receiveSandbox: (
		claim: SessionSandboxReconciliationClaimV1,
		signal: AbortSignal,
		recordDeletionProgress?: (
			progress: SessionSandboxDeletionProgressV1,
		) => Promise<"committed" | "stale" | "unknown">,
	) => Promise<SessionSandboxObservationV1>;
	readonly pollIntervalMs?: number;
	/** Discover work as soon as an outbox commit wakes the Worker (#1561);
	 * polling stays the delivery guarantee. Defaults to enabled. */
	readonly commitWakeups?: boolean;
	readonly maximumConcurrentDispatches?: number;
	readonly leaseDurationMs?: number;
	readonly retryDelayMs?: number;
	/** Deployment supplies only the current Browser binding snapshot; Runtime
	 * grants and lease ownership remain Worker authorities. */
	readonly resolveBrowserHandoff?: (
		input: BrowserHandoffCommandInvocationV1,
	) => Promise<ConversationRuntimeBrowserHandoffRequestV1["handoff"] | null>;
	/** Deployment supplies the current Browser side-effect binding. */
	readonly resolveBrowserSideEffect?: (
		input: BrowserSideEffectCommandInvocationV1,
	) => Promise<ConversationRuntimeBrowserSideEffectRequestV1 | null>;
	readonly log?: (message: string) => void;
	readonly observability?: Pick<
		ReturnType<typeof startObservability>,
		"record"
	> &
		Partial<
			Pick<
				ReturnType<typeof startObservability>,
				"observeResource" | "status" | "startSpan"
			>
		>;
}

type Telemetry = Pick<ReturnType<typeof startObservability>, "record">;
type ConversationRuntime = ReturnType<typeof createConversationRuntimeV2>;

export type PlatformConversationBrowserHandoffInputV1 = Readonly<{
	readonly request: ConversationRuntimeBrowserHandoffRequestV1;
	readonly occurredAt: string;
	readonly adapterEventKeyPrefix: string;
	readonly runtimeCursorPrefix: string;
	readonly signal?: AbortSignal;
}>;
const resourceSnapshotOperation = "platform.resource_snapshot";
const slowQueueQueryOperation = "conversation.queue.find.slow";
const defaultSlowQueryThresholdMs = 250;

function slowQueryThresholdMs() {
	const configured = Number(process.env.AGENT_INFRA_SLOW_QUERY_THRESHOLD_MS);
	return Number.isInteger(configured) && configured >= 1 && configured <= 2_000
		? configured
		: defaultSlowQueryThresholdMs;
}

function boundedResourceSnapshotDuration(
	value: unknown,
	startedAt: number,
): number {
	const measured =
		typeof value === "number" && Number.isFinite(value)
			? value
			: performance.now() - startedAt;
	return Math.min(
		platformQueueResourceSnapshotTimeoutMs,
		Math.max(0, measured),
	);
}

/** Bounded stage timings between a claim and the Runtime submit (#1561);
 * only identifiers and durations are recorded. */
function timedAuthorization(
	authorization: ConversationRuntime["authorization"],
	telemetry: Telemetry,
): ConversationRuntime["authorization"] {
	return {
		...authorization,
		async authorize(input) {
			const began = performance.now();
			const decision = await authorization.authorize(input);
			record(telemetry, {
				stage: "authorization",
				outcome: decision.outcome === "allowed" ? "completed" : "rejected",
				durationMs: performance.now() - began,
				operationRef: "drain.authorization",
				conversationId: input.conversationId,
				executionId: input.executionId,
			});
			return decision;
		},
	};
}

function timedRuntimeSubmit(
	runtimeHost: ConversationRuntime["runtimeHost"],
	telemetry: Telemetry,
): ConversationRuntime["runtimeHost"] {
	return {
		...runtimeHost,
		async dispatch(request, signal) {
			const began = performance.now();
			let outcome: "completed" | "failed" = "failed";
			try {
				const response = await runtimeHost.dispatch(request, signal);
				outcome = "completed";
				return response;
			} finally {
				record(telemetry, {
					stage: "runtime",
					outcome,
					durationMs: performance.now() - began,
					conversationId: request.conversationId,
					executionId: request.executionId,
				});
			}
		},
	};
}

function record(
	telemetry: Telemetry,
	event: Parameters<Telemetry["record"]>[0],
) {
	try {
		telemetry.record(event);
	} catch {
		// Timing is observational; it never changes dispatch.
	}
}

export type PlatformConversationWorkerLifecycleStatusV1 =
	| "not_started"
	| "running"
	| "stopping"
	| "stopped";

export function createPlatformConversationWorkerV2(
	options: PlatformConversationWorkerOptionsV2,
) {
	const interval = options.pollIntervalMs ?? 1000;
	const maximum = options.maximumConcurrentDispatches ?? 8;
	if (
		!Number.isSafeInteger(interval) ||
		interval < 1 ||
		interval > 30_000 ||
		!Number.isSafeInteger(maximum) ||
		maximum < 1 ||
		maximum > 128
	)
		throw new TypeError("Conversation Worker polling options are invalid");
	const controller = new AbortController();
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	const store = openPostgresConversationDispatchStoreV1({
		databaseUrl: options.databaseUrl,
		userDirectory: options.directory,
		sandboxPolicy: options.sandboxPolicy,
	});
	const taskAuthorizationStore = new PostgresTaskAuthorizationStoreV1({
		databaseUrl: options.databaseUrl,
	});
	const legacyControlStore = new PostgresLegacyTaskRecoveryReaderV1({
		databaseUrl: options.databaseUrl,
	});
	const transaction = new PostgresConversationEventTransactionV1({
		databaseUrl: options.databaseUrl,
	});
	const conversationEvents = options.observability
		? createObservedConversationEvents({
				transaction,
				telemetry: options.observability,
			})
		: createConversationEventUseCaseV1({ transaction });
	const browserHandoffEvents = createBrowserHandoffEventAdapterV1({
		events: conversationEvents,
	});
	let runtime: ReturnType<typeof createConversationRuntimeV2> | undefined;
	let dispatch: ReturnType<typeof createConversationDispatchUseCaseV1>;
	try {
		const telemetry = options.observability;
		runtime = createConversationRuntimeV2({
			...options,
			signal,
			recordDrainStage: telemetry
				? (observation) =>
						record(telemetry, {
							stage: "worker",
							outcome: observation.outcome,
							durationMs: observation.durationMs,
							operationRef: observation.operationRef,
							conversationId: observation.conversationId,
							executionId: observation.executionId,
						})
				: undefined,
			dispatchStore: store,
			taskAuthorizationStore,
			legacyControlStore,
			resolveCurrentApplication: async (applicationId, agentId, signal) => {
				signal.throwIfAborted();
				const current = await taskAuthorizationStore.readCurrentApplication({
					applicationId,
					agentId,
				});
				signal.throwIfAborted();
				return current;
			},
			resolveCurrentApiUseGrant: async (principal, agentId, signal) => {
				signal.throwIfAborted();
				const current = await taskAuthorizationStore.readCurrentApiUseGrant({
					principal,
					agentId,
				});
				signal.throwIfAborted();
				return current;
			},
		});
		const browserCommandExecutor = createBrowserHandoffCommandExecutorV1({
			resolver: {
				resolve: async (invocation) => {
					if (
						!invocation.agentId ||
						!invocation.channelId ||
						!invocation.executionId ||
						!invocation.turnId ||
						invocation.sessionGeneration === undefined ||
						invocation.deliveryFence === undefined ||
						// Runtime V3 Event requests require a live Host session. The
						// Core claim parser rejects Browser claims without this binding.
						!invocation.hostSessionRef ||
						invocation.runtimeGrant === undefined
					)
						return null;
					let handoff:
						| ConversationRuntimeBrowserHandoffRequestV1["handoff"]
						| null;
					if (options.resolveBrowserHandoff) {
						handoff = await options.resolveBrowserHandoff(invocation);
					} else if (invocation.claim && store.readBrowserHandoffBinding) {
						const snapshot = await store.readBrowserHandoffBinding({
							claim: invocation.claim,
						});
						handoff = browserHandoffFromRuntimeSnapshotV1({
							command: invocation.command as BrowserHandoffOperationCommandV1,
							operatorId: invocation.identity.userId,
							snapshot,
						});
					} else {
						return null;
					}
					if (!handoff) return null;
					return {
						schemaVersion: 1,
						requestId: invocation.requestId,
						traceId: invocation.traceId,
						agentId: invocation.agentId,
						actorId: invocation.identity.userId,
						channelId: invocation.channelId,
						conversationId: invocation.conversationId,
						executionId: invocation.executionId,
						turnId: invocation.turnId,
						sessionGeneration: invocation.sessionGeneration,
						deliveryFence: invocation.deliveryFence,
						hostSessionRef: invocation.hostSessionRef,
						runtimeGrant: invocation.runtimeGrant,
						handoff,
					};
				},
			},
			worker: {
				browserHandoff: async (input) => {
					const dispatched = await runtime?.browserHandoff(
						input.request,
						input.signal,
					);
					if (!dispatched)
						throw new Error("BROWSER_HANDOFF_RUNTIME_UNAVAILABLE");
					return browserHandoffEvents.persist({
						request: dispatched.request,
						response: dispatched.response,
						occurredAt: input.occurredAt,
						adapterEventKeyPrefix: input.adapterEventKeyPrefix,
						runtimeCursorPrefix: input.runtimeCursorPrefix,
					});
				},
			},
		});
		const browserSideEffectOperation =
			createBrowserSideEffectOperationAdapterV1({
				events: conversationEvents,
				runtime: {
					browserSideEffect: async (request, commandSignal) => {
						const runtimeRequest: ConversationRuntimeBrowserSideEffectRequestV1 =
							{
								schemaVersion: 1,
								requestId: request.requestId,
								traceId: request.traceId,
								agentId: request.agentId,
								actorId: request.principal.id,
								channelId: request.channelId,
								conversationId: request.conversationId,
								executionId: request.executionId,
								turnId: request.turnId,
								sessionGeneration: request.sessionGeneration,
								deliveryFence: request.operation.deliveryFence,
								hostSessionRef: request.hostSessionRef,
								runtimeGrant: request.grant,
								command: request.command,
								binding: request.binding,
							};
						const dispatched = await runtime?.browserSideEffect(
							runtimeRequest,
							commandSignal,
						);
						if (!dispatched)
							throw new Error("BROWSER_SIDE_EFFECT_RUNTIME_UNAVAILABLE");
						return dispatched.response;
					},
				},
			});
		const browserSideEffectExecutor = createBrowserSideEffectCommandExecutorV1({
			resolver: {
				resolve: async (invocation) => {
					if (
						!options.resolveBrowserSideEffect ||
						!invocation.agentId ||
						!invocation.channelId ||
						!invocation.executionId ||
						!invocation.turnId ||
						invocation.sessionGeneration === undefined ||
						invocation.deliveryFence === undefined ||
						!invocation.hostSessionRef ||
						invocation.runtimeGrant === undefined
					)
						return null;
					return options.resolveBrowserSideEffect(invocation);
				},
			},
			operation: browserSideEffectOperation,
		});
		const browserHandoffExecutor: ConversationBrowserHandoffExecutorV1 = {
			invoke: async ({ claim, authority, signal }) => {
				if (!claim.browserHandoff) return { outcome: "unavailable" };
				if (
					claim.browserHandoff.command === "confirm_side_effect" ||
					claim.browserHandoff.command === "reject_side_effect" ||
					claim.browserHandoff.command === "cancel_side_effect"
				) {
					const result = await browserSideEffectExecutor.invoke({
						identity: { userId: claim.actorId },
						conversationId: claim.conversationId,
						command: claim.browserHandoff,
						idempotencyKey: claim.itemId,
						requestId: claim.requestId,
						traceId: claim.traceId,
						signal: signal ?? AbortSignal.timeout(30_000),
						agentId: claim.agentId,
						channelId: claim.channelId,
						executionId: claim.executionId,
						turnId: claim.turnId,
						sessionGeneration: claim.sessionGeneration,
						deliveryFence: claim.executionDeliveryFence,
						hostSessionRef: claim.hostSessionRef,
						runtimeGrant: authority.runtimeGrant,
					});
					return result.outcome === "accepted" || result.outcome === "replayed"
						? { outcome: result.outcome }
						: result.outcome === "unknown"
							? { outcome: "unknown" as const }
							: { outcome: "unavailable" as const };
				}
				const result = await browserCommandExecutor.invoke({
					identity: { userId: claim.actorId },
					conversationId: claim.conversationId,
					command: claim.browserHandoff,
					idempotencyKey: claim.itemId,
					requestId: claim.requestId,
					traceId: claim.traceId,
					...(claim.traceParent ? { traceParent: claim.traceParent } : {}),
					signal: signal ?? AbortSignal.timeout(30_000),
					agentId: claim.agentId,
					channelId: claim.channelId,
					executionId: claim.executionId,
					turnId: claim.turnId,
					sessionGeneration: claim.sessionGeneration,
					deliveryFence: claim.executionDeliveryFence,
					hostSessionRef: claim.hostSessionRef,
					runtimeGrant: authority.runtimeGrant,
					claim,
				});
				return result.outcome === "accepted" || result.outcome === "replayed"
					? { outcome: result.outcome }
					: result.outcome === "unknown"
						? { outcome: "unknown" as const }
						: { outcome: "unavailable" as const };
			},
		};
		dispatch = createConversationDispatchUseCaseV1(
			{
				store,
				authorization: telemetry
					? timedAuthorization(runtime.authorization, telemetry)
					: runtime.authorization,
				runtimeHost: telemetry
					? timedRuntimeSubmit(runtime.runtimeHost, telemetry)
					: runtime.runtimeHost,
				browserHandoff: browserHandoffExecutor,
				events: conversationEvents,
			},
			{
				leaseDurationMs: options.leaseDurationMs,
				retryDelayMs: options.retryDelayMs,
			},
		);
	} catch (error) {
		controller.abort();
		const runtimeForCleanup = runtime;
		void Promise.allSettled([
			...(runtimeForCleanup
				? [Promise.resolve().then(() => runtimeForCleanup.close())]
				: []),
			Promise.resolve().then(() => transaction.close()),
			Promise.resolve().then(() => store.close()),
			Promise.resolve().then(() => taskAuthorizationStore.close()),
			Promise.resolve().then(() => legacyControlStore.close()),
			Promise.resolve().then(() => options.closeDeployment?.()),
		]);
		throw error;
	}
	const running = new Map<
		string,
		{ control: boolean; promise: Promise<void> }
	>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let polling: Promise<number> | undefined;
	let resourceTimer: ReturnType<typeof setTimeout> | undefined;
	let sampling: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let started = false;
	let stopped = false;
	let lifecycleStatus: PlatformConversationWorkerLifecycleStatusV1 =
		"not_started";
	let afterItemId: string | undefined;
	let rescan = false;
	const wakeups =
		options.commitWakeups === false
			? undefined
			: new PostgresCommitWakeupListenerV1({
					databaseUrl: options.databaseUrl,
					channel: outboxWakeChannelV1,
					onWake: () => wake(),
				});
	function log(code: string) {
		try {
			(options.log ?? console.info)(
				JSON.stringify({
					service: "platform-worker",
					component: "conversation",
					code,
				}),
			);
		} catch {
			/* observational only */
		}
	}
	function canSampleResources() {
		if (stopped || !started || signal.aborted) return false;
		const telemetry = options.observability;
		if (!telemetry?.observeResource || !telemetry.status) return false;
		try {
			const status = telemetry.status();
			return status.enabled && status.state === "active";
		} catch {
			return false;
		}
	}
	function sampleResources() {
		if (sampling || !canSampleResources()) return;
		const telemetry = options.observability;
		if (!telemetry) return;
		const startedAt = performance.now();
		let snapshotRead = false;
		sampling = Promise.resolve()
			.then(async () => {
				if (!canSampleResources()) return;
				const snapshot = await store.readResourceSnapshot(signal);
				if (!canSampleResources()) return;
				snapshotRead = true;
				record(telemetry, {
					stage: "dependency",
					outcome: "completed",
					durationMs: boundedResourceSnapshotDuration(
						snapshot.queryDurationMs,
						startedAt,
					),
					operationRef: resourceSnapshotOperation,
				});
				telemetry.observeResource?.({
					kind: "task_waiting",
					value: snapshot.taskWaiting,
				});
				telemetry.observeResource?.({
					kind: "outbox_pending",
					value: snapshot.outboxPending,
				});
			})
			.catch(() => {
				if (!stopped && !signal.aborted) {
					if (!snapshotRead)
						record(telemetry, {
							stage: "dependency",
							outcome: "failed",
							code: "DEPENDENCY_UNAVAILABLE",
							durationMs: boundedResourceSnapshotDuration(undefined, startedAt),
							operationRef: resourceSnapshotOperation,
						});
					log("CONVERSATION_RESOURCE_SNAPSHOT_UNAVAILABLE");
				}
			})
			.finally(() => {
				sampling = undefined;
				if (canSampleResources())
					resourceTimer = setTimeout(sampleResources, 1000);
			});
	}
	async function dispatchItemCore(item: {
		readonly itemId: string;
		readonly operation: string;
		readonly traceParent?: string;
	}) {
		if (item.operation !== "conversation.sandbox.reconcile.v1") {
			const began = performance.now();
			try {
				const decision = await dispatch.dispatch({
					schemaVersion: 1,
					itemId: item.itemId,
					workerId: options.workerId,
				});
				if (options.observability) {
					const outcome =
						decision.outcome === "accepted"
							? "completed"
							: decision.outcome === "unknown"
								? "unknown"
								: decision.outcome === "busy" || decision.outcome === "retry"
									? "failed"
									: "rejected";
					record(options.observability, {
						stage: "task_dispatch",
						outcome,
						durationMs: performance.now() - began,
						...(decision.outcome === "busy" || decision.outcome === "retry"
							? { code: "TASK_UNAVAILABLE" as const }
							: {}),
						// The operation is a bounded Store value. Item IDs stay out of
						// telemetry to avoid high-cardinality labels and logs.
						operationRef: item.operation,
					});
				}
				return decision;
			} catch (error) {
				if (options.observability)
					record(options.observability, {
						stage: "task_dispatch",
						outcome: "failed",
						durationMs: performance.now() - began,
						code: "TASK_UNAVAILABLE",
						operationRef: item.operation,
					});
				throw error;
			}
		}
		signal.throwIfAborted();
		const leaseDurationMs = options.leaseDurationMs ?? 30_000;
		const initialClaim = await store.claimSandboxReconciliation({
			schemaVersion: 1,
			itemId: item.itemId,
			workerId: options.workerId,
			leaseDurationMs,
		});
		if (!initialClaim) return;
		let claim: NonNullable<typeof initialClaim> = initialClaim;
		signal.throwIfAborted();
		if (
			!(await store.prepareSandboxReconciliation({
				claim,
				leaseDurationMs,
			}))
		)
			return;
		let observation: SessionSandboxObservationV1;
		let renewal: ReturnType<typeof setInterval> | undefined;
		try {
			// Renew the original Store lease immediately before and after the Kubernetes
			// mutation and periodically while it runs; a lost lease never gets to
			// submit a committed observation. Kubernetes mutations are not cancellable
			// by the client, so the receiver is allowed to finish its receipt.
			if (
				!(await store.prepareSandboxReconciliation({
					claim,
					leaseDurationMs,
				}))
			)
				return;
			let leaseLost = false;
			renewal = setInterval(
				() => {
					void store
						.prepareSandboxReconciliation({
							claim,
							leaseDurationMs,
						})
						.then((held) => {
							if (!held) leaseLost = true;
						})
						.catch(() => {
							leaseLost = true;
						});
				},
				Math.max(100, Math.floor(leaseDurationMs / 3)),
			);
			observation = await options.receiveSandbox(
				claim,
				// Kubernetes mutations are not cancellable by the client. Keep the
				// logical operation alive until the receiver returns a complete receipt;
				// lease renewal and the subsequent CAS decide whether it may commit.
				signal,
				async (progress) => {
					const result = await store.recordSandboxDeletionProgress({
						claim,
						progress,
						leaseDurationMs,
					});
					if (result.status === "committed")
						claim = result.claim as typeof claim;
					return result.status;
				},
			);
			clearInterval(renewal);
			renewal = undefined;
			if (leaseLost) {
				observation = {
					status: "unknown",
					resources: claim.previousObservation?.resources ?? [],
				};
			}
			if (
				!(await store.prepareSandboxReconciliation({
					claim,
					leaseDurationMs,
				}))
			)
				return;
		} catch {
			if (renewal) clearInterval(renewal);
			// Keep the original binding and occupancy; the same outbox owns recovery.
			observation = {
				status: "unknown",
				resources: claim.previousObservation?.resources ?? [],
			};
		}
		signal.throwIfAborted();
		if (
			!(await store.prepareSandboxReconciliation({
				claim,
				leaseDurationMs,
			}))
		)
			return;
		await store.recordSandboxObservation({ claim, observation });
	}
	async function dispatchItem(item: {
		readonly itemId: string;
		readonly operation: string;
		readonly traceParent?: string;
	}) {
		let span: ObservabilitySpan | undefined;
		try {
			span = options.observability?.startSpan?.("platform.worker.dispatch", {
				...(item.traceParent === undefined ? {} : { link: item.traceParent }),
				attributes: { operation: item.operation },
			});
		} catch {
			span = undefined;
		}
		try {
			return span
				? await span.run(() => dispatchItemCore(item))
				: await dispatchItemCore(item);
		} finally {
			span?.end();
		}
	}
	async function drainInstallationCommands() {
		const commandStore = options.connectionInstallation?.commandStore;
		if (!commandStore || !runtime) return 0;
		const pending = await commandStore.listPending(
			32,
			runtime.connectionInstallation.activeExecutionIds(),
		);
		let drained = 0;
		for (const item of pending) {
			if (
				!runtime.connectionInstallation.canDrain(
					item.authorization.reference.executionId,
				)
			)
				continue;
			const attemptId = randomUUID();
			const claimed = await commandStore.claimPending({
				commandId: item.command.commandId,
				attemptId,
				attemptOwner: options.workerId,
			});
			if (!claimed) continue;
			try {
				const result = await runtime.connectionInstallation.drain(
					{
						authorization: {
							authorizationId: claimed.authorization.authorizationId,
							reference: claimed.authorization.reference,
						},
						command: {
							commandId: claimed.command.commandId,
							command: claimed.command.command as
								| "begin"
								| "confirm"
								| "status",
						},
						attemptId,
						attemptOwner: options.workerId,
					},
					signal,
				);
				await commandStore.settle({
					commandId: claimed.command.commandId,
					attemptId,
					attemptOwner: options.workerId,
					status: result ? "completed" : "unknown",
					...(result?.authorizationUrl
						? { authorizationUrl: result.authorizationUrl }
						: {}),
					...(result?.expiresAt
						? { authorizationExpiresAt: result.expiresAt }
						: {}),
					...(result?.callbackStateHash
						? { callbackStateHash: result.callbackStateHash }
						: {}),
				});
				drained++;
			} catch {
				await commandStore.settle({
					commandId: claimed.command.commandId,
					attemptId,
					attemptOwner: options.workerId,
					status: "unknown",
				});
			}
		}
		return drained;
	}
	async function discover() {
		if (stopped || signal.aborted) return 0;
		if (options.connectionInstallation?.commandStore) {
			try {
				await drainInstallationCommands();
			} catch {
				// Installation storage failures never block ordinary conversation dispatch.
			}
		}
		const limit = 256;
		const began = performance.now();
		let items: Awaited<ReturnType<typeof store.findDispatchable>>;
		try {
			items = await store.findDispatchable({
				limit,
				...(afterItemId ? { afterItemId } : {}),
				signal,
			});
		} catch (error) {
			if (options.observability)
				record(options.observability, {
					stage: "task_wait",
					outcome: "failed",
					durationMs: performance.now() - began,
					code: "TASK_UNAVAILABLE",
					operationRef: "conversation.queue.find",
				});
			throw error;
		}
		// An empty discovery (or a page containing only maintenance work) is an
		// idle poll, not a task wait. Emit one bounded observation for a returned
		// task page so timer sleeps do not create events.
		if (
			items.some(
				(item) => item.operation !== "conversation.sandbox.reconcile.v1",
			) &&
			options.observability
		)
			record(options.observability, {
				stage: "task_wait",
				outcome: "completed",
				durationMs: performance.now() - began,
				operationRef: "conversation.queue.find",
			});
		const discoveryDurationMs = performance.now() - began;
		if (options.observability && discoveryDurationMs >= slowQueryThresholdMs())
			record(options.observability, {
				stage: "dependency",
				outcome: "completed",
				durationMs: Math.min(2_000, discoveryDurationMs),
				operationRef: slowQueueQueryOperation,
			});
		let launched = 0;
		let lastBusinessItemId: string | undefined;
		for (const item of items) {
			if (stopped || signal.aborted) break;
			// Advance after every scanned item; the Store wraps deferred work on the next lap.
			afterItemId = item.itemId;
			if (running.has(item.itemId)) continue;
			const control =
				item.operation === "conversation.turn.stop.v1" ||
				item.operation === "conversation.browser.handoff.v1";
			const count = [...running.values()].filter(
				(entry) => entry.control === control,
			).length;
			// A busy streaming Turn cannot consume the capacity needed to stop it.
			if (count >= (control ? 2 : maximum)) {
				continue;
			}
			const promise = dispatchItem(item)
				.then(
					() => undefined,
					() => {
						log("CONVERSATION_DISPATCH_UNAVAILABLE");
					},
				)
				.finally(() => running.delete(item.itemId));
			running.set(item.itemId, { control, promise });
			if (!control) lastBusinessItemId = item.itemId;
			launched += 1;
		}
		// Resume after the last business attempt, including a busy claim.
		// When saturated, keep scanning pages so stop work remains reachable.
		if (lastBusinessItemId) afterItemId = lastBusinessItemId;
		return launched;
	}
	function tick() {
		if (stopped || signal.aborted) return Promise.resolve(0);
		if (polling) return polling;
		polling = discover().finally(() => {
			polling = undefined;
			// Work committed during a scan may sort before the scan cursor.
			if (rescan) {
				rescan = false;
				wake();
			}
		});
		return polling;
	}
	function wake() {
		if (stopped || signal.aborted || !started) return;
		if (polling) {
			rescan = true;
			return;
		}
		void tick().catch(() => log("CONVERSATION_DISCOVERY_UNAVAILABLE"));
	}
	function poll() {
		if (stopped || signal.aborted) return;
		if (!polling)
			void tick().catch(() => log("CONVERSATION_DISCOVERY_UNAVAILABLE"));
		if (!stopped && !signal.aborted)
			timer = setTimeout(() => {
				void poll();
			}, interval);
	}
	return {
		tick,
		async browserHandoff(input: PlatformConversationBrowserHandoffInputV1) {
			if (!runtime) throw new Error("BROWSER_HANDOFF_RUNTIME_UNAVAILABLE");
			const dispatched = await runtime.browserHandoff(
				input.request,
				input.signal ?? signal,
			);
			return browserHandoffEvents.persist({
				request: dispatched.request,
				response: dispatched.response,
				occurredAt: input.occurredAt,
				adapterEventKeyPrefix: input.adapterEventKeyPrefix,
				runtimeCursorPrefix: input.runtimeCursorPrefix,
			});
		},
		start() {
			if (started || stopped) return;
			started = true;
			lifecycleStatus = "running";
			log("CONVERSATION_DISPATCH_STARTED");
			void poll();
			sampleResources();
			void wakeups?.start().catch(() => {
				if (!stopped && !signal.aborted)
					log("CONVERSATION_COMMIT_WAKEUP_UNAVAILABLE");
			});
		},
		status() {
			return lifecycleStatus;
		},
		stop() {
			if (closing) return closing;
			stopped = true;
			lifecycleStatus = "stopping";
			log("CONVERSATION_DISPATCH_STOPPING");
			clearTimeout(timer);
			clearTimeout(resourceTimer);
			controller.abort();
			const runtimeClose = Promise.resolve().then(() => runtime.close());
			closing = (async () => {
				const runningResults = await Promise.allSettled([
					runtimeClose,
					polling,
					sampling,
					...[...running.values()].map((entry) => entry.promise),
				]);
				const closeResults = await Promise.allSettled([
					Promise.resolve().then(() => wakeups?.close()),
					Promise.resolve().then(() => transaction.close()),
					Promise.resolve().then(() => store.close()),
					Promise.resolve().then(() => taskAuthorizationStore.close()),
					Promise.resolve().then(() => legacyControlStore.close()),
					Promise.resolve().then(() => options.closeDeployment?.()),
				]);
				const failure = [...runningResults, ...closeResults].find(
					(result): result is PromiseRejectedResult =>
						result.status === "rejected",
				);
				if (failure) {
					log("CONVERSATION_DISPATCH_STOP_FAILED");
					throw failure.reason;
				}
				lifecycleStatus = "stopped";
				log("CONVERSATION_DISPATCH_STOPPED");
			})();
			return closing;
		},
	};
}

export async function startPlatformConversationWorkerFromDeploymentV2(
	moduleSpecifier = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE,
	signal?: AbortSignal,
	observability?: PlatformConversationWorkerOptionsV2["observability"],
) {
	if (!moduleSpecifier)
		throw new Error("PLATFORM_WORKER_DEPLOYMENT_MODULE is required");
	const assemblySignal = signal ?? new AbortController().signal;
	let options: PlatformConversationWorkerOptionsV2;
	try {
		assemblySignal.throwIfAborted();
		const deployment = (await import(moduleSpecifier)) as {
			createPlatformConversationWorkerOptionsV2(
				signal: AbortSignal,
			):
				| PlatformConversationWorkerOptionsV2
				| Promise<PlatformConversationWorkerOptionsV2>;
		};
		assemblySignal.throwIfAborted();
		options =
			await deployment.createPlatformConversationWorkerOptionsV2(
				assemblySignal,
			);
	} catch {
		throw new Error(
			"Conversation Worker deployment dependencies are unavailable",
		);
	}
	const worker = createPlatformConversationWorkerV2({
		...options,
		signal: assemblySignal,
		observability,
	});
	if (assemblySignal.aborted) await worker.stop();
	else worker.start();
	return worker;
}
