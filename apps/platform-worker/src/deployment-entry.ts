import { randomUUID } from "node:crypto";
import { RuntimeOAuthConfigurationV1Schema } from "@agent-infra/contracts/runtime";
import type {
	AgentDefaultRelayKeyEndpointPolicyV1,
	StandardTemplateModelBindingV1,
} from "@agent-infra/model-catalog";
import { PostgresEvaluationTaskAuthorityV1 } from "@agent-infra/platform-store";
import {
	createRuntimeConnectionConsumerSnapshotV1,
	createRuntimeConnectionInstallationRevisionV1,
} from "./connection-consumer-projection.js";
import * as conversationDeployment from "./conversation-deployment.js";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import {
	createPlatformNativeMetadataGatewayAssemblyV1,
	type PlatformWorkerNativeMetadataGatewayPortsV1,
} from "./native-metadata-deployment-assembly.js";
import {
	createPlatformRuntimeModelDirectoryGatewayV1,
	createPlatformRuntimeModelDirectoryPortsV1,
	createPlatformRuntimeModelDirectoryResolverV1,
	type PlatformWorkerRuntimeModelDirectoryDeploymentPortsV1,
} from "./runtime-model-directory-deployment.js";
import type { PlatformWorkerInternalGatewayServerOptionsV1 } from "./runtime-native-metadata-server.js";
import { runtimeRecoveryBudgetMs } from "./runtime-recovery-budget.js";
import { createProductionSavedKeyCandidatesReaderV1 } from "./saved-key-candidates-production.js";
import { createWorkerSavedKeyCandidatesApp } from "./saved-key-candidates-service.js";
import { isNativeMetadataWorkerOriginV1 } from "./session-workload-adapter.js";
import {
	type DeploymentSkillMaterializerFactoryV1,
	resolveDeploymentSkillMaterializerV1,
} from "./skill-materializer-assembly.js";
import {
	createDeploymentSkillHubMaterializerFactoryV1,
	type DeploymentSkillMaterializationConfigurationV1,
} from "./skill-materializer-production-assembly.js";
import { createWecomDeploymentCoordinatorV1 } from "./wecom-deployment.js";
import {
	createProductionWorkloadWorkerOptionsV1,
	createWorkloadReadinessAuthorizationV1,
} from "./workload-deployment.js";
import {
	createWorkloadReadinessLedgerV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";
import {
	resolveWorkloadFileExchangeEgressV1,
	resolveWorkloadFileExchangeOriginV1,
} from "./workload-runtime-auth.js";

type DeploymentConfiguration = {
	readonly evaluationPolicy?: {
		data: () => Promise<
			import("@agent-infra/platform-core").EvaluationPolicyV1
		>;
		experiment: () => Promise<unknown>;
	};
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
	/** Deployment-owned approved profile per Agent. Missing Agent IDs fail closed. */
	readonly connectionConsumerProfilesByAgent?: Record<
		string,
		{
			readonly profile: unknown;
			readonly approval: unknown;
			readonly oauthClientBinding?: unknown;
		}
	>;
	/**
	 * Deployment adapter hook for the real per-Agent Connection registration
	 * path. The adapter owns the authenticated API call and returns only the
	 * approved non-secret binding; the Worker never receives a service secret
	 * or PAT. A returned entry is atomic: profile, approval and installation
	 * supply must use the same Agent key.
	 */
	readonly resolveConnectionConsumerBindingsByAgent?: (
		signal: AbortSignal,
	) => Promise<
		Readonly<
			Record<
				string,
				{
					readonly profile: unknown;
					readonly approval: unknown;
					readonly installationSupply: unknown;
				}
			>
		>
	>;
	readonly connectionInstallationSupply?: unknown;
	readonly connectionInstallationSuppliesByAgent?: Record<string, unknown>;
	readonly connectionInstallation?: {
		readonly configuration?: NonNullable<
			ConversationRuntimeOptionsV2["connectionInstallation"]
		>["configuration"];
		readonly configurationsByAgent?: NonNullable<
			ConversationRuntimeOptionsV2["connectionInstallation"]
		>["configurationsByAgent"];
		readonly authorize?: NonNullable<
			ConversationRuntimeOptionsV2["connectionInstallation"]
		>["authorize"];
	};
	/** Deployment-owned object-storage/Store assembly for the existing Worker seam. */
	readonly createSkillMaterializer?: DeploymentSkillMaterializerFactoryV1;
	/** Optional production Store/object-storage Skill materialization assembly. */
	readonly skillMaterialization?: DeploymentSkillMaterializationConfigurationV1;
	readonly nativeMetadataGateway?: PlatformWorkerNativeMetadataGatewayPortsV1;
	readonly modelDirectory?: PlatformWorkerRuntimeModelDirectoryDeploymentPortsV1;
	/** Deployment-owned saved-Key candidate reader; it keeps decryptor access in Worker. */
	readonly savedKeyCandidates?: PlatformWorkerInternalGatewayServerOptionsV1;
	readonly savedKeyCandidatesPolicy?: AgentDefaultRelayKeyEndpointPolicyV1 & {
		readonly port?: number;
		readonly hostname?: string;
		readonly catalogRevision: string;
		readonly validation: Parameters<
			typeof import("@agent-infra/model-catalog")["createPersonalRelayKeyValidatorV1"]
		>[0];
		readonly fetch?: typeof fetch;
	};
};

function resolveConnectionInstallation(
	value: unknown,
): DeploymentConfiguration["connectionInstallation"] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
	const candidate = value as Record<string, unknown>;
	if (Object.hasOwn(candidate, "configurationsByAgent")) {
		if (
			Object.keys(candidate).some(
				(key) => !["configurationsByAgent", "authorize"].includes(key),
			) ||
			(candidate.authorize !== undefined &&
				typeof candidate.authorize !== "function") ||
			!candidate.configurationsByAgent ||
			typeof candidate.configurationsByAgent !== "object" ||
			Array.isArray(candidate.configurationsByAgent)
		)
			return undefined;
		const configurationsByAgent: Record<
			string,
			NonNullable<
				DeploymentConfiguration["connectionInstallation"]
			>["configuration"]
		> = {};
		for (const [agentId, configuration] of Object.entries(
			candidate.configurationsByAgent,
		)) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId))
				throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
			const parsed = RuntimeOAuthConfigurationV1Schema.safeParse(configuration);
			if (!parsed.success)
				throw new Error("CONNECTION_INSTALLATION_UNAVAILABLE");
			Object.defineProperty(configurationsByAgent, agentId, {
				value: parsed.data,
				enumerable: true,
			});
		}
		return {
			configurationsByAgent: configurationsByAgent as NonNullable<
				DeploymentConfiguration["connectionInstallation"]
			>["configurationsByAgent"],
			authorize: candidate.authorize as NonNullable<
				DeploymentConfiguration["connectionInstallation"]
			>["authorize"],
		};
	}
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
	evaluationPolicy,
	workloadInput: configuredWorkloadInput,
	signing,
	serviceToken,
	directory,
	relayKeyDecryptionKeys,
	wecom,
	connectionConsumerProfile,
	connectionConsumerApproval,
	connectionConsumerProfilesByAgent,
	resolveConnectionConsumerBindingsByAgent,
	connectionInstallationSupply,
	connectionInstallationSuppliesByAgent,
	connectionInstallation: configuredConnectionInstallation,
	createSkillMaterializer,
	skillMaterialization,
	nativeMetadataGateway: configuredNativeMetadataGateway,
	modelDirectory,
	savedKeyCandidates,
	savedKeyCandidatesPolicy,
} = (await import(
	new URL("./configuration.mjs", import.meta.url).href
)) as DeploymentConfiguration;

function nativeMetadataGatewayPortFromEnvironment() {
	const enabled = process.env.PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ENABLED;
	if (enabled === undefined || enabled === "false") return undefined;
	if (enabled !== "true")
		throw new Error(
			"PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_CONFIGURATION_INVALID",
		);
	const value =
		process.env.PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_PORT ?? "3004";
	const port = Number(value);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
		throw new Error(
			"PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_CONFIGURATION_INVALID",
		);
	return port;
}

const configuredNativeMetadataGatewayPort =
	configuredNativeMetadataGateway?.port;
const environmentNativeMetadataGatewayPort =
	nativeMetadataGatewayPortFromEnvironment();
const nativeMetadataGatewayEnabled =
	configuredNativeMetadataGateway !== undefined ||
	environmentNativeMetadataGatewayPort !== undefined;
const nativeMetadataGatewayPort =
	configuredNativeMetadataGatewayPort ??
	environmentNativeMetadataGatewayPort ??
	(nativeMetadataGatewayEnabled ? 3004 : undefined);
if (nativeMetadataGatewayEnabled && !configuredWorkloadInput.policy.runtimeAuth)
	throw new Error(
		"PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_CONFIGURATION_INVALID",
	);
const configuredNativeMetadataWorkerOrigin =
	process.env.PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ORIGIN;
if (
	configuredNativeMetadataWorkerOrigin !== undefined &&
	!isNativeMetadataWorkerOriginV1(configuredNativeMetadataWorkerOrigin)
)
	throw new Error(
		"PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_CONFIGURATION_INVALID",
	);
const nativeMetadataWorkerOrigin =
	configuredNativeMetadataWorkerOrigin ??
	"http://platform-worker-native-metadata";
const nativeMetadataGatewaySelectorInstance =
	process.env.PLATFORM_WORKER_RELEASE_NAME;
if (
	nativeMetadataGatewayEnabled &&
	(!nativeMetadataGatewaySelectorInstance ||
		!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(
			nativeMetadataGatewaySelectorInstance,
		))
)
	throw new Error(
		"PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_CONFIGURATION_INVALID",
	);
const validatedNativeMetadataGatewaySelectorInstance =
	nativeMetadataGatewaySelectorInstance as string;
const nativeMetadataGateway =
	nativeMetadataGatewayPort === undefined
		? undefined
		: {
				...configuredNativeMetadataGateway,
				port: nativeMetadataGatewayPort,
				...(configuredNativeMetadataGateway?.current ||
				configuredNativeMetadataGateway?.platformApiCurrent ||
				!process.env.PLATFORM_WORKER_NATIVE_METADATA_PLATFORM_API_ORIGIN
					? {}
					: {
							platformApiCurrent: {
								baseUrl:
									process.env
										.PLATFORM_WORKER_NATIVE_METADATA_PLATFORM_API_ORIGIN,
								serviceToken,
							},
						}),
			};
// The mounted deployment module stays authoritative; the environment only
// supplies a release-scoped origin for the fixed deployment and never a token.
const fileExchangeOrigin = resolveWorkloadFileExchangeOriginV1({
	configured: configuredWorkloadInput.policy.runtimeAuth?.fileExchangeOrigin,
	environment: process.env.PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN,
	hasRuntimeAuth: configuredWorkloadInput.policy.runtimeAuth !== undefined,
});
// #3289：文件交换 origin 必须带有部署声明的出站目的地，端口取 origin 端口；缺失或无效时
// 在任何 Kubernetes 写入之前拒绝，避免“变量已注入、网络却不通”。
const fileExchangeEgress = resolveWorkloadFileExchangeEgressV1({
	origin: fileExchangeOrigin,
	configured: configuredWorkloadInput.policy.fileExchangeEgress,
	environment: process.env.PLATFORM_WORKER_FILE_EXCHANGE_EGRESS,
});
const runtimeAuth =
	configuredWorkloadInput.policy.runtimeAuth === undefined
		? undefined
		: {
				...configuredWorkloadInput.policy.runtimeAuth,
				...(nativeMetadataGatewayPort !== undefined &&
				configuredWorkloadInput.policy.runtimeAuth
					.nativeMetadataWorkerOrigin === undefined
					? { nativeMetadataWorkerOrigin }
					: {}),
				...(fileExchangeOrigin !== undefined ? { fileExchangeOrigin } : {}),
			};
const workloadInput = {
	...configuredWorkloadInput,
	policy: {
		...configuredWorkloadInput.policy,
		...(runtimeAuth ? { runtimeAuth } : {}),
		...(fileExchangeEgress ? { fileExchangeEgress } : {}),
		...(nativeMetadataGatewayPort !== undefined &&
		configuredWorkloadInput.policy.nativeMetadataWorkerEgress === undefined
			? {
					nativeMetadataWorkerEgress: [
						{
							destination: {
								namespace: process.env.PLATFORM_WORKER_NAMESPACE ?? "",
								podLabels: {
									"app.kubernetes.io/component": "platform-worker",
									"app.kubernetes.io/instance":
										validatedNativeMetadataGatewaySelectorInstance as string,
								},
							},
							port: nativeMetadataGatewayPort,
						},
					],
				}
			: {}),
	},
};

// Both the Pod file and Runtime HTTP assertion consume this captured source.
const perAgentConsumerSelection =
	connectionConsumerProfilesByAgent !== undefined ||
	resolveConnectionConsumerBindingsByAgent !== undefined;
const connectionConsumerSnapshot = perAgentConsumerSelection
	? undefined
	: createRuntimeConnectionConsumerSnapshotV1(
			connectionConsumerProfile,
			connectionConsumerApproval,
		);
if (Object.hasOwn(workloadInput.policy, "connectionConsumerSnapshot"))
	throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
if (Object.hasOwn(workloadInput.policy, "connectionInstallationRevision"))
	throw new Error("CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE");
if (
	(connectionConsumerProfilesByAgent !== undefined) !==
	(connectionInstallationSuppliesByAgent !== undefined)
)
	throw new Error("CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE");
const connectionInstallationRevision = perAgentConsumerSelection
	? undefined
	: createRuntimeConnectionInstallationRevisionV1(
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
	const resolvedBindings = resolveConnectionConsumerBindingsByAgent
		? await resolveConnectionConsumerBindingsByAgent(signal)
		: undefined;
	if (
		resolvedBindings &&
		(connectionConsumerProfilesByAgent !== undefined ||
			connectionInstallationSuppliesByAgent !== undefined)
	)
		throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	const resolvedProfilesByAgent = resolvedBindings
		? Object.fromEntries(
				Object.entries(resolvedBindings).map(([agentId, binding]) => {
					if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId))
						throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
					return [agentId, binding];
				}),
			)
		: connectionConsumerProfilesByAgent;
	const resolvedInstallationSuppliesByAgent = resolvedBindings
		? Object.fromEntries(
				Object.entries(resolvedBindings).map(([agentId, binding]) => [
					agentId,
					binding.installationSupply,
				]),
			)
		: connectionInstallationSuppliesByAgent;
	if (
		resolvedProfilesByAgent !== undefined &&
		resolvedInstallationSuppliesByAgent === undefined
	)
		throw new Error("CONNECTION_INSTALLATION_SUPPLY_UNAVAILABLE");
	for (const agentId of Object.keys(resolvedProfilesByAgent ?? {}))
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId))
			throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	const resolvedSnapshotsByAgent = resolvedProfilesByAgent
		? Object.fromEntries(
				Object.entries(resolvedProfilesByAgent).map(([agentId, value]) => [
					agentId,
					createRuntimeConnectionConsumerSnapshotV1(
						value.profile,
						value.approval,
						value.oauthClientBinding,
					) ?? null,
				]),
			)
		: undefined;
	const resolvedInstallationRevisionsByAgent = resolvedProfilesByAgent
		? Object.fromEntries(
				Object.entries(resolvedProfilesByAgent).map(([agentId]) => [
					agentId,
					createRuntimeConnectionInstallationRevisionV1(
						resolvedInstallationSuppliesByAgent?.[agentId],
						resolvedSnapshotsByAgent?.[agentId] ?? null,
					) ?? null,
				]),
			)
		: undefined;
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
	const skillMaterializer = await resolveDeploymentSkillMaterializerV1({
		databaseUrl,
		signal,
		configured: workloadInput.skillMaterializer,
		factory:
			createSkillMaterializer ??
			createDeploymentSkillHubMaterializerFactoryV1(skillMaterialization),
	});
	const productionWorkload = await createProductionWorkloadWorkerOptionsV1(
		{
			...workloadInput,
			serviceToken,
			...(skillMaterializer ? { skillMaterializer } : {}),
			policy: {
				...workloadInput.policy,
				connectionConsumerSnapshot,
				...(resolvedSnapshotsByAgent
					? { connectionConsumerSnapshotsByAgent: resolvedSnapshotsByAgent }
					: {}),
				...(resolvedInstallationRevisionsByAgent
					? {
							connectionInstallationRevisionsByAgent:
								resolvedInstallationRevisionsByAgent,
						}
					: {}),
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
	// Workload 监测与会话路由共享同一份签名 readiness 记录，排空据此复用（#1889）。
	const workload = {
		...productionWorkload,
		readinessLedger: createWorkloadReadinessLedgerV1(),
	};
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
			...(resolvedProfilesByAgent
				? { connectionConsumerProfilesByAgent: resolvedProfilesByAgent }
				: {}),
		});
	let installationStore:
		| import("@agent-infra/platform-store").PostgresConnectionInstallationAuthorizationTransactionV1
		| undefined;
	let authorizedInstallation: ConversationRuntimeOptionsV2["connectionInstallation"];
	if (
		connectionInstallation &&
		(connectionInstallation.configurationsByAgent === undefined ||
			resolvedProfilesByAgent !== undefined)
	) {
		let authorize = connectionInstallation.authorize;
		if (
			connectionConsumer ||
			connectionInstallation.configurationsByAgent !== undefined
		) {
			const { PostgresConnectionInstallationAuthorizationTransactionV1 } =
				await import("@agent-infra/platform-store");
			try {
				installationStore =
					new PostgresConnectionInstallationAuthorizationTransactionV1({
						databaseUrl: workload.databaseUrl,
						directory,
						...(connectionInstallation.configurationsByAgent !== undefined
							? {
									bindingsByAgent: Object.fromEntries(
										Object.entries(
											connectionInstallation.configurationsByAgent,
										).map(([agentId, configuration]) => [
											agentId,
											{
												configuration,
												profile: resolvedProfilesByAgent?.[agentId]?.profile,
												approval: resolvedProfilesByAgent?.[agentId]?.approval,
											},
										]),
									),
								}
							: {
									configuration: connectionInstallation.configuration,
									profile: connectionConsumer?.profile,
									approval: connectionConsumer?.approval,
								}),
					});
			} catch {
				installationStore = undefined;
				if (connectionInstallation.configurationsByAgent !== undefined)
					authorize = undefined;
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
			configurationsByAgent: connectionInstallation.configurationsByAgent,
			authorize: authorize ?? (async () => null),
			...(installationStore ? { commandStore: installationStore } : {}),
		};
	}
	const evaluationAuthority = evaluationPolicy
		? new PostgresEvaluationTaskAuthorityV1({
				databaseUrl: workload.databaseUrl,
				loadPolicy: evaluationPolicy,
				directory,
			})
		: undefined;
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
				await evaluationAuthority?.close();
			},
			relayKeyDecryptor,
			evaluationPolicy,
			channelAuthorizationCurrent: (record, signal) =>
				record.boundary.channelId === "eval"
					? (evaluationAuthority?.current(record.boundary) ??
						Promise.resolve(false))
					: wecomDeployment.channelAuthorizationCurrent(record, signal),
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
	const options = await conversationPrepared;
	const recoveryBudgetMs = runtimeRecoveryBudgetMs(
		process.env.PLATFORM_WORKER_RUNTIME_RECOVERY_BUDGET_MS,
	);
	return recoveryBudgetMs === undefined
		? options
		: { ...options, recoveryBudgetMs };
}

export async function createPlatformWecomWorkerInstanceV1(signal: AbortSignal) {
	return (await prepare(signal)).wecom.start(signal);
}

export async function createPlatformNativeMetadataGatewayOptionsV1(
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (!nativeMetadataGateway) return undefined;
	let defaultRuntimeTarget:
		| Parameters<
				typeof createPlatformNativeMetadataGatewayAssemblyV1
		  >[0]["defaultRuntimeTarget"]
		| undefined;
	if (
		!nativeMetadataGateway.transport &&
		!nativeMetadataGateway.runtimeTarget &&
		process.env.PLATFORM_DATABASE_URL
	) {
		const deployment = await prepare(signal);
		defaultRuntimeTarget = {
			workload: deployment.workload,
			resolveConversationRuntimeHost:
				conversationDeployment.createProductionConversationRuntimeResolverV2({
					workload: deployment.workload,
					signing,
					serviceToken,
					connectionConsumerProfile: connectionConsumer?.profile,
					connectionConsumerApproval: connectionConsumer?.approval,
				}),
		};
	}
	return createPlatformNativeMetadataGatewayAssemblyV1({
		serviceToken,
		namespace: process.env.PLATFORM_WORKER_NAMESPACE,
		signing,
		...(defaultRuntimeTarget ? { defaultRuntimeTarget } : {}),
		...(process.env.PLATFORM_DATABASE_URL
			? { databaseUrl: process.env.PLATFORM_DATABASE_URL }
			: {}),
		ports: nativeMetadataGateway,
	});
}

export async function createPlatformRuntimeModelDirectoryOptionsV1(
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (!modelDirectory) return undefined;
	let close: (() => Promise<void>) | undefined;
	try {
		let resolveRuntimeHost = modelDirectory.resolveRuntimeHost;
		if (!resolveRuntimeHost) {
			const databaseUrl = process.env.PLATFORM_DATABASE_URL;
			if (!databaseUrl) throw new Error("PLATFORM_DATABASE_URL is unavailable");
			const { openPostgresWorkloadStateReaderV1 } = await import(
				"@agent-infra/platform-store"
			);
			const stateReader = openPostgresWorkloadStateReaderV1({ databaseUrl });
			close = stateReader.close;
			const prepared = await prepare(signal);
			const conversationResolver =
				conversationDeployment.createProductionConversationRuntimeResolverV2({
					workload: prepared.workload,
					signing,
					serviceToken,
					connectionConsumerProfile: connectionConsumer?.profile,
					connectionConsumerApproval: connectionConsumer?.approval,
				});
			resolveRuntimeHost = createPlatformRuntimeModelDirectoryResolverV1({
				readWorkloadState: stateReader.readCurrentState,
				resolveConversationRuntimeHost: conversationResolver,
			});
		}
		const gateway = createPlatformRuntimeModelDirectoryGatewayV1({
			serviceToken,
			ports: createPlatformRuntimeModelDirectoryPortsV1({
				...modelDirectory,
				resolveRuntimeHost,
				signing,
			}),
		});
		return close ? { ...gateway, close } : gateway;
	} catch (error) {
		await close?.().catch(() => undefined);
		throw error;
	}
}

export async function createPlatformSavedKeyCandidatesOptionsV1(
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (savedKeyCandidates) return savedKeyCandidates;
	if (!savedKeyCandidatesPolicy) return undefined;
	const deployment = await prepare(signal);
	const decryptor = deployment.conversation.relayKeyDecryptor;
	if (!decryptor) throw new Error("WORKER_EXECUTION_KEY_CONFIGURATION_INVALID");
	const reader = createProductionSavedKeyCandidatesReaderV1({
		...savedKeyCandidatesPolicy,
		databaseUrl: deployment.conversation.databaseUrl,
		decryptor,
		modelCatalog: {
			revision: savedKeyCandidatesPolicy.catalogRevision,
			load: (loadSignal) => workloadInput.modelCatalog.load(loadSignal),
		},
		templateBindings: deployment.workload
			.templateModelBindings as readonly StandardTemplateModelBindingV1[],
	});
	return {
		app: createWorkerSavedKeyCandidatesApp({ serviceToken, reader }),
		...(savedKeyCandidatesPolicy.port === undefined
			? {}
			: { port: savedKeyCandidatesPolicy.port }),
		...(savedKeyCandidatesPolicy.hostname === undefined
			? {}
			: { hostname: savedKeyCandidatesPolicy.hostname }),
		close: reader.close,
	};
}
