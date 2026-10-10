import { AgentResourceProfileProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { OciImageReferenceV1Schema } from "@agent-infra/contracts/workload";
import {
	type AgentConfigurationAuthorityContextV1,
	type AgentConfigurationUseCaseDependenciesV1,
	captureAgentApiCreatePrincipalsV1,
	PersonalRelayKeyErrorV1,
} from "@agent-infra/platform-core";
import {
	createRelayKeyEncryptorV1,
	createSecretEncryptorV1,
} from "@agent-infra/secret-store";

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

type CustomAgentGatewayRouteInput = NonNullable<
	PlatformApiAssemblyInput["customAgentGateway"]
>;

/** Deployment-owned Gateway inputs; the production IdentityAdapter is bound by this module. */
export type ProductionCustomAgentGatewayInputV1 = Omit<
	CustomAgentGatewayRouteInput,
	"identity"
>;

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
	readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
	/** Public wrapping keys only. Worker private keys belong to the Worker deployment. */
	readonly encryptionKeys: unknown;
	/** Approved fixed billing profile and deployment-owned CA/TLS transport only. */
	readonly personalRelayKeyValidation?: Parameters<
		typeof createPersonalRelayKeyValidatorV1
	>[0];
	readonly resourceProfile: Parameters<
		typeof createDeploymentPresentation
	>[0]["resourceProfile"];
	readonly conversationReplayWindow?: number;
	readonly conversationReplayWindowMs?: number;
	readonly directory?: DirectoryRouteDependencies;
	/** Runtime-owned custom ACP model directory; never derived from ModelCatalog. */
	readonly modelSelection?: ConversationModelSelectionReaderV1;
	/** Optional deployment-owned platform identity route for custom Agents. */
	readonly customAgentGateway?: ProductionCustomAgentGatewayInputV1;
	readonly resolveCustomAgentInteractionUrl?: Parameters<
		typeof createDeploymentPresentation
	>[0]["resolveCustomAgentInteractionUrl"];
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
				typeof input.customAgentGateway.resolveDeployment !== "function" ||
				typeof input.customAgentGateway.authorizeAgent !== "function"
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
		templates: structuredClone(input.templates),
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
		agentApiCreation: {
			allowedPrincipals,
			loadAuthorityContext: input.loadAuthorityContext,
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
		taskAdmissionPolicy: input.taskAdmissionPolicy,
		identity: input.identity,
		requestScope: identityScope.requestScope,
		conversationReplayWindow: input.conversationReplayWindow,
		conversationReplayWindowMs: input.conversationReplayWindowMs,
		...(input.directory ? { directory: input.directory } : {}),
		...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
		...(input.customAgentGateway
			? {
					customAgentGateway: {
						...input.customAgentGateway,
						identity: input.identity,
					},
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
				loadAuthorityContext: input.loadAuthorityContext,
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
