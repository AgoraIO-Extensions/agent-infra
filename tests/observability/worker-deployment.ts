import { generateKeyPairSync } from "node:crypto";
import type { SessionSandboxObservationV1 } from "@agent-infra/platform-core";
import type { PlatformConversationWorkerOptionsV2 } from "../../apps/platform-worker/src/conversation-worker.js";

let databaseUrl: string | undefined;
let log: (message: string) => void = () => {};
const keys = generateKeyPairSync("ed25519");

export function configureWorkerDeployment(
	url: string,
	output: (message: string) => void,
) {
	databaseUrl = url;
	log = output;
}

export async function createPlatformConversationWorkerOptionsV2(
	signal: AbortSignal,
): Promise<PlatformConversationWorkerOptionsV2> {
	signal.throwIfAborted();
	if (!databaseUrl) throw new Error("Worker test database is not configured");
	return {
		sandboxPolicy: {
			namespace: "workload-test",
			resourceConfigurationHash: "controlled-observability-sandbox-policy",
		},
		receiveSandbox: async (
			_signal: AbortSignal,
		): Promise<SessionSandboxObservationV1> => ({
			status: "unknown",
			resources: [],
		}),
		databaseUrl,
		pollIntervalMs: 30_000,
		workerId: "worker-queue-acceptance",
		signing: {
			issuer: "worker-queue-acceptance",
			workerId: "worker-queue-acceptance",
			keyId: "worker-queue-acceptance",
			privateKey: keys.privateKey,
		},
		directory: { resolveUser: async () => null },
		resolveRuntimeHost: async () => ({
			baseUrl: "http://127.0.0.1:9",
			serviceToken: "controlled-worker-queue-token",
			workerId: "worker-queue-acceptance",
		}),
		log,
	};
}

/** Thin child uses the real packaged V2 lifecycle with controlled unused services. */
export function workerProcessSources(input: {
	readonly databaseUrl: string;
	readonly collectorEndpoint: string;
	readonly workerEntrypoint: string;
	readonly deploymentModule: string;
}) {
	return {
		deployment: `import { generateKeyPairSync } from 'node:crypto';
const keys = generateKeyPairSync('ed25519');
export async function createPlatformConversationWorkerOptionsV2(signal) {
  signal.throwIfAborted();
  return {
    sandboxPolicy: { namespace: 'workload-test', resourceConfigurationHash: 'controlled-observability-sandbox-policy' },
    receiveSandbox: async (sandboxSignal) => { sandboxSignal.throwIfAborted(); return { status: 'unknown', resources: [] }; },
    databaseUrl: ${JSON.stringify(input.databaseUrl)},
    pollIntervalMs: 30_000,
    workerId: 'worker-queue-child',
    signing: { issuer: 'worker-queue-child', workerId: 'worker-queue-child', keyId: 'worker-queue-child', privateKey: keys.privateKey },
    directory: { resolveUser: async () => null },
    resolveRuntimeHost: async () => ({ baseUrl: 'http://127.0.0.1:9', serviceToken: 'controlled-worker-queue-token', workerId: 'worker-queue-child' }),
    log: console.info,
  };
}
`,
		runner: `import { startPlatformWorkerFromDeploymentV2, startPlatformConversationWorkerFromDeploymentV2 } from ${JSON.stringify(input.workerEntrypoint)};
const termination = new AbortController();
const running = startPlatformWorkerFromDeploymentV2({
  startPrimary: () => ({ stop() {} }),
  startWorkload: async () => ({ stop: async () => {} }),
  observabilityOptions: { otlpEndpoint: ${JSON.stringify(input.collectorEndpoint)}, metricIntervalMs: 1000 },
  startConversation: async telemetry => {
    const conversation = await startPlatformConversationWorkerFromDeploymentV2(${JSON.stringify(input.deploymentModule)}, termination.signal, telemetry);
    try {
      if (await conversation.tick() !== 0) throw new Error('Unexpected Worker queue fixture dispatch');
      return conversation;
    } catch (error) {
      try { await conversation.stop(); }
      catch (closeError) { throw new AggregateError([error, closeError], 'Initial discovery and cleanup failed'); }
      throw error;
    }
  },
});
let stopping;
process.on('SIGTERM', () => {
  termination.abort();
  stopping ??= running.then(worker => worker.stop());
  void stopping.catch(() => { process.exitCode = 1; });
});
await running;
console.info('WORKER_QUEUE_CHILD_READY');
`,
	};
}
