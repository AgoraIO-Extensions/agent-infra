import { pathToFileURL } from "node:url";

import { createSecretActivationUseCaseV1 } from "@agent-infra/platform-core";
import { openPostgresSecretActivationStoreV1 } from "@agent-infra/platform-store";

import { createWorkerSecretDecryptorV1 } from "./secret-decryptor.js";
import {
	createWorkerSecretActivationKubernetesPortV1,
	type WorkerSecretKubernetesClientV1,
} from "./secret-kubernetes-adapter.js";

export {
	createWorkerSecretActivationKubernetesPortV1,
	type WorkerSecretKubernetesClientV1,
} from "./secret-kubernetes-adapter.js";

export const platformWorkerService = "platform-worker";

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
				decryptor: createWorkerSecretDecryptorV1({ keys: options.keys }),
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

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	const worker = startPlatformWorker();
	process.once("SIGINT", worker.stop);
	process.once("SIGTERM", worker.stop);
}
