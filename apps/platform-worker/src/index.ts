import { pathToFileURL } from "node:url";
import {
	type ObservabilityOptions,
	type PlatformQueueResourceSnapshot,
	startObservability,
	startPlatformResourceSampler,
} from "@agent-infra/observability";
import { createObservedConversationEvents } from "@agent-infra/observability/worker";
import { startPlatformConversationWorkerFromDeploymentV2 } from "./conversation-worker.js";
import { startPlatformWorkloadWorkerFromDeploymentV1 } from "./workload-worker.js";

export * from "./conversation-deployment.js";
export * from "./conversation-runtime.js";
export * from "./conversation-worker.js";
export * from "./kubernetes-client.js";
export * from "./kubernetes-runtime-adapter.js";
export * from "./runtime-grant-signer.js";
export * from "./workload-deployment.js";
export * from "./workload-runtime.js";
export * from "./workload-worker.js";

import {
	type ConversationDispatchAuthorizationPortV1,
	createConversationDispatchUseCaseV1,
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
	readonly telemetry?: ReturnType<typeof startObservability>;
}) {
	const store = openPostgresConversationDispatchStoreV1({
		databaseUrl: options.databaseUrl,
	});
	const eventTransaction = new PostgresConversationEventTransactionV1({
		databaseUrl: options.databaseUrl,
	});
	const telemetry =
		options.telemetry ?? startObservability({ service: "platform-worker" });
	try {
		const dispatch = createConversationDispatchUseCaseV1(
			{
				store,
				authorization: options.authorization,
				runtimeHost: createWorkerRuntimeHostClientV1(options.runtimeHost),
				events: createObservedConversationEvents({
					transaction: eventTransaction,
					telemetry,
				}),
			},
			{
				leaseDurationMs: options.leaseDurationMs,
				retryDelayMs: options.retryDelayMs,
			},
		);
		return {
			dispatch: dispatch.dispatch,
			close: () =>
				Promise.all([
					eventTransaction.close(),
					store.close(),
					telemetry.close(),
				]),
		};
	} catch (error) {
		void Promise.allSettled([
			eventTransaction.close(),
			store.close(),
			telemetry.close(),
		]);
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
			stop(): Promise<void>;
			readQueue?: (
				signal: AbortSignal,
			) => Promise<PlatformQueueResourceSnapshot>;
		}>;
		readonly observabilityOptions?: Omit<ObservabilityOptions, "service">;
	} = {},
) {
	type StartedConversation = {
		stop(): Promise<void>;
		readQueue?: (signal: AbortSignal) => Promise<PlatformQueueResourceSnapshot>;
	};
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
	let conversation: StartedConversation | undefined;
	let sampler: ReturnType<typeof startPlatformResourceSampler> | undefined;
	try {
		workload = await (
			options.startWorkload ?? startPlatformWorkloadWorkerFromDeploymentV1
		)();
		conversation = await (
			options.startConversation ??
			((telemetry) =>
				startPlatformConversationWorkerFromDeploymentV2(
					undefined,
					undefined,
					telemetry,
				))
		)(observability);
		if (conversation.readQueue) {
			sampler = startPlatformResourceSampler({
				telemetry: observability,
				readQueue: conversation.readQueue,
				...(options.observabilityOptions?.metricIntervalMs === undefined
					? {}
					: { intervalMs: options.observabilityOptions.metricIntervalMs }),
			});
		}
		let stopping: Promise<void> | undefined;
		return {
			observabilityStatus: observability.status,
			sampler,
			stop() {
				stopping ??= (async () => {
					sampler?.stop();
					const results: PromiseSettledResult<void>[] = [];
					try {
						for (const stop of [
							() => conversation?.stop(),
							() => workload?.stop(),
							() => primary.stop(),
						]) {
							results.push(
								...(await Promise.allSettled([Promise.resolve().then(stop)])),
							);
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
		sampler?.stop();
		await Promise.allSettled([
			Promise.resolve().then(() => primary.stop()),
			Promise.resolve().then(() => workload?.stop()),
			Promise.resolve().then(() => conversation?.stop()),
		]);
		await observability.close();
		throw error;
	}
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	const shutdownDeadlineMs = 10_000;
	const termination = new AbortController();
	let primary: ReturnType<typeof startPlatformWorker> | undefined;
	const workerPromise = startPlatformWorkerFromDeploymentV2({
		startPrimary: () => {
			primary = startPlatformWorker();
			return primary;
		},
		startConversation: (telemetry) =>
			startPlatformConversationWorkerFromDeploymentV2(
				undefined,
				termination.signal,
				telemetry,
			),
		startWorkload: () =>
			startPlatformWorkloadWorkerFromDeploymentV1(
				undefined,
				termination.signal,
			),
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
		process.exitCode = 1;
	});
}

export { createWorkerFileClientV1 } from "./file-client.js";
export { createPlatformFileReconciliationWorkerV1 } from "./file-worker.js";
