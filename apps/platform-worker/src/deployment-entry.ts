import { createPublicKey, randomUUID } from "node:crypto";
import { createProductionConversationRuntimeResolverV2 } from "./conversation-deployment.js";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import {
	createProductionNativeMetadataWorkerOptionsV1,
	type ProductionNativeMetadataWorkerInputV1,
} from "./native-metadata-production.js";
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

const metadataModule =
	process.env.PLATFORM_WORKER_NATIVE_METADATA_CONFIGURATION_MODULE;
let nativeMetadata: ProductionNativeMetadataWorkerInputV1 | undefined;
if (metadataModule) {
	try {
		if (new URL(metadataModule).protocol !== "file:") throw new Error();
		nativeMetadata = (await import(metadataModule)).nativeMetadata;
		if (!nativeMetadata) throw new Error();
	} catch {
		throw new Error("Native metadata Worker configuration is unavailable");
	}
}

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

export function createPlatformNativeMetadataWorkerOptionsV1(
	signal: AbortSignal,
) {
	if (!nativeMetadata)
		throw new Error("Native metadata Worker deployment is unavailable");
	const hostConfiguration = workloadInput.policy.runtimeAuth?.nativeMetadata;
	if (
		!hostConfiguration ||
		hostConfiguration.issuer !== nativeMetadata.signing.issuer ||
		hostConfiguration.keyVersion !== nativeMetadata.signing.keyVersion ||
		hostConfiguration.publicKeyDerBase64 !==
			createPublicKey(nativeMetadata.signing.privateKey)
				.export({ type: "spki", format: "der" })
				.toString("base64") ||
		[...nativeMetadata.agents.keys()].some(
			(id) => !hostConfiguration.agents.has(id),
		) ||
		hostConfiguration.agents.size !== nativeMetadata.agents.size
	)
		throw new Error(
			"Native metadata Host configuration does not match the Worker",
		);
	return createProductionNativeMetadataWorkerOptionsV1(
		nativeMetadata,
		{ signing, serviceToken },
		signal,
	);
}
