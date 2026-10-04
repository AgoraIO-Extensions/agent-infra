import { randomUUID } from "node:crypto";
import * as conversationDeployment from "./conversation-deployment.js";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import { createWecomDeploymentCoordinatorV1 } from "./wecom-deployment.js";
import {
	createProductionWorkloadWorkerOptionsV1,
	createWorkloadReadinessAuthorizationV1,
} from "./workload-deployment.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";

type DeploymentConfiguration = {
	readonly workloadInput: Omit<
		Parameters<typeof createProductionWorkloadWorkerOptionsV1>[0],
		"workerId" | "runtimeProbe" | "databaseUrl"
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
	const databaseUrl = process.env.PLATFORM_DATABASE_URL;
	try {
		if (!databaseUrl) throw new Error();
		const parsed = new URL(databaseUrl);
		if (
			!["postgres:", "postgresql:"].includes(parsed.protocol) ||
			!parsed.hostname ||
			parsed.pathname.length < 2
		)
			throw new Error();
	} catch {
		throw new Error("PLATFORM_DATABASE_URL must name a PostgreSQL database");
	}
	const namespace = process.env.PLATFORM_WORKER_NAMESPACE;
	if (
		!namespace ||
		namespace.length > 63 ||
		!/^([a-z0-9])([-a-z0-9]*[a-z0-9])?$/.test(namespace) ||
		namespace !== workloadInput.policy.namespace
	)
		throw new Error(
			"PLATFORM_WORKER_NAMESPACE must match the workload policy namespace",
		);
	const workload = await createProductionWorkloadWorkerOptionsV1(
		{
			...workloadInput,
			databaseUrl,
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
			sandboxPolicy: {
				namespace: workload.policy.namespace,
				resourceConfigurationHash: workloadResourceConfigurationHashV1(
					workload.policy,
				),
			},
			receiveSandbox:
				conversationDeployment.createProductionSessionSandboxReceiverV1({
					...workload,
					workerId: signing.workerId,
				}),
			resolveRuntimeHost:
				conversationDeployment.createProductionConversationRuntimeResolverV2({
					workload: { ...workload, workerId: signing.workerId },
					signing,
					serviceToken,
				}),
			fetch: workload.fetch,
			runtimeTlsFetch: workload.runtimeTlsFetch,
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
