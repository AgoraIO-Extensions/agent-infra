import { pathToFileURL } from "node:url";
import { startPlatformWorkloadWorkerFromDeploymentV1 } from "./workload-worker.js";

export * from "./kubernetes-client.js";
export * from "./kubernetes-runtime-adapter.js";
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
		readonly startPrimary?: () => { stop(): void };
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
				stopping ??= Promise.all([
					Promise.resolve(primary.stop()),
					workload.stop(),
				]).then(() => undefined);
				return stopping;
			},
		};
	} catch (error) {
		primary.stop();
		throw error;
	}
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	const worker = await startPlatformWorkerFromDeploymentV1();
	process.once("SIGINT", () => {
		void worker.stop();
	});
	process.once("SIGTERM", () => {
		void worker.stop();
	});
}
