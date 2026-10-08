import type { startObservability } from "@agent-infra/observability";
import { createObservedConversationEvents } from "@agent-infra/observability/worker";
import {
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
} from "@agent-infra/platform-store";
import {
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
	readonly log?: (message: string) => void;
	readonly observability?: Pick<
		ReturnType<typeof startObservability>,
		"record"
	> &
		Partial<
			Pick<ReturnType<typeof startObservability>, "observeResource" | "status">
		>;
}

type Telemetry = Pick<ReturnType<typeof startObservability>, "record">;
type ConversationRuntime = ReturnType<typeof createConversationRuntimeV2>;

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
	let runtime: ReturnType<typeof createConversationRuntimeV2> | undefined;
	let dispatch: ReturnType<typeof createConversationDispatchUseCaseV1>;
	try {
		runtime = createConversationRuntimeV2({
			...options,
			signal,
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
		const telemetry = options.observability;
		dispatch = createConversationDispatchUseCaseV1(
			{
				store,
				authorization: telemetry
					? timedAuthorization(runtime.authorization, telemetry)
					: runtime.authorization,
				runtimeHost: telemetry
					? timedRuntimeSubmit(runtime.runtimeHost, telemetry)
					: runtime.runtimeHost,
				events: options.observability
					? createObservedConversationEvents({
							transaction,
							telemetry: options.observability,
						})
					: createConversationEventUseCaseV1({ transaction }),
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
		sampling = Promise.resolve()
			.then(async () => {
				if (!canSampleResources()) return;
				const snapshot = await store.readResourceSnapshot(signal);
				if (!canSampleResources()) return;
				options.observability?.observeResource?.({
					kind: "task_waiting",
					value: snapshot.taskWaiting,
				});
				options.observability?.observeResource?.({
					kind: "outbox_pending",
					value: snapshot.outboxPending,
				});
			})
			.catch(() => {
				if (!stopped && !signal.aborted)
					log("CONVERSATION_RESOURCE_SNAPSHOT_UNAVAILABLE");
			})
			.finally(() => {
				sampling = undefined;
				if (canSampleResources())
					resourceTimer = setTimeout(sampleResources, 1000);
			});
	}
	async function dispatchItem(item: {
		readonly itemId: string;
		readonly operation: string;
	}) {
		if (item.operation !== "conversation.sandbox.reconcile.v1")
			return dispatch.dispatch({
				schemaVersion: 1,
				itemId: item.itemId,
				workerId: options.workerId,
			});
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
	async function discover() {
		if (stopped || signal.aborted) return 0;
		const limit = 256;
		const items = await store.findDispatchable({
			limit,
			...(afterItemId ? { afterItemId } : {}),
			signal,
		});
		let launched = 0;
		let lastBusinessItemId: string | undefined;
		for (const item of items) {
			if (stopped || signal.aborted) break;
			// Advance after every scanned item; the Store wraps deferred work on the next lap.
			afterItemId = item.itemId;
			if (running.has(item.itemId)) continue;
			const control = item.operation === "conversation.turn.stop.v1";
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
		start() {
			if (started || stopped) return;
			started = true;
			void poll();
			sampleResources();
			void wakeups?.start().catch(() => {
				if (!stopped && !signal.aborted)
					log("CONVERSATION_COMMIT_WAKEUP_UNAVAILABLE");
			});
		},
		stop() {
			if (closing) return closing;
			stopped = true;
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
				if (failure) throw failure.reason;
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
