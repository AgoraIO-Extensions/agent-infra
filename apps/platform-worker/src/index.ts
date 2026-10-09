import { pathToFileURL } from "node:url";
import {
	type ObservabilityOptions,
	startObservability,
} from "@agent-infra/observability";
import {
	type PlatformConversationWorkerLifecycleStatusV1,
	startPlatformConversationWorkerFromDeploymentV2,
} from "./conversation-worker.js";
import { startPlatformWecomWorkerFromDeploymentV1 } from "./wecom-deployment.js";
import { startPlatformWorkloadWorkerFromDeploymentV1 } from "./workload-worker.js";

export * from "./conversation-deployment.js";
export * from "./conversation-runtime.js";
export * from "./conversation-worker.js";
export * from "./kubernetes-client.js";
export * from "./kubernetes-runtime-adapter.js";
export * from "./runtime-grant-signer.js";
export * from "./skill-materialization.js";
export * from "./wecom-deployment.js";
export { createPlatformWecomWorkerV1 } from "./wecom-worker.js";
export * from "./workload-deployment.js";
export * from "./workload-runtime.js";
export * from "./workload-worker.js";

import {
	type ConversationDispatchAuthorizationPortV1,
	createConversationDispatchUseCaseV1,
	createConversationEventUseCaseV1,
	createSecretActivationUseCaseV1,
	createSecretKeyRotationUseCaseV1,
} from "@agent-infra/platform-core";
import {
	openPostgresConversationDispatchStoreV1,
	openPostgresSecretActivationStoreV1,
	openPostgresSecretKeyRotationStoreV1,
	PostgresConversationEventTransactionV1,
} from "@agent-infra/platform-store";
import {
	createSecretKeyRotationCryptoV1,
	createSecretKeyringDecryptorV1,
} from "@agent-infra/secret-store/worker";
import {
	createWorkerRuntimeHostClientV1,
	type WorkerRuntimeHostClientOptionsV1,
} from "./runtime-host-client.js";
import {
	createWorkerSecretActivationKubernetesPortV1,
	type WorkerSecretKubernetesClientV1,
} from "./secret-kubernetes-adapter.js";

export {
	createWorkerRuntimeHostClientV1,
	createWorkerRuntimeHostClientV3,
	type WorkerRuntimeHostClientOptionsV1,
} from "./runtime-host-client.js";
export {
	createWorkerSecretActivationKubernetesPortV1,
	type WorkerSecretKubernetesClientV1,
} from "./secret-kubernetes-adapter.js";

export const platformWorkerService = "platform-worker";

export function createPlatformConversationDispatchWorkerV1(options: {
	readonly databaseUrl: string;
	readonly authorization: ConversationDispatchAuthorizationPortV1;
	readonly runtimeHost: WorkerRuntimeHostClientOptionsV1;
	readonly leaseDurationMs?: number;
	readonly retryDelayMs?: number;
}) {
	const store = openPostgresConversationDispatchStoreV1({
		databaseUrl: options.databaseUrl,
	});
	const eventTransaction = new PostgresConversationEventTransactionV1({
		databaseUrl: options.databaseUrl,
	});
	try {
		const dispatch = createConversationDispatchUseCaseV1(
			{
				store,
				authorization: options.authorization,
				runtimeHost: createWorkerRuntimeHostClientV1(options.runtimeHost),
				events: createConversationEventUseCaseV1({
					transaction: eventTransaction,
				}),
			},
			{
				leaseDurationMs: options.leaseDurationMs,
				retryDelayMs: options.retryDelayMs,
			},
		);
		return {
			dispatch: dispatch.dispatch,
			close: () => Promise.all([eventTransaction.close(), store.close()]),
		};
	} catch (error) {
		void Promise.allSettled([eventTransaction.close(), store.close()]);
		throw error;
	}
}

export function createPlatformSecretActivationWorkerV1(options: {
	readonly databaseUrl: string;
	readonly kubernetesClient: WorkerSecretKubernetesClientV1;
	readonly keys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
	readonly leaseMs?: number;
}) {
	const store = openPostgresSecretActivationStoreV1({
		databaseUrl: options.databaseUrl,
	});
	try {
		const activation = createSecretActivationUseCaseV1(
			{
				store,
				kubernetes: createWorkerSecretActivationKubernetesPortV1(
					options.kubernetesClient,
				),
				decryptor: createSecretKeyringDecryptorV1({ keys: options.keys }),
			},
			{ leaseMs: options.leaseMs },
		);
		return {
			activate: activation.activate,
			close: () => store.close(),
		};
	} catch (error) {
		void store.close().catch(() => undefined);
		throw error;
	}
}

export function createPlatformSecretRotationWorkerV1(options: {
	readonly databaseUrl: string;
	readonly keys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
	readonly encryptionKeys: unknown;
	readonly now?: () => Date;
}) {
	const store = openPostgresSecretKeyRotationStoreV1({
		databaseUrl: options.databaseUrl,
	});
	try {
		const rotation = createSecretKeyRotationUseCaseV1({
			store,
			crypto: createSecretKeyRotationCryptoV1({
				keys: options.keys,
				encryptionKeys: options.encryptionKeys,
				now: options.now,
			}),
		});
		return {
			rotate: rotation.rotate,
			retire: rotation.retire,
			close: () => store.close(),
		};
	} catch (error) {
		void store.close().catch(() => undefined);
		throw error;
	}
}

interface StartOptions {
	heartbeatMs?: number;
	log?: (message: string) => void;
}

export function startPlatformWorker(options: StartOptions = {}) {
	const log = options.log ?? console.info;
	const heartbeat = setInterval(() => undefined, options.heartbeatMs ?? 60_000);
	let stopped = false;

	log(JSON.stringify({ service: platformWorkerService, status: "ready" }));

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(heartbeat);
			log(
				JSON.stringify({ service: platformWorkerService, status: "stopped" }),
			);
		},
	};
}

export async function startPlatformWorkerFromDeploymentV1(
	options: {
		readonly startPrimary?: () => { stop(): void | Promise<void> };
		readonly startWorkload?: () => Promise<{ stop(): Promise<void> }>;
	} = {},
) {
	const primary = (options.startPrimary ?? startPlatformWorker)();
	try {
		const workload = await (
			options.startWorkload ?? startPlatformWorkloadWorkerFromDeploymentV1
		)();
		let stopping: Promise<void> | undefined;
		return {
			stop() {
				stopping ??= Promise.allSettled([
					Promise.resolve().then(() => primary.stop()),
					Promise.resolve().then(() => workload.stop()),
				]).then((results) => {
					const failure = results.find(
						(result): result is PromiseRejectedResult =>
							result.status === "rejected",
					);
					if (failure) throw failure.reason;
				});
				return stopping;
			},
		};
	} catch (error) {
		try {
			await primary.stop();
		} catch {
			// Preserve the workload assembly error; primary cleanup is best effort here.
		}
		throw error;
	}
}

export async function startPlatformWorkerFromDeploymentV2(
	options: {
		readonly startPrimary?: () => { stop(): void | Promise<void> };
		readonly startWorkload?: () => Promise<{ stop(): Promise<void> }>;
		readonly startConversation?: (
			observability: ReturnType<typeof startObservability>,
		) => Promise<{
			status(): PlatformConversationWorkerLifecycleStatusV1;
			stop(): Promise<void>;
		}>;
		readonly startWecom?: () => Promise<{ stop(): Promise<void> }>;
		readonly observabilityOptions?: Omit<ObservabilityOptions, "service">;
	} = {},
) {
	const observability = startObservability({
		service: platformWorkerService,
		...(process.env.AGENT_INFRA_OBSERVABILITY_OTLP_ENDPOINT
			? {
					otlpEndpoint: process.env.AGENT_INFRA_OBSERVABILITY_OTLP_ENDPOINT,
				}
			: {}),
		...options.observabilityOptions,
	});
	let primary: { stop(): void | Promise<void> };
	try {
		primary = (options.startPrimary ?? startPlatformWorker)();
	} catch (error) {
		await observability.close();
		throw error;
	}
	let workload: { stop(): Promise<void> } | undefined;
	let conversation:
		| {
				status(): PlatformConversationWorkerLifecycleStatusV1;
				stop(): Promise<void>;
		  }
		| undefined;
	let wecom: { stop(): Promise<void> } | undefined;
	try {
		workload = await (
			options.startWorkload ?? startPlatformWorkloadWorkerFromDeploymentV1
		)();
		wecom = await options.startWecom?.();
		conversation = await (
			options.startConversation ??
			((telemetry) =>
				startPlatformConversationWorkerFromDeploymentV2(
					undefined,
					undefined,
					telemetry,
				))
		)(observability);
		let stopping: Promise<void> | undefined;
		return {
			observabilityStatus: observability.status,
			conversationStatus() {
				return conversation?.status() ?? "not_started";
			},
			stop() {
				stopping ??= (async () => {
					const results: PromiseSettledResult<void>[] = [];
					try {
						for (const stop of [
							() => conversation?.stop(),
							() => wecom?.stop(),
							() => workload?.stop(),
							() => primary.stop(),
						]) {
							let result: Promise<void>;
							try {
								result = Promise.resolve(stop());
							} catch (error) {
								result = Promise.reject(error);
							}
							results.push(...(await Promise.allSettled([result])));
						}
					} finally {
						await observability.close();
					}
					const failure = results.find(
						(result): result is PromiseRejectedResult =>
							result.status === "rejected",
					);
					if (failure) throw failure.reason;
				})();
				return stopping;
			},
		};
	} catch (error) {
		await Promise.allSettled([
			Promise.resolve().then(() => primary.stop()),
			Promise.resolve().then(() => workload?.stop()),
			Promise.resolve().then(() => conversation?.stop()),
			Promise.resolve().then(() => wecom?.stop()),
		]);
		await observability.close();
		throw error;
	}
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	const shutdownDeadlineMs = 10_000;
	const termination = new AbortController();
	const wecomSetting = process.env.PLATFORM_WORKER_WECOM_ENABLED;
	if (wecomSetting !== undefined && !["true", "false"].includes(wecomSetting))
		throw new Error("PLATFORM_WORKER_WECOM_ENABLED must be true or false");
	const wecomEnabled = wecomSetting === "true";
	let primary: ReturnType<typeof startPlatformWorker> | undefined;
	const workerPromise = startPlatformWorkerFromDeploymentV2({
		startPrimary: () => {
			primary = startPlatformWorker();
			return primary;
		},
		startConversation: (observability) =>
			startPlatformConversationWorkerFromDeploymentV2(
				undefined,
				termination.signal,
				observability,
			),
		startWorkload: () =>
			startPlatformWorkloadWorkerFromDeploymentV1(
				undefined,
				termination.signal,
			),
		...(wecomEnabled
			? {
					startWecom: () =>
						startPlatformWecomWorkerFromDeploymentV1(
							undefined,
							termination.signal,
						),
				}
			: {}),
	});
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		const deadline = setTimeout(() => process.exit(1), shutdownDeadlineMs);
		deadline.unref();
		termination.abort();
		let primaryStop: Promise<void>;
		try {
			primaryStop = Promise.resolve(primary?.stop());
		} catch {
			primaryStop = Promise.reject();
		}
		void Promise.all([
			primaryStop,
			workerPromise.then((worker) => worker.stop()),
		]).then(
			() => clearTimeout(deadline),
			() => {
				process.exitCode = 1;
			},
		);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	void workerPromise.catch(() => {
		console.error(
			"Platform Worker failed to start; check deployment configuration",
		);
		process.exitCode = 1;
	});
}

export {
	type BrowserActionOperationControllerRecordV1,
	type BrowserActionOperationControllerRequestV1,
	type BrowserActionOperationInputV1,
	type BrowserActionOperationResultV1,
	createBrowserActionOperationAdapterV1,
} from "./browser-action-operation.js";
export {
	type BrowserFileExecutionBindingV1,
	type BrowserFileGrantBridgeV1,
	createBrowserFileGrantBridgeV1,
} from "./browser-file-bridge.js";
export {
	type BrowserRecoveryBindingV1,
	type BrowserRecoveryResultV1,
	type BrowserRecoveryStatusV1,
	createBrowserRecoveryConsumerV1,
} from "./browser-recovery-consumer.js";
export {
	type BrowserRecoveryEventInputV1,
	createBrowserRecoveryEventAdapterV1,
} from "./browser-recovery-events.js";
export {
	type BrowserResultFileEventBindingV1,
	type BrowserResultFileEventInputV1,
	type BrowserResultFileEventResultV1,
	createBrowserResultFileEventAdapterV1,
} from "./browser-result-file-event.js";
export { createWorkerFileClientV1 } from "./file-client.js";
export { createPlatformFileReconciliationWorkerV1 } from "./file-worker.js";
export {
	createSessionSandboxEgressV1,
	type SessionSandboxEgressBindingV1,
	type SessionSandboxEgressReceiptV1,
} from "./session-sandbox-egress.js";
export * from "./session-workload-adapter.js";
