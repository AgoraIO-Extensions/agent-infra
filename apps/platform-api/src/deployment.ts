import { AgentResourceProfileProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { OciImageReferenceV1Schema } from "@agent-infra/contracts/workload";
import {
	type AgentConfigurationAuthorityContextV1,
	type AgentConfigurationUseCaseDependenciesV1,
	type AgentDefaultRelayKeyBindingV1,
	captureAgentApiCreatePrincipalsV1,
	PersonalRelayKeyErrorV1,
} from "@agent-infra/platform-core";
import { PostgresPlatformUserDisablesV1 } from "@agent-infra/platform-store";
import {
	createRelayKeyEncryptorV1,
	createSecretEncryptorV1,
} from "@agent-infra/secret-store";
import { createAgentDefaultRelayKeyCandidatesV1 } from "./agent-default-relay-key-validation.js";

import type { PlatformApiAssemblyInput } from "./assembly.js";
import { createConnectionCapability } from "./connection-consumer-profile.js";
import {
	createDeploymentAdmissionsV1,
	createDeploymentConfigurationProjectionV2,
	type DeploymentAdmissionInputV1,
} from "./deployment-admissions.js";
import { createDeploymentAuthorizationAdmission } from "./deployment-authorization.js";
import {
	allocateDeploymentApplicationIds,
	createDeploymentIdentityScope,
} from "./deployment-identity.js";
import { createDeploymentPresentation } from "./deployment-presentation.js";
import { createDeploymentSecretPreparation } from "./deployment-secrets.js";
import { HttpProtocolError } from "./http/common.js";
import type { ConversationModelSelectionReaderV1 } from "./http/conversation-routes.js";
import type { DirectoryRouteDependencies } from "./http/directory-routes.js";
import type { IdentityAdapter } from "./http/identity.js";
import { createPersonalRelayKeyValidatorV1 } from "./relay-key-validation.js";
import {
	createRuntimeNativeMetadataWorkerReaderV1,
	type RuntimeNativeMetadataWorkerGatewayV1,
} from "./runtime-native-metadata-reader.js";
import type { SkillHubProviderImportDeploymentV1 } from "./skill-hub-read-assembly.js";

type CustomAgentGatewayRouteInput = NonNullable<
	PlatformApiAssemblyInput["customAgentGateway"]
>;

/** Deployment-owned Gateway inputs; the production IdentityAdapter is bound by this module. */
export type ProductionCustomAgentGatewayInputV1 = Omit<
	CustomAgentGatewayRouteInput,
	"identity" | "authorizeAgent"
>;

const productionRelayKeyPolicyFields = [
	"agentDefaultRelayKeyPolicy",
	"personalRelayKeyValidation",
] as const;

export type ProductionRelayKeyPolicyFieldV1 =
	(typeof productionRelayKeyPolicyFields)[number];

/** Inspect the reviewed Relay Key policy exports without retaining values. */
export function inspectProductionRelayKeyPolicyV1(input: {
	readonly agentDefaultRelayKeyPolicy?: ProductionPlatformApiInputV1["agentDefaultRelayKeyPolicy"];
	readonly personalRelayKeyValidation?: ProductionPlatformApiInputV1["personalRelayKeyValidation"];
}): { readonly missing: readonly ProductionRelayKeyPolicyFieldV1[] } {
	const missing = productionRelayKeyPolicyFields.filter(
		(field) => input[field] === undefined || input[field] === null,
	);
	return { missing };
}

export interface ProductionPlatformApiInputV1
	extends Omit<
		DeploymentAdmissionInputV1,
		"currentIdentity" | "currentApiPrincipal"
	> {
	readonly agentApiCreation?: {
		readonly allowedPrincipals: NonNullable<
			PlatformApiAssemblyInput["agentApiCreation"]
		>["allowedPrincipals"];
		readonly keylessModelAdmission?: AgentConfigurationUseCaseDependenciesV1["keylessModelAdmission"];
		readonly candidates?: NonNullable<
			NonNullable<
				PlatformApiAssemblyInput["agentApiCreation"]
			>["defaultRelayKey"]
		>["candidates"];
	};
	readonly connectionConsumerProfile?: unknown;
	readonly connectionInstallation?: Omit<
		NonNullable<PlatformApiAssemblyInput["connectionInstallation"]>,
		"profile" | "approval"
	>;
	/** Deployment-owned protected callback forwarder; absent keeps OAuth unavailable. */
	readonly connectionInstallationCallback?: PlatformApiAssemblyInput["connectionInstallationCallback"];
	/** Deployment-owned recipient for one-time application credential material. */
	readonly applicationCredentialDelivery?: PlatformApiAssemblyInput["applicationCredentialDelivery"];
	readonly connectionConsumerProfileApproval?: unknown;
	readonly wecom?: PlatformApiAssemblyInput["wecom"];
	readonly wecomIdentity?: PlatformApiAssemblyInput["wecomIdentity"];
	readonly wecomCredentialEncryptionKeys?: PlatformApiAssemblyInput["wecomCredentialEncryptionKeys"];
	readonly wecomApplicationSetup?: PlatformApiAssemblyInput["wecomApplicationSetup"];
	/** Deployment-owned ObjectStorage/file authority adapter for Web and Runtime exchange. */
	readonly files?: PlatformApiAssemblyInput["files"];
	readonly databaseUrl: string;
	readonly taskAdmissionPolicy: PlatformApiAssemblyInput["taskAdmissionPolicy"];
	/** Same immutable image repository used by the Worker's resource policy. */
	readonly imageRepository: string;
	/** An actual deployment identity boundary; no browser-provided identity headers. */
	readonly identity: IdentityAdapter;
	readonly userGovernance?: PostgresPlatformUserDisablesV1;
	readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
	/** Public wrapping keys only. Worker private keys belong to the Worker deployment. */
	readonly encryptionKeys: unknown;
	/** Exact existing template/image/Driver bindings for default Key validation. */
	readonly agentDefaultRelayKeyPolicy?: Pick<
		Parameters<typeof createAgentDefaultRelayKeyCandidatesV1>[0],
		"templateBindings" | "relayEndpointId" | "relayBaseUrl"
	>;
	/** Approved fixed billing profile and deployment-owned CA/TLS transport only. */
	readonly personalRelayKeyValidation?: Parameters<
		typeof createPersonalRelayKeyValidatorV1
	>[0];
	readonly resourceProfile: Parameters<
		typeof createDeploymentPresentation
	>[0]["resourceProfile"];
	readonly conversationReplayWindow?: number;
	readonly conversationReplayWindowMs?: number;
	readonly conversationEventWindow?: number;
	readonly directory?: DirectoryRouteDependencies;
	/** Runtime-owned custom ACP model directory; never derived from ModelCatalog. */
	readonly modelSelection?: ConversationModelSelectionReaderV1;
	/** Optional deployment-owned authenticated native metadata reader. */
	readonly nativeMetadata?: PlatformApiAssemblyInput["nativeMetadata"];
	/** Optional deployment-owned Worker current-confirmation route. */
	readonly nativeMetadataCurrent?: PlatformApiAssemblyInput["nativeMetadataCurrent"];
	readonly nativeCapabilityInvocation?: PlatformApiAssemblyInput["nativeCapabilityInvocation"];
	readonly providerImport?: SkillHubProviderImportDeploymentV1;
	/** Optional deployment-owned platform identity route for custom Agents. */
	readonly customAgentGateway?: ProductionCustomAgentGatewayInputV1;
	readonly resolveCustomAgentInteractionUrl?: Parameters<
		typeof createDeploymentPresentation
	>[0]["resolveCustomAgentInteractionUrl"];
}

/**
 * Compose the production API reader from the Store scope resolver and the
 * fixed Worker gateway. The Worker remains the only proof issuer.
 */
export function createProductionNativeMetadataReaderV1(options: {
	readonly resolveRequest: Parameters<
		typeof createRuntimeNativeMetadataWorkerReaderV1
	>[0]["resolveRequest"];
	readonly gateway: RuntimeNativeMetadataWorkerGatewayV1;
}) {
	return createRuntimeNativeMetadataWorkerReaderV1(options);
}

/** Merge explicit mounted deployment ports without allowing duplicate authorities. */
export function mergeProductionPlatformApiDeploymentPortsV1(input: {
	readonly apiInput: ProductionPlatformApiInputV1;
	readonly customAgentGateway?: ProductionCustomAgentGatewayInputV1;
	readonly modelSelection?: ConversationModelSelectionReaderV1;
	readonly nativeMetadata?: PlatformApiAssemblyInput["nativeMetadata"];
	readonly nativeMetadataCurrent?: PlatformApiAssemblyInput["nativeMetadataCurrent"];
	readonly nativeCapabilityInvocation?: PlatformApiAssemblyInput["nativeCapabilityInvocation"];
	readonly providerImport?: SkillHubProviderImportDeploymentV1;
}): ProductionPlatformApiInputV1 {
	if (
		input.customAgentGateway !== undefined &&
		input.apiInput.customAgentGateway !== undefined
	)
		throw new Error("PLATFORM_CUSTOM_AGENT_GATEWAY_DUPLICATE");
	if (
		input.modelSelection !== undefined &&
		input.apiInput.modelSelection !== undefined
	)
		throw new Error("PLATFORM_MODEL_SELECTION_DUPLICATE");
	if (
		input.nativeMetadata !== undefined &&
		input.apiInput.nativeMetadata !== undefined
	)
		throw new Error("PLATFORM_NATIVE_METADATA_DUPLICATE");
	if (
		input.nativeMetadataCurrent !== undefined &&
		input.apiInput.nativeMetadataCurrent !== undefined
	)
		throw new Error("PLATFORM_NATIVE_METADATA_CURRENT_DUPLICATE");
	if (
		input.nativeCapabilityInvocation !== undefined &&
		input.apiInput.nativeCapabilityInvocation !== undefined
	)
		throw new Error("PLATFORM_NATIVE_CAPABILITY_INVOCATION_DUPLICATE");
	if (
		input.providerImport !== undefined &&
		input.apiInput.providerImport !== undefined
	)
		throw new Error("PLATFORM_PROVIDER_IMPORT_DUPLICATE");
	return {
		...input.apiInput,
		...(input.customAgentGateway !== undefined
			? { customAgentGateway: input.customAgentGateway }
			: {}),
		...(input.modelSelection !== undefined
			? { modelSelection: input.modelSelection }
			: {}),
		...(input.nativeMetadata !== undefined
			? { nativeMetadata: input.nativeMetadata }
			: {}),
		...(input.nativeMetadataCurrent !== undefined
			? { nativeMetadataCurrent: input.nativeMetadataCurrent }
			: {}),
		...(input.nativeCapabilityInvocation !== undefined
			? { nativeCapabilityInvocation: input.nativeCapabilityInvocation }
			: {}),
		...(input.providerImport !== undefined
			? { providerImport: input.providerImport }
			: {}),
	};
}

export function createProductionPlatformApiAssemblyInputV1(
	input: ProductionPlatformApiInputV1,
): PlatformApiAssemblyInput {
	let resourceProfile: ProductionPlatformApiInputV1["resourceProfile"];
	let allowedPrincipals: NonNullable<
		PlatformApiAssemblyInput["agentApiCreation"]
	>["allowedPrincipals"];
	try {
		allowedPrincipals = captureAgentApiCreatePrincipalsV1(
			input.agentApiCreation?.allowedPrincipals,
		);
		if (
			(input.agentApiCreation?.candidates !== undefined &&
				typeof input.agentApiCreation.candidates !== "function") ||
			(input.agentApiCreation?.keylessModelAdmission !== undefined &&
				typeof input.agentApiCreation.keylessModelAdmission.admitModels !==
					"function")
		)
			throw new Error();
		OciImageReferenceV1Schema.parse(
			`${input.imageRepository}@sha256:${"0".repeat(64)}`,
		);
		if (
			!["postgres:", "postgresql:"].includes(
				new URL(input.databaseUrl).protocol,
			) ||
			typeof input.identity?.resolve !== "function" ||
			typeof input.identity?.hydrateUsers !== "function" ||
			typeof input.loadAuthorityContext !== "function"
		)
			throw new Error();
		if (
			!Number.isSafeInteger(
				input.taskAdmissionPolicy?.maximumWaitingTasksPerAgent,
			) ||
			input.taskAdmissionPolicy.maximumWaitingTasksPerAgent < 1 ||
			!Number.isSafeInteger(input.taskAdmissionPolicy?.waitingTimeoutMs) ||
			input.taskAdmissionPolicy.waitingTimeoutMs < 1
		)
			throw new Error();
		resourceProfile = AgentResourceProfileProjectionV1Schema.parse(
			input.resourceProfile,
		);
		if (input.customAgentGateway) {
			if (
				typeof input.customAgentGateway.path !== "string" ||
				!input.customAgentGateway.path.startsWith("/") ||
				!input.customAgentGateway.path.includes("*") ||
				/[?#\s]/.test(input.customAgentGateway.path) ||
				typeof input.customAgentGateway.resolveDeployment !== "function"
			)
				throw new Error();
		}
	} catch {
		throw new Error("PLATFORM_DEPLOYMENT_CONFIGURATION_INVALID");
	}
	const identityScope = createDeploymentIdentityScope(input.identity);
	const apiCandidates = input.agentApiCreation?.candidates;
	const apiModelAdmission = input.agentApiCreation?.keylessModelAdmission;
	const keylessModelAdmission = apiModelAdmission
		? { admitModels: apiModelAdmission.admitModels.bind(apiModelAdmission) }
		: undefined;
	const admissions = createDeploymentAdmissionsV1({
		...input,
		currentIdentity: identityScope.currentIdentity,
	});
	// Capture the same startup policy as browser admission; only the principal varies per request.
	const apiAdmissionInput = {
		imageRepository: input.imageRepository,
		registry: {
			...input.registry,
			policy: {
				authorize: input.registry.policy.authorize.bind(input.registry.policy),
			},
		},
		templates: input.templates.map(({ loadValidation, ...template }) => ({
			...structuredClone(template),
			...(loadValidation ? { loadValidation } : {}),
		})),
		modelCatalog: { ...input.modelCatalog },
		channelPolicy: structuredClone(input.channelPolicy),
	};
	const deploymentConfiguration =
		createDeploymentConfigurationProjectionV2(input);
	const connectionCapability = createConnectionCapability(
		input.connectionConsumerProfile,
		input.connectionConsumerProfileApproval,
	);
	const secrets = createDeploymentSecretPreparation(
		createSecretEncryptorV1({ encryptionKeys: input.encryptionKeys }),
	);
	const validatePersonalRelayKey = input.personalRelayKeyValidation
		? createPersonalRelayKeyValidatorV1(input.personalRelayKeyValidation)
		: undefined;
	const relayKeyEncryptor =
		validatePersonalRelayKey || apiCandidates
			? createRelayKeyEncryptorV1({ encryptionKeys: input.encryptionKeys })
			: undefined;
	const personalRelayKeys: PlatformApiAssemblyInput["personalRelayKeys"] =
		validatePersonalRelayKey && relayKeyEncryptor
			? {
					validate: validatePersonalRelayKey,
					encrypt: (binding, keyValue) =>
						relayKeyEncryptor.encrypt({ ...binding, plaintext: keyValue }),
					async currentIdentity(traceId) {
						try {
							const current = await identityScope.currentIdentity(traceId);
							return {
								userId: current.userId,
								accountStatus: current.accountStatus,
								authorizationRevision: current.authorizationRevision,
							};
						} catch (error) {
							throw new PersonalRelayKeyErrorV1(
								error instanceof HttpProtocolError && error.status === 401
									? "authentication_required"
									: error instanceof HttpProtocolError && error.status === 403
										? "not_authorized"
										: "unavailable",
							);
						}
					},
				}
			: undefined;
	const userGovernance =
		input.userGovernance ??
		new PostgresPlatformUserDisablesV1(input.databaseUrl, async (userId) => {
			if (!input.identity.resolveMaterialGrantActor) throw new Error();
			const actor = await input.identity.resolveMaterialGrantActor(userId);
			return actor
				? {
						userId: actor.userId,
						accountStatus: actor.accountStatus,
						isSystemAdmin: actor.isSystemAdmin,
					}
				: null;
		});
	const loadAuthorityContext = async () => {
		const authority = await input.loadAuthorityContext();
		const users = await Promise.all(
			authority.users.map(async (user) => {
				if (user.accountStatus !== "active") return user;
				return {
					...user,
					accountStatus: (await userGovernance.isPlatformDisabled(user.userId))
						? ("disabled" as const)
						: user.accountStatus,
				};
			}),
		);
		return { ...authority, users };
	};
	return {
		...(input.connectionInstallation
			? {
					connectionInstallation: {
						...input.connectionInstallation,
						profile: input.connectionConsumerProfile,
						approval: input.connectionConsumerProfileApproval,
					},
				}
			: {}),
		...(input.connectionInstallationCallback
			? { connectionInstallationCallback: input.connectionInstallationCallback }
			: {}),
		...(input.applicationCredentialDelivery
			? { applicationCredentialDelivery: input.applicationCredentialDelivery }
			: {}),
		agentApiCreation: {
			allowedPrincipals,
			loadAuthorityContext,
			admissions: ({ principal, authorizationAdmission }) => ({
				...createDeploymentAdmissionsV1({
					...apiAdmissionInput,
					currentApiPrincipal: async () => principal,
				}),
				authorizationAdmission,
				...(keylessModelAdmission ? { keylessModelAdmission } : {}),
			}),
			prepareSecrets: secrets.prepareAgentApiSecrets,
			...(relayKeyEncryptor && apiCandidates
				? {
						defaultRelayKey: {
							candidates: apiCandidates,
							encrypt: (binding, plaintext) =>
								relayKeyEncryptor.encrypt({ ...binding, plaintext }),
						},
					}
				: {}),
		},
		...(personalRelayKeys ? { personalRelayKeys } : {}),
		...(validatePersonalRelayKey
			? { validateDefaultRelayKey: validatePersonalRelayKey }
			: {}),
		...(personalRelayKeys &&
		relayKeyEncryptor &&
		input.personalRelayKeyValidation &&
		input.agentDefaultRelayKeyPolicy
			? {
					agentDefaultRelayKeys: {
						currentIdentity: personalRelayKeys.currentIdentity,
						encrypt: (
							binding: AgentDefaultRelayKeyBindingV1,
							keyValue: string,
						) => relayKeyEncryptor.encrypt({ ...binding, plaintext: keyValue }),
						candidates: createAgentDefaultRelayKeyCandidatesV1({
							modelCatalog: input.modelCatalog,
							...input.agentDefaultRelayKeyPolicy,
							validation: input.personalRelayKeyValidation,
						}),
					},
				}
			: {}),
		...(input.wecom ? { wecom: input.wecom } : {}),
		...(input.wecomIdentity ? { wecomIdentity: input.wecomIdentity } : {}),
		...(input.wecomCredentialEncryptionKeys
			? { wecomCredentialEncryptionKeys: input.wecomCredentialEncryptionKeys }
			: {}),
		...(input.wecomApplicationSetup
			? { wecomApplicationSetup: input.wecomApplicationSetup }
			: {}),
		...(input.files ? { files: input.files } : {}),
		databaseUrl: input.databaseUrl,
		userGovernance,
		taskAdmissionPolicy: input.taskAdmissionPolicy,
		identity: input.identity,
		requestScope: identityScope.requestScope,
		conversationReplayWindow: input.conversationReplayWindow,
		conversationReplayWindowMs: input.conversationReplayWindowMs,
		conversationEventWindow: input.conversationEventWindow,
		...(input.directory ? { directory: input.directory } : {}),
		...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
		...(input.nativeMetadata ? { nativeMetadata: input.nativeMetadata } : {}),
		...(input.nativeMetadataCurrent
			? { nativeMetadataCurrent: input.nativeMetadataCurrent }
			: {}),
		...(input.nativeCapabilityInvocation
			? { nativeCapabilityInvocation: input.nativeCapabilityInvocation }
			: {}),
		...(input.providerImport ? { providerImport: input.providerImport } : {}),
		...(input.customAgentGateway
			? {
					customAgentGateway: input.customAgentGateway,
				}
			: {}),
		connectionCapability,
		allocateApplicationIds: allocateDeploymentApplicationIds,
		prepareApplicationSecrets: secrets.prepareApplicationSecrets,
		prepareConfigurationSecrets: secrets.prepareConfigurationSecrets,
		admissions: ({ configurationQuery }) => ({
			...admissions,
			authorizationAdmission: createDeploymentAuthorizationAdmission({
				identityScope,
				configurationQuery,
				loadAuthorityContext,
			}),
		}),
		deploymentConfiguration: {
			identity: input.identity,
			read: deploymentConfiguration,
		},
		presentAgent: {
			create: ({ configurationQuery }) =>
				createDeploymentPresentation({
					identityScope,
					configurationQuery,
					resourceProfile,
					imageRepository: input.imageRepository,
					modelSelectionAvailable: input.modelSelection !== undefined,
					...(input.resolveCustomAgentInteractionUrl
						? {
								resolveCustomAgentInteractionUrl:
									input.resolveCustomAgentInteractionUrl,
							}
						: {}),
				}),
		},
	};
}
