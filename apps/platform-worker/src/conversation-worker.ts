import {
	createConversationDispatchUseCaseV1,
	createConversationEventUseCaseV1,
} from "@agent-infra/platform-core";
import {
	openPostgresConversationDispatchStoreV1,
	PostgresConversationEventTransactionV1,
	PostgresLegacyTaskRecoveryReaderV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import {
	type ConversationRuntimeOptionsV2,
	createConversationRuntimeV2,
} from "./conversation-runtime.js";
import {
	createPlatformWecomWorkerV1,
	type WecomWorkerDeploymentV1,
} from "./wecom-worker.js";

export interface PlatformConversationWorkerOptionsV2
	extends Omit<
		ConversationRuntimeOptionsV2,
		"dispatchStore" | "taskAuthorizationStore" | "legacyControlStore"
	> {
	readonly databaseUrl: string;
	readonly wecom?: WecomWorkerDeploymentV1;
	readonly pollIntervalMs?: number;
	readonly maximumConcurrentDispatches?: number;
	readonly leaseDurationMs?: number;
	readonly retryDelayMs?: number;
	readonly log?: (message: string) => void;
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
	const wecom = options.wecom
		? createPlatformWecomWorkerV1({
				...options.wecom,
				databaseUrl: options.databaseUrl,
			})
		: undefined;
	let runtime: ReturnType<typeof createConversationRuntimeV2>;
	let dispatch: ReturnType<typeof createConversationDispatchUseCaseV1>;
	try {
		runtime = createConversationRuntimeV2({
			...options,
			channelAuthorizationCurrent: async (record, signal) => {
				if (
					options.channelAuthorizationCurrent &&
					!(await options.channelAuthorizationCurrent(record, signal))
				)
					return false;
				return wecom
					? wecom.channelAuthorizationCurrent(record)
					: !/^wecom_(bot|app):/.test(record.boundary.channelId);
			},
			signal,
			dispatchStore: store,
			taskAuthorizationStore,
			legacyControlStore,
		});
		dispatch = createConversationDispatchUseCaseV1(
			{
				store,
				authorization: runtime.authorization,
				runtimeHost: runtime.runtimeHost,
				events: createConversationEventUseCaseV1({ transaction }),
			},
			{
				leaseDurationMs: options.leaseDurationMs,
				retryDelayMs: options.retryDelayMs,
			},
		);
	} catch (error) {
		controller.abort();
		void Promise.allSettled([
			...(wecom ? [wecom.close()] : []),
			transaction.close(),
			store.close(),
			taskAuthorizationStore.close(),
			legacyControlStore.close(),
		]);
		throw error;
	}
	const running = new Map<
		string,
		{ control: boolean; promise: Promise<void> }
	>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let polling: Promise<number> | undefined;
	let wecomPolling: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let started = false;
	let stopped = false;
	let afterItemId: string | undefined;
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
	async function discover() {
		if (stopped || signal.aborted) return 0;
		const items = await store.findDispatchable({
			limit: 256,
			...(afterItemId ? { afterItemId } : {}),
		});
		let launched = 0;
		for (const item of items) {
			if (stopped || signal.aborted) break;
			afterItemId = item.itemId;
			if (running.has(item.itemId)) continue;
			const control = item.operation === "conversation.turn.stop.v1";
			const count = [...running.values()].filter(
				(entry) => entry.control === control,
			).length;
			// A busy streaming Turn cannot consume the capacity needed to stop it.
			if (count >= (control ? 2 : maximum)) continue;
			const promise = dispatch
				.dispatch({
					schemaVersion: 1,
					itemId: item.itemId,
					workerId: options.workerId,
				})
				.then(
					() => undefined,
					() => {
						log("CONVERSATION_DISPATCH_UNAVAILABLE");
					},
				)
				.finally(() => running.delete(item.itemId));
			running.set(item.itemId, { control, promise });
			launched += 1;
		}
		return launched;
	}
	function tick() {
		if (stopped || signal.aborted) return Promise.resolve(0);
		if (polling) return polling;
		polling = discover().finally(() => {
			polling = undefined;
		});
		return polling;
	}
	function poll() {
		if (stopped || signal.aborted) return;
		if (!polling)
			void tick().catch(() => log("CONVERSATION_DISCOVERY_UNAVAILABLE"));
		if (wecom && !wecomPolling)
			wecomPolling = wecom
				.dispatch()
				.then(() => undefined)
				.catch(() => log("CONVERSATION_DISCOVERY_UNAVAILABLE"))
				.finally(() => {
					wecomPolling = undefined;
				});
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
		},
		stop() {
			if (closing) return closing;
			stopped = true;
			clearTimeout(timer);
			controller.abort();
			runtime.close();
			closing = (async () => {
				await Promise.allSettled([
					polling,
					wecomPolling,
					...[...running.values()].map((entry) => entry.promise),
				]);
				const results = await Promise.allSettled([
					...(wecom ? [wecom.close()] : []),
					transaction.close(),
					store.close(),
					taskAuthorizationStore.close(),
					legacyControlStore.close(),
				]);
				const failure = results.find(
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
	});
	if (assemblySignal.aborted) await worker.stop();
	else worker.start();
	return worker;
}
