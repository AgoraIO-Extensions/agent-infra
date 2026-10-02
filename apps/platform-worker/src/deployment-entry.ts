import { randomUUID } from "node:crypto";
import {
	PostgresConversationExecutionTransactionV1,
	PostgresRelayKeyVersionStoreV1,
} from "@agent-infra/platform-store";
import { createRelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import { createProductionConversationRuntimeResolverV2 } from "./conversation-deployment.js";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import { createWecomDeploymentCoordinatorV1 } from "./wecom-deployment.js";
import {
	createProductionWorkloadWorkerOptionsV1,
	createWorkloadReadinessAuthorizationV1,
} from "./workload-deployment.js";

type DeploymentConfiguration = {
	readonly workloadInput: Omit<
		Parameters<typeof createProductionWorkloadWorkerOptionsV1>[0],
		"workerId" | "runtimeProbe"
	>;
	readonly signing: ConversationRuntimeOptionsV2["signing"];
	readonly serviceToken: string;
	readonly directory: ConversationRuntimeOptionsV2["directory"];
	readonly relayKeyDecryptionKeys?: Parameters<
		typeof createRelayKeyWorkerDecryptorV1
	>[0]["keys"];
	readonly wecom: unknown;
};

// Deployment-owned code supplies current IdentityAdapter facts and Worker-only material.
// The adjacent configuration.mjs is mounted by the deployment, never bundled into the image.
const {
	workloadInput,
	signing,
	serviceToken,
	directory,
	relayKeyDecryptionKeys,
	wecom,
} = (await import(
	new URL("./configuration.mjs", import.meta.url).href
)) as DeploymentConfiguration;

const instanceId = randomUUID();
let prepared: ReturnType<typeof createPrepared> | undefined;
let conversationPrepared:
	| ReturnType<typeof createConversationPrepared>
	| undefined;

async function createPrepared(signal: AbortSignal) {
	let relayKeyDecryptor: ConversationRuntimeOptionsV2["relayKeyDecryptor"];
	if (workloadInput.runtimeModelVersion === 4) {
		if (!relayKeyDecryptionKeys)
			throw new Error("WORKER_EXECUTION_KEY_CONFIGURATION_INVALID");
		try {
			relayKeyDecryptor = createRelayKeyWorkerDecryptorV1({
				keys: relayKeyDecryptionKeys,
			});
		} catch {
			throw new Error("WORKER_EXECUTION_KEY_CONFIGURATION_INVALID");
		}
	}
	const workload = await createProductionWorkloadWorkerOptionsV1(
		{
			...workloadInput,
			workerId: signing.workerId,
			runtimeProbe: createWorkloadReadinessAuthorizationV1({
				...signing,
				serviceToken,
			}),
		},
		signal,
	);
	const wecomDeployment = createWecomDeploymentCoordinatorV1({
		databaseUrl: workload.databaseUrl,
		configuration: wecom,
	});
	return {
		// Database lease ownership is per process; Runtime service identity is deployment-bound.
		workload: { ...workload, workerId: instanceId },
		conversation: {
			databaseUrl: workload.databaseUrl,
			workerId: instanceId,
			signing,
			directory,
			relayKeyDecryptor,
			channelAuthorizationCurrent: wecomDeployment.channelAuthorizationCurrent,
			resolveRuntimeHost: createProductionConversationRuntimeResolverV2({
				workload: { ...workload, workerId: signing.workerId },
				signing,
				serviceToken,
			}),
			fetch: workload.fetch,
		},
		wecom: wecomDeployment,
	};
}

function prepare(signal: AbortSignal) {
	prepared ??= createPrepared(signal);
	return prepared;
}

export async function createPlatformWorkloadWorkerOptionsV1(
	signal: AbortSignal,
) {
	return (await prepare(signal)).workload;
}

async function createConversationPrepared(signal: AbortSignal) {
	const deployment = await prepare(signal);
	signal.throwIfAborted();
	if (workloadInput.runtimeModelVersion !== 4) return deployment.conversation;
	let accepted: PostgresConversationExecutionTransactionV1 | undefined;
	let ciphertext: PostgresRelayKeyVersionStoreV1 | undefined;
	try {
		accepted = new PostgresConversationExecutionTransactionV1({
			databaseUrl: deployment.conversation.databaseUrl,
		});
		ciphertext = new PostgresRelayKeyVersionStoreV1({
			databaseUrl: deployment.conversation.databaseUrl,
		});
		signal.throwIfAborted();
		const acceptedStore = accepted;
		const ciphertextStore = ciphertext;
		let closing: Promise<void> | undefined;
		return {
			...deployment.conversation,
			executionKeys: {
				readAcceptedExecution: (
					request: Parameters<typeof acceptedStore.readAcceptedExecution>[0],
				) => acceptedStore.readAcceptedExecution(request),
				readCiphertext: (binding: Parameters<typeof ciphertextStore.read>[0]) =>
					ciphertextStore.read(binding),
			},
			// The outer loader calls this only after the original Worker has joined.
			closeDeployment() {
				closing ??= Promise.allSettled([
					Promise.resolve().then(() => acceptedStore.close()),
					Promise.resolve().then(() => ciphertextStore.close()),
				]).then((results) => {
					if (results.some((result) => result.status === "rejected"))
						throw new Error("WORKER_EXECUTION_KEY_CLEANUP_UNAVAILABLE");
				});
				return closing;
			},
		};
	} catch {
		await Promise.allSettled([
			Promise.resolve().then(() => accepted?.close()),
			Promise.resolve().then(() => ciphertext?.close()),
		]);
		throw new Error("WORKER_EXECUTION_KEY_CONFIGURATION_INVALID");
	}
}

export function createPlatformConversationWorkerOptionsV2(signal: AbortSignal) {
	conversationPrepared ??= createConversationPrepared(signal);
	return conversationPrepared;
}

export async function createPlatformWecomWorkerInstanceV1(signal: AbortSignal) {
	return (await prepare(signal)).wecom.start(signal);
}
