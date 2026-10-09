import { randomUUID } from "node:crypto";
import { RuntimeOAuthConfigurationV1Schema } from "@agent-infra/contracts/runtime";
import {
	createRuntimeConnectionConsumerSnapshotV1,
	createRuntimeConnectionInstallationRevisionV1,
} from "./connection-consumer-projection.js";
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
	readonly relayKeyDecryptionKeys?: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
	readonly wecom: unknown;
	readonly connectionConsumerProfile?: unknown;
	readonly connectionConsumerApproval?: unknown;
	readonly connectionInstallationSupply?: unknown;
	readonly connectionInstallation?: {
		readonly configuration: NonNullable<
			ConversationRuntimeOptionsV2["connectionInstallation"]
		>["configuration"];
		readonly authorize?: NonNullable<
			ConversationRuntimeOptionsV2["connectionInstallation"]
		>["authorize"];
	};
};

function resolveConnectionInstallation(
	value: unknown,
): DeploymentConfiguration["connectionInstallation"] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
	const candidate = value as Record<string, unknown>;
	if (
		!["configuration", "authorize,configuration"].includes(
			Object.keys(candidate).sort().join(","),
		) ||
		(candidate.authorize !== undefined &&
			typeof candidate.authorize !== "function")
	)
		throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
	try {
		return {
			configuration: RuntimeOAuthConfigurationV1Schema.parse(
				structuredClone(candidate.configuration),
			),
			authorize: candidate.authorize as NonNullable<
				ConversationRuntimeOptionsV2["connectionInstallation"]
			>["authorize"],
		};
	} catch {
		throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
	}
}

// Deployment-owned code supplies current IdentityAdapter facts and Worker-only material.
// The adjacent configuration.mjs is mounted by the deployment, never bundled into the image.
const {
	workloadInput,
	signing,
	serviceToken,
	directory,
	relayKeyDecryptionKeys,
	wecom,
	connectionConsumerProfile,
	connectionConsumerApproval,
	connectionInstallationSupply,
	connectionInstallation: configuredConnectionInstallation,
} = (await import(
	new URL("./configuration.mjs", import.meta.url).href
)) as DeploymentConfiguration;

// Both the Pod file and Runtime HTTP assertion consume this captured source.
const connectionConsumerSnapshot = createRuntimeConnectionConsumerSnapshotV1(
	connectionConsumerProfile,
	connectionConsumerApproval,
);
if (Object.hasOwn(workloadInput.policy, "connectionConsumerSnapshot"))
	throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
if (Object.hasOwn(workloadInput.policy, "connectionInstallationRevision"))
	throw new Error("CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE");
const connectionInstallationRevision =
	createRuntimeConnectionInstallationRevisionV1(
		connectionInstallationSupply,
		connectionConsumerSnapshot,
	);
const connectionInstallation = resolveConnectionInstallation(
	configuredConnectionInstallation,
);
const connectionConsumer = connectionConsumerSnapshot
	? JSON.parse(connectionConsumerSnapshot)
	: undefined;

const instanceId = randomUUID();
let prepared: ReturnType<typeof createPrepared> | undefined;
let conversationPrepared:
	| ReturnType<typeof createConversationPrepared>
	| undefined;

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
			policy: {
				...workloadInput.policy,
				connectionConsumerSnapshot,
				connectionInstallationRevision,
			},
			databaseUrl,
			workerId: signing.workerId,
			runtimeProbe: createWorkloadReadinessAuthorizationV1({
				...signing,
				serviceToken,
			}),
		},
		signal,
	);
	let relayKeyDecryptor: ConversationRuntimeOptionsV2["relayKeyDecryptor"];
	if (workloadInput.runtimeModelVersion === 4) {
		if (!relayKeyDecryptionKeys)
			throw new Error("WORKER_EXECUTION_KEY_CONFIGURATION_INVALID");
		try {
			const { createRelayKeyWorkerDecryptorV1 } = await import(
				"@agent-infra/secret-store/worker"
			);
			relayKeyDecryptor = createRelayKeyWorkerDecryptorV1({
				keys: relayKeyDecryptionKeys,
			});
		} catch {
			throw new Error("WORKER_EXECUTION_KEY_CONFIGURATION_INVALID");
		}
	}
	const wecomDeployment = createWecomDeploymentCoordinatorV1({
		databaseUrl: workload.databaseUrl,
		configuration: wecom,
	});
	const resolveRuntimeHost =
		conversationDeployment.createProductionConversationRuntimeResolverV2({
			workload: { ...workload, workerId: signing.workerId },
			signing,
			serviceToken,
			connectionConsumerProfile: connectionConsumer?.profile,
			connectionConsumerApproval: connectionConsumer?.approval,
		});
	let installationStore:
		| import("@agent-infra/platform-store").PostgresConnectionInstallationAuthorizationTransactionV1
		| undefined;
	let authorizedInstallation: ConversationRuntimeOptionsV2["connectionInstallation"];
	if (connectionInstallation) {
		let authorize = connectionInstallation.authorize;
		if (connectionConsumer) {
			const { PostgresConnectionInstallationAuthorizationTransactionV1 } =
				await import("@agent-infra/platform-store");
			try {
				installationStore =
					new PostgresConnectionInstallationAuthorizationTransactionV1({
						databaseUrl: workload.databaseUrl,
						directory,
						configuration: connectionInstallation.configuration,
						profile: connectionConsumer.profile,
						approval: connectionConsumer.approval,
					});
			} catch {
				installationStore = undefined;
			}
			if (!authorize && installationStore) {
				const { createConnectionInstallationAuthorizationV1 } = await import(
					"@agent-infra/platform-core"
				);
				authorize = createConnectionInstallationAuthorizationV1({
					store: installationStore,
				}).authorize;
			}
		}
		authorizedInstallation = {
			configuration: connectionInstallation.configuration,
			authorize: authorize ?? (async () => null),
			...(installationStore ? { commandStore: installationStore } : {}),
		};
	}
	return {
		// Database lease ownership is per process; Runtime service identity is deployment-bound.
		workload: { ...workload, workerId: instanceId },
		conversation: {
			databaseUrl: workload.databaseUrl,
			workerId: instanceId,
			signing,
			directory,
			...(authorizedInstallation
				? { connectionInstallation: authorizedInstallation }
				: {}),
			closeDeployment: async () => {
				await installationStore?.close();
			},
			relayKeyDecryptor,
			channelAuthorizationCurrent: wecomDeployment.channelAuthorizationCurrent,
			sandboxPolicy: {
				namespace: workload.policy.namespace,
				resourceConfigurationHash: workloadResourceConfigurationHashV1(
					workload.policy,
				),
			},
			receiveSandbox:
				conversationDeployment.createProductionSessionSandboxReceiverV1(
					{
						...workload,
						workerId: signing.workerId,
					},
					{ serviceToken },
				),
			resolveRuntimeHost: async (
				request: Parameters<typeof resolveRuntimeHost>[0],
			) => {
				if (
					connectionConsumerSnapshot === null &&
					request.purpose !== "control"
				)
					throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
				if (
					connectionInstallationRevision === null &&
					request.purpose !== "control"
				)
					throw new Error("CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE");
				return resolveRuntimeHost(request);
			},
			fetch: workload.fetch,
		},
		wecom: wecomDeployment,
	};
}

async function createConversationPrepared(signal: AbortSignal) {
	const deployment = await prepare(signal);
	signal.throwIfAborted();
	if (workloadInput.runtimeModelVersion !== 4) return deployment.conversation;
	let accepted:
		| InstanceType<
				typeof import("@agent-infra/platform-store")["PostgresConversationExecutionTransactionV1"]
		  >
		| undefined;
	let ciphertext:
		| InstanceType<
				typeof import("@agent-infra/platform-store")["PostgresRelayKeyVersionStoreV1"]
		  >
		| undefined;
	try {
		const {
			PostgresConversationExecutionTransactionV1,
			PostgresRelayKeyVersionStoreV1,
		} = await import("@agent-infra/platform-store");
		accepted = new PostgresConversationExecutionTransactionV1({
			databaseUrl: deployment.conversation.databaseUrl,
		});
		ciphertext = new PostgresRelayKeyVersionStoreV1({
			databaseUrl: deployment.conversation.databaseUrl,
		});
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
			closeDeployment() {
				closing ??= Promise.allSettled([
					Promise.resolve().then(() =>
						deployment.conversation.closeDeployment(),
					),
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
	conversationPrepared ??= createConversationPrepared(signal);
	return conversationPrepared;
}

export async function createPlatformWecomWorkerInstanceV1(signal: AbortSignal) {
	return (await prepare(signal)).wecom.start(signal);
}
