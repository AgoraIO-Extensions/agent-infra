import { randomUUID } from "node:crypto";
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
	readonly wecom: unknown;
};

// Deployment-owned code supplies current IdentityAdapter facts and Worker-only material.
// The adjacent configuration.mjs is mounted by the deployment, never bundled into the image.
const { workloadInput, signing, serviceToken, directory, wecom } =
	(await import(
		new URL("./configuration.mjs", import.meta.url).href
	)) as DeploymentConfiguration;

const instanceId = randomUUID();
let prepared: ReturnType<typeof createPrepared> | undefined;

async function createPrepared(signal: AbortSignal) {
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

export async function createPlatformConversationWorkerOptionsV2(
	signal: AbortSignal,
) {
	return (await prepare(signal)).conversation;
}

export async function createPlatformWecomWorkerInstanceV1(signal: AbortSignal) {
	return (await prepare(signal)).wecom.start(signal);
}
