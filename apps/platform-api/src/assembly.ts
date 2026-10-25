import { randomUUID } from "node:crypto";
import {
	type AgentConfigurationAuthorityContextV1,
	type AgentConfigurationUseCaseDependenciesV1,
	type AgentManagementActorContextV1,
	type ApiPrincipalV1,
	type ConversationTaskAdmissionPolicyV1,
	createAgentApiCreationV1,
	createAgentApiLifecycleV1,
	createAgentConfigurationUseCaseV1,
	createAgentDefaultRelayKeyUseCaseV1,
	createAgentManagementV1,
	createApplicationApiCredentialIssuerV1,
	createApplicationFoundationUseCaseV1,
	createApplicationMaterialGrantUseCaseV1,
	createApplicationRegistrationUseCaseV1,
	createApplicationRevisionUseCaseV1,
	createConversationExecutionUseCaseV1,
	createNativeCapabilityAdmissionUseCaseV1,
	createPersonalApiAgentReadUseCaseV1,
	createPersonalApiCredentialUseCaseV1,
	createPersonalRelayKeyUseCaseV1,
	createRecentPersonalConversationsUseCaseV1,
	createSkillHubAgentBindingUseCaseV1,
	type FileLimitDeclarationSubjectV1,
	type FileLimitDeclarationsV1,
	type FileScopeV1,
	type NativeCapabilityMetadataRevalidationPortV1,
	readFileLimitDeclarationV1,
	resolveFileLimitsV1,
	type WecomIdentityPortV1,
	writeFileLimitDeclarationV1,
} from "@agent-infra/platform-core";
import {
	ConversationEventWakeHubV1,
	conversationEventWakeChannelV1,
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
	PostgresAgentDefaultRelayKeyStoreV1,
	PostgresAgentManagementQueryV1,
	PostgresAgentManagementTransactionV1,
	PostgresApplicationApiCredentialIssuerStoreV1,
	PostgresApplicationFoundationTransactionV1,
	PostgresApplicationMaterialGrantStoreV1,
	PostgresApplicationRegistrationStoreV1,
	PostgresApplicationRevisionTransactionV1,
	PostgresCommitWakeupListenerV1,
	type PostgresConversationExecutionOptionsV1,
	PostgresConversationExecutionTransactionV1,
	PostgresConversationQueryV1,
	PostgresFileLimitDeclarationStoreV1,
	PostgresPersonalApiCredentialStoreV1,
	PostgresPersonalRelayKeyStoreV1,
	PostgresPlatformAuditQueryV1,
	type PostgresPlatformUserDisablesV1,
	PostgresScopedPlatformAuditQueryV1,
	PostgresSkillHubAgentBindingAdmissionV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import {
	createWecomChannelAdmissionV1,
	type WecomCallbackKeysV1,
} from "@agent-infra/wecom";
import type { PlatformAppDependencies } from "./app.js";
import { createPostgresBrowserCommandAdmissionV1 } from "./browser-command-admission.js";
import type { ConnectionCapabilityV1 } from "./connection-consumer-profile.js";
import {
	assemblePlatformFilesV1,
	type PlatformFileDeploymentV1,
} from "./file-assembly.js";
import type { AgentDefaultRelayKeyRoutesDependencies } from "./http/agent-default-relay-key-routes.js";
import { createApplicationCredentialProcessDeliveryV1 } from "./http/application-api-credential-routes.js";
import type { ConfigurationRoutesDependencies } from "./http/configuration-routes.js";
import type {
	ConversationAuthorization,
	ConversationBrowserCommandPortV1,
	ConversationModelSelectionReaderV1,
} from "./http/conversation-routes.js";
import type { DeploymentConfigurationRoutesDependencies } from "./http/deployment-configuration-routes.js";
import type { DirectoryRouteDependencies } from "./http/directory-routes.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveCurrentMaterialGrantActor,
	resolveCurrentTaskUser,
} from "./http/identity.js";
import type { NativeCapabilityInvocationRouteDependenciesV1 } from "./http/native-capability-invocation-routes.js";
import type { NativeMetadataCurrentRouteDependenciesV1 } from "./http/native-metadata-current-routes.js";
import type { NativeMetadataRoutesDependenciesV1 } from "./http/native-metadata-routes.js";
import type { SkillHubAgentBindingRoutesDependenciesV1 } from "./http/skill-hub-agent-binding-routes.js";
import { createTaskRoutesDependenciesV1 } from "./http/task-dependencies.js";
import type { ManagementRouteDependencies } from "./http/v2-management-routes.js";
import { createNativeCapabilityMetadataRevalidationV1 } from "./native-capability-metadata.js";
import {
	createPlatformProjectionReaders,
	type PresentPlatformAgent,
} from "./projection.js";
import { createWorkerRuntimeModelDirectoryTransportV1 } from "./runtime-model-directory-transport.js";
import { createRuntimeModelSelectionReaderFromStoreV1 } from "./runtime-model-selection-reader.js";
import {
	createRuntimeNativeMetadataCurrentCheckerV1,
	createRuntimeNativeMetadataRequestRegistryV1,
	type RuntimeNativeMetadataRequestRegistryV1,
} from "./runtime-native-metadata-current.js";
import { createRuntimeNativeMetadataWorkerReaderV1 } from "./runtime-native-metadata-reader.js";
import { createRuntimeNativeMetadataScopeResolverV1 } from "./runtime-native-metadata-scope-resolver.js";
import { createPlatformWorkerNativeMetadataGatewayClientV1 } from "./runtime-native-metadata-worker-client.js";
import { createWorkerSavedKeyCandidatesTransportV1 } from "./saved-key-candidates-transport.js";
import {
	assembleSkillHubReadApiV1,
	type SkillHubProviderImportDeploymentV1,
} from "./skill-hub-read-assembly.js";
import {
	assembleWecomApiV1,
	assembleWecomReceiptApiV1,
	type WecomApiDeploymentV1,
} from "./wecom-assembly.js";
import {
	assembleWecomSetupApiV1,
	type WecomBotQrConfigurationV1,
} from "./wecom-setup-assembly.js";

type Admissions = Omit<AgentConfigurationUseCaseDependenciesV1, "transaction">;

interface AssemblyQueries {
	readonly configurationQuery: PostgresAgentConfigurationQueryV1;
}

export interface PlatformApiAssemblyInput {
	readonly connectionInstallation?: {
		readonly publicOrigin: string;
		readonly configuration?: RuntimeOAuthConfigurationV1;
		readonly profile?: unknown;
		readonly approval?: unknown;
		readonly bindingsByAgent?: Readonly<
			Record<
				string,
				import("@agent-infra/platform-store").ConnectionInstallationBindingInputV1
			>
		>;
	};
	readonly connectionInstallationCallback?: {
		readonly forward: import("./http/connection-installation-callback-routes.js").ConnectionInstallationCallbackRouteDependenciesV1["forward"];
	};
	readonly applicationCredentialDelivery?: Parameters<
		typeof createApplicationCredentialProcessDeliveryV1
	>[0];
	readonly agentApiCreation?: {
		readonly allowedPrincipals: readonly ApiPrincipalV1[];
		readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
		readonly admissions?: Parameters<
			typeof createAgentApiCreationV1
		>[0]["admissions"];
		readonly defaultRelayKey?: Parameters<
			typeof createAgentApiCreationV1
		>[0]["defaultRelayKey"];
		readonly prepareSecrets?: Parameters<
			typeof createAgentApiCreationV1
		>[0]["prepareSecrets"];
	};
	readonly requestScope?: PlatformAppDependencies["requestScope"];
	readonly files?: PlatformFileDeploymentV1;
	readonly databaseUrl: string;
	readonly taskAdmissionPolicy: ConversationTaskAdmissionPolicyV1;
	readonly conversationReplayWindow?: number;
	readonly conversationReplayWindowMs?: number;
	readonly conversationEventWindow?: number;
	readonly identity: IdentityAdapter;
	readonly userGovernance?: PostgresPlatformUserDisablesV1;
	readonly personalRelayKeys?: Pick<
		Parameters<typeof createPersonalRelayKeyUseCaseV1>[0],
		"currentIdentity" | "validate" | "encrypt"
	>;
	readonly agentDefaultRelayKeys?: Omit<
		Parameters<typeof createAgentDefaultRelayKeyUseCaseV1>[0],
		"transaction"
	>;
	readonly validateDefaultRelayKey?: (
		keyValue: string,
	) => Promise<"valid" | "invalid" | "unavailable">;
	readonly enforceDefaultRelayKey?: boolean;
	readonly readModelDisplayNames?: AgentDefaultRelayKeyRoutesDependencies["readModelDisplayNames"];
	readonly readRequestedModelDisplayName?: PostgresConversationExecutionOptionsV1["readRequestedModelDisplayName"];
	readonly admissions: Admissions | ((queries: AssemblyQueries) => Admissions);
	readonly deploymentConfiguration?: DeploymentConfigurationRoutesDependencies;
	readonly connectionCapability?: ConnectionCapabilityV1;
	readonly allocateApplicationIds: ManagementRouteDependencies["allocateApplicationIds"];
	readonly prepareApplicationSecrets: ManagementRouteDependencies["prepareSecretReplacements"];
	readonly prepareConfigurationSecrets: ConfigurationRoutesDependencies["prepareSecretReplacements"];
	readonly presentAgent:
		| PresentPlatformAgent
		| { readonly create: (queries: AssemblyQueries) => PresentPlatformAgent };
	readonly wecom?: WecomApiDeploymentV1;
	readonly wecomIdentity?: WecomIdentityPortV1;
	readonly wecomCredentialEncryptionKeys?: unknown;
	readonly wecomApplicationSetup?: {
		readonly publicOrigin: string;
		readonly callbackKeys: WecomCallbackKeysV1;
		readonly replyEncryptionPublicKeyPem: string;
	};
	readonly wecomBotQr?: WecomBotQrConfigurationV1;
	readonly directory?: DirectoryRouteDependencies;
	/** Runtime-owned custom ACP model directory; never derived from ModelCatalog. */
	readonly modelSelection?: ConversationModelSelectionReaderV1;
	/** Deployment-owned API → Worker model-directory service boundary. */
	readonly modelDirectory?: {
		readonly baseUrl: string;
		readonly serviceToken: string;
		readonly fetch?: typeof fetch;
	};
	/** Deployment-owned API → Worker saved-Key candidate read boundary. */
	readonly savedKeyCandidates?: {
		readonly baseUrl: string;
		readonly serviceToken: string;
		readonly fetch?: typeof fetch;
	};
	/** Optional deployment-owned public native metadata reader. */
	readonly nativeMetadata?: Pick<NativeMetadataRoutesDependenciesV1, "reader">;
	/** Fixed API → Worker ingress; the Store scope resolver is assembled here. */
	readonly nativeMetadataWorker?: {
		readonly baseUrl: string;
		readonly serviceToken: string;
		readonly fetch?: typeof fetch;
		readonly transportTimeoutMs?: number;
		readonly requestRegistry?: RuntimeNativeMetadataRequestRegistryV1;
	};
	/** Optional deployment-owned native capability admission route. */
	readonly nativeCapabilityInvocation?: PlatformAppDependencies["nativeCapabilityInvocation"];
	/** Trusted metadata revalidation for the default native capability admission path. */
	readonly nativeCapabilityMetadata?: NativeCapabilityMetadataRevalidationPortV1;
	/** Deployment-owned API → Worker Browser command bridge. */
	readonly browserCommands?: ConversationBrowserCommandPortV1;
	/** Optional deployment-owned Worker current-confirmation route. */
	readonly nativeMetadataCurrent?: NativeMetadataCurrentRouteDependenciesV1;
	/** Optional deployment-owned Provider registry and admission pipeline. */
	readonly providerImport?: SkillHubProviderImportDeploymentV1;
	/** Optional deployment-owned platform identity route for custom Agents. */
	readonly customAgentGateway?: Omit<
		NonNullable<PlatformAppDependencies["customAgentGateway"]>,
		"identity" | "authorizeAgent"
	>;
	/**
	 * 部署级固定 Agent Version（工程 Spec §11.6）。必须与 Worker 的
	 * `skillMaterialization.agentVersion` 取同一值；缺失时 Skill 绑定读写不可用。
	 */
	readonly agentVersion?: string;
}

export interface PlatformApiAssembly {
	readonly dependencies: PlatformAppDependencies;
	readResourceSnapshot: PostgresConversationQueryV1["readResourceSnapshot"];
	close(): Promise<void>;
}

export function assemblePlatformApi(
	input: PlatformApiAssemblyInput,
): PlatformApiAssembly {
	if (
		input.nativeMetadataWorker &&
		input.nativeMetadataCurrent &&
		!input.nativeMetadataWorker.requestRegistry
	)
		throw new Error("PLATFORM_NATIVE_METADATA_REQUEST_REGISTRY_REQUIRED");
	if (input.wecomApplicationSetup && !input.wecomCredentialEncryptionKeys)
		throw new Error("WeCom application setup requires encryption keys");
	if (
		input.wecomCredentialEncryptionKeys &&
		!input.wecom &&
		!input.wecomIdentity
	)
		throw new Error("WeCom setup requires a receipt identity deployment");
	if (
		(input.wecom || input.wecomApplicationSetup) &&
		!input.wecom?.userDirectory &&
		typeof input.identity.resolveUser !== "function"
	)
		throw new Error(
			"WeCom message admission requires a trusted user directory",
		);
	if (
		input.agentApiCreation &&
		typeof input.agentApiCreation.loadAuthorityContext !== "function"
	)
		throw new Error("Agent API creation requires authority context");
	const userDirectory = {
		resolveUser: (userId: string) =>
			resolveCurrentTaskUser(input.identity, userId, randomUUID()),
	};
	const wecomSetup = input.wecomCredentialEncryptionKeys
		? assembleWecomSetupApiV1({
				databaseUrl: input.databaseUrl,
				identity: input.identity,
				encryptionKeys: input.wecomCredentialEncryptionKeys,
				...(input.wecomApplicationSetup
					? { application: input.wecomApplicationSetup }
					: {}),
				...(input.wecomBotQr ? { botQr: input.wecomBotQr } : {}),
			})
		: undefined;
	const wecomDeployment =
		(input.wecom
			? {
					...input.wecom,
					userDirectory: input.wecom.userDirectory ?? userDirectory,
				}
			: undefined) ??
		(input.wecomApplicationSetup && input.wecomIdentity
			? {
					identity: input.wecomIdentity,
					userDirectory,
					replyEncryptionPublicKeyPem:
						input.wecomApplicationSetup.replyEncryptionPublicKeyPem,
					resolveBinding: async () => null,
					observe: () => {},
				}
			: undefined);
	const resolveWecomBinding = wecomDeployment
		? (reference: string) =>
				wecomSetup
					? wecomSetup.resolveBinding(reference, (bindingReference) =>
							wecomDeployment.resolveBinding(bindingReference),
						)
					: wecomDeployment.resolveBinding(reference)
		: undefined;
	const wecom =
		wecomDeployment && resolveWecomBinding
			? assembleWecomApiV1(input.databaseUrl, {
					...wecomDeployment,
					resolveBinding: resolveWecomBinding,
					...(wecomSetup
						? {
								verifyCallback: wecomSetup.verifyCallback,
								acceptMessages: wecomSetup.acceptMessages,
							}
						: {}),
				})
			: undefined;
	const wecomReceipts =
		!wecom && input.wecomIdentity
			? assembleWecomReceiptApiV1(input.databaseUrl, input.wecomIdentity)
			: undefined;
	const foundationTransaction = new PostgresApplicationFoundationTransactionV1({
		databaseUrl: input.databaseUrl,
		userDirectory,
		...(input.agentApiCreation
			? {
					apiCreation: {
						allowedPrincipals: input.agentApiCreation.allowedPrincipals,
						loadAuthorityContext: input.agentApiCreation.loadAuthorityContext,
					},
				}
			: {}),
	});
	const revisionTransaction = new PostgresApplicationRevisionTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const managementTransaction = new PostgresAgentManagementTransactionV1({
		databaseUrl: input.databaseUrl,
		userDirectory,
	});
	const managementQuery = new PostgresAgentManagementQueryV1({
		databaseUrl: input.databaseUrl,
	});
	const configurationTransaction = new PostgresAgentConfigurationTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const configurationQuery = new PostgresAgentConfigurationQueryV1({
		databaseUrl: input.databaseUrl,
	});
	const auditQuery = new PostgresPlatformAuditQueryV1({
		databaseUrl: input.databaseUrl,
	});
	const scopedAuditQuery = new PostgresScopedPlatformAuditQueryV1({
		databaseUrl: input.databaseUrl,
	});
	const taskAuthorization = new PostgresTaskAuthorizationStoreV1({
		databaseUrl: input.databaseUrl,
	});
	const installationStore = (() => {
		if (!input.connectionInstallation) return undefined;
		try {
			return new PostgresConnectionInstallationAuthorizationTransactionV1({
				databaseUrl: input.databaseUrl,
				directory: userDirectory,
				...input.connectionInstallation,
			});
		} catch {
			return undefined;
		}
	})();
	const installationCallbackConfiguration =
		installationStore?.callbackConfiguration;

	const personalApiCredentialStore = new PostgresPersonalApiCredentialStoreV1({
		databaseUrl: input.databaseUrl,
	});
	const applicationRegistrationStore =
		new PostgresApplicationRegistrationStoreV1({
			databaseUrl: input.databaseUrl,
		});
	const applicationApiCredentialStore =
		new PostgresApplicationApiCredentialIssuerStoreV1({
			databaseUrl: input.databaseUrl,
		});
	const applicationApiCredentials = createApplicationApiCredentialIssuerV1({
		store: applicationApiCredentialStore,
		userDirectory: {
			resolveUser: (userId) =>
				resolveCurrentTaskUser(input.identity, userId, randomUUID()),
		},
		delivery: input.applicationCredentialDelivery
			? createApplicationCredentialProcessDeliveryV1(
					input.applicationCredentialDelivery,
				)
			: undefined,
	});
	const applicationMaterialGrantStore =
		new PostgresApplicationMaterialGrantStoreV1({
			databaseUrl: input.databaseUrl,
		});
	const skillHubRead = assembleSkillHubReadApiV1(input);
	const skillHubBindingAdmission = new PostgresSkillHubAgentBindingAdmissionV1({
		databaseUrl: input.databaseUrl,
	});
	const applicationMaterialGrants = createApplicationMaterialGrantUseCaseV1({
		store: applicationMaterialGrantStore,
		resolveCurrentActor: (userId) =>
			resolveCurrentMaterialGrantActor(input.identity, userId, randomUUID()),
		resolveUser: async (userId) => {
			const user = await resolveCurrentTaskUser(
				input.identity,
				userId,
				randomUUID(),
			);
			return user ? { accountStatus: user.accountStatus } : null;
		},
	});
	const personalRelayKeyStore = input.personalRelayKeys
		? new PostgresPersonalRelayKeyStoreV1({ databaseUrl: input.databaseUrl })
		: undefined;
	const personalRelayKeys =
		personalRelayKeyStore && input.personalRelayKeys
			? createPersonalRelayKeyUseCaseV1({
					transaction: personalRelayKeyStore,
					currentIdentity: input.personalRelayKeys.currentIdentity,
					validate: input.personalRelayKeys.validate,
					encrypt: input.personalRelayKeys.encrypt,
				})
			: undefined;
	const agentDefaultRelayKeyStore = input.agentDefaultRelayKeys
		? new PostgresAgentDefaultRelayKeyStoreV1({
				databaseUrl: input.databaseUrl,
			})
		: undefined;
	const agentDefaultRelayKeys =
		agentDefaultRelayKeyStore && input.agentDefaultRelayKeys
			? createAgentDefaultRelayKeyUseCaseV1({
					...input.agentDefaultRelayKeys,
					transaction: agentDefaultRelayKeyStore,
				})
			: undefined;
	const agentDefaultRelayKeyPorts = input.agentDefaultRelayKeys
		? {
				...input.agentDefaultRelayKeys,
				current: (agentId: string) =>
					agentDefaultRelayKeyStore
						? agentDefaultRelayKeyStore.execute((transaction) =>
								transaction.current(agentId),
							)
						: Promise.resolve(null),
			}
		: undefined;
	const personalApiCredentials = createPersonalApiCredentialUseCaseV1({
		transaction: personalApiCredentialStore,
		userDirectory,
	});
	const applications = createApplicationRegistrationUseCaseV1({
		store: applicationRegistrationStore,
		userDirectory,
	});
	const personalApiAgentRead = createPersonalApiAgentReadUseCaseV1({
		transaction: personalApiCredentialStore,
		userDirectory,
	});
	const conversationTransaction =
		new PostgresConversationExecutionTransactionV1({
			databaseUrl: input.databaseUrl,
			userDirectory,
			...(input.readRequestedModelDisplayName
				? { readRequestedModelDisplayName: input.readRequestedModelDisplayName }
				: {}),
		});
	const conversationQuery = new PostgresConversationQueryV1({
		databaseUrl: input.databaseUrl,
		...(input.conversationReplayWindow === undefined
			? {}
			: { replayWindow: input.conversationReplayWindow }),
		...(input.conversationReplayWindowMs === undefined
			? {}
			: { replayWindowMs: input.conversationReplayWindowMs }),
		...(input.conversationEventWindow === undefined
			? { eventWindow: 200 }
			: { eventWindow: input.conversationEventWindow }),
	});
	if (
		input.nativeMetadata !== undefined &&
		input.nativeMetadataWorker !== undefined
	)
		throw new Error("PLATFORM_NATIVE_METADATA_DUPLICATE");
	const nativeMetadataRequestRegistry = input.nativeMetadataWorker
		? (input.nativeMetadataWorker.requestRegistry ??
			createRuntimeNativeMetadataRequestRegistryV1())
		: undefined;
	const assembledNativeMetadata =
		input.nativeMetadata ??
		(input.nativeMetadataWorker
			? {
					reader: createRuntimeNativeMetadataWorkerReaderV1({
						resolveRequest: createRuntimeNativeMetadataScopeResolverV1({
							query: conversationQuery,
							authorize: (identity, request) =>
								conversationAuthorization.authorize(identity, request),
						}),
						gateway: createPlatformWorkerNativeMetadataGatewayClientV1(
							input.nativeMetadataWorker,
						),
						...(nativeMetadataRequestRegistry
							? { requestRegistry: nativeMetadataRequestRegistry }
							: {}),
					}),
				}
			: undefined);
	if (input.modelSelection !== undefined && input.modelDirectory !== undefined)
		throw new Error("PLATFORM_MODEL_SELECTION_DUPLICATE");
	const modelSelection =
		input.modelSelection ??
		(input.modelDirectory
			? createRuntimeModelSelectionReaderFromStoreV1({
					query: conversationQuery,
					transport: createWorkerRuntimeModelDirectoryTransportV1(
						input.modelDirectory,
					),
				})
			: undefined);
	const savedKeyCandidatesTransport = input.savedKeyCandidates
		? createWorkerSavedKeyCandidatesTransportV1(input.savedKeyCandidates)
		: undefined;
	// Commit wakeups shorten SSE waits; streams keep polling without them (#1561).
	const conversationEventWake = new ConversationEventWakeHubV1();
	const conversationWakeups = new PostgresCommitWakeupListenerV1({
		databaseUrl: input.databaseUrl,
		channel: conversationEventWakeChannelV1,
		onWake: (conversationId) => conversationEventWake.notify(conversationId),
	});
	void conversationWakeups.start().catch(() => {
		console.info(
			JSON.stringify({
				service: "platform-api",
				component: "conversation",
				code: "CONVERSATION_COMMIT_WAKEUP_UNAVAILABLE",
			}),
		);
	});
	const tasks = createTaskRoutesDependenciesV1({
		transaction: conversationTransaction,
		query: conversationQuery,
		policy: input.taskAdmissionPolicy,
	});
	const admissions =
		typeof input.admissions === "function"
			? input.admissions({ configurationQuery })
			: input.admissions;
	const skillHubBinding = createSkillHubAgentBindingUseCaseV1({
		transaction: configurationTransaction,
		authorizationAdmission: admissions.authorizationAdmission,
		bindingAdmission: skillHubBindingAdmission,
		bindingStatus: skillHubBindingAdmission,
		// 部署级固定 Agent Version，与 Worker 的 skillMaterialization.agentVersion 同值（工程 Spec §11.6）。
		...(input.agentVersion !== undefined
			? { agentVersion: input.agentVersion }
			: {}),
	});
	const channelAdmission =
		resolveWecomBinding || wecomSetup
			? {
					channelAdmission: createWecomChannelAdmissionV1(
						resolveWecomBinding ?? (async () => null),
						wecomSetup?.resolveManagedBotAdmission,
					),
				}
			: {};
	const presentAgent =
		typeof input.presentAgent === "function"
			? input.presentAgent
			: input.presentAgent.create({ configurationQuery });
	const foundation = createApplicationFoundationUseCaseV1({
		transaction: foundationTransaction,
		...admissions,
		...channelAdmission,
		...(agentDefaultRelayKeyPorts
			? { defaultRelayKey: agentDefaultRelayKeyPorts }
			: {}),
	});
	const agentApiCreation = input.agentApiCreation
		? createAgentApiCreationV1({
				transaction: foundationTransaction,
				admissions: input.agentApiCreation.admissions ?? admissions,
				...(input.agentApiCreation.defaultRelayKey
					? { defaultRelayKey: input.agentApiCreation.defaultRelayKey }
					: {}),
				...(input.agentApiCreation.prepareSecrets
					? { prepareSecrets: input.agentApiCreation.prepareSecrets }
					: {}),
			})
		: undefined;
	// 重新提交 Key 并更换模型集合（V3）与创建共用同一组 Key 端口（#2421）。
	const defaultRelayKeyPorts = agentDefaultRelayKeyPorts
		? { defaultRelayKey: agentDefaultRelayKeyPorts }
		: {};
	const revision = createApplicationRevisionUseCaseV1({
		transaction: revisionTransaction,
		...admissions,
		...channelAdmission,
		...defaultRelayKeyPorts,
	});
	const management = createAgentManagementV1(managementTransaction);
	const customAgentGateway = input.customAgentGateway
		? {
				...input.customAgentGateway,
				identity: input.identity,
				authorizeAgent: async ({
					identity,
					agentId,
				}: {
					readonly identity: import("./http/identity.js").IdentityContext;
					readonly agentId: string;
				}) => {
					const actor: AgentManagementActorContextV1 = {
						schemaVersion: 1,
						userId: identity.userId,
						organizationIds: identity.organizationIds,
						accountStatus: identity.accountStatus,
						isAdministrator: identity.roles.includes("system_admin"),
					};
					try {
						const decision = await management.resolveAgentAccess(
							{ schemaVersion: 1, agentId, intent: "use" },
							actor,
						);
						return decision.outcome === "allowed" && decision.serviceReady;
					} catch {
						return false;
					}
				},
			}
		: undefined;
	const configuration = createAgentConfigurationUseCaseV1({
		transaction: configurationTransaction,
		...admissions,
		...channelAdmission,
		...defaultRelayKeyPorts,
	});
	const projections = createPlatformProjectionReaders({
		identity: input.identity,
		managementQuery,
		configurationQuery,
		presentAgent,
		nativeMetadataAvailable: assembledNativeMetadata !== undefined,
	});
	const conversationAuthorization: ConversationAuthorization = {
		// 浏览器与 API 只走 Web 渠道；执行期文件访问传入该执行已验签、已持久核对的渠道（#3432）。
		async authorize(identity, request, channelId = "web") {
			const currentUser = await resolveCurrentTaskUser(
				input.identity,
				identity.userId,
				randomUUID(),
			);
			if (currentUser === null) return { outcome: "unavailable" };
			if (currentUser.accountStatus !== "active") return { outcome: "revoked" };
			let agentId = request.agentId;
			if (request.conversationId !== undefined) {
				const target = await conversationQuery.getAuthorizationTarget(
					{ actorId: identity.userId, channelId },
					request.conversationId,
				);
				if (!target || (agentId !== undefined && target.agentId !== agentId)) {
					return { outcome: "denied" };
				}
				agentId = target.agentId;
			}
			if (!agentId) return { outcome: "denied" };
			const agent = await managementQuery.getAgent(
				{
					kind: "user",
					userId: identity.userId,
					organizationIds: currentUser.organizationIds,
				},
				agentId,
			);
			if (!agent) return { outcome: "denied" };
			if (
				request.operation === "conversation.create" ||
				request.operation === "message" ||
				request.operation === "regenerate"
			) {
				if (agent.management.status !== "available") {
					return { outcome: "denied" };
				}
				if (agent.management.serviceAvailability !== "ready") {
					return { outcome: "unavailable" };
				}
			}
			let supportsSupplementaryInstruction = false;
			if (request.operation === "message") {
				const configuration = await configurationQuery.read({
					agentId,
					actorId: identity.userId,
					organizationIds: currentUser.organizationIds,
					isAdministrator: identity.roles.includes("system_admin"),
					intent: "discover",
				});
				if (configuration.outcome !== "found") return { outcome: "denied" };
				const runtime = await configurationQuery.readRuntimePresentation({
					agentId,
					actorId: currentUser.userId,
					organizationIds: currentUser.organizationIds,
					accountStatus: currentUser.accountStatus,
					isAdministrator: identity.roles.includes("system_admin"),
					expected: {
						configurationRevision: configuration.configuration.revision,
						management: agent.management,
					},
				});
				if (runtime.outcome !== "found")
					throw new Error("Current Runtime capability is unavailable");
				supportsSupplementaryInstruction =
					runtime.capabilities?.supplementaryInstruction === true;
			}
			const taskBoundary = await taskAuthorization.captureUserBoundary({
				user: currentUser,
				agentId,
				channelId,
			});
			if (!taskBoundary) return { outcome: "denied" };
			return {
				outcome: "allowed",
				authority: {
					schemaVersion: 1,
					actorId: identity.userId,
					agentId,
					channelId,
					authorizationRevision: taskBoundary.agentAuthorizationRevision,
					taskBoundary,
					supportsSupplementaryInstruction,
				},
			};
		},
	};
	const assembledNativeMetadataCurrent =
		input.nativeMetadataCurrent ??
		(nativeMetadataRequestRegistry && input.nativeMetadataWorker
			? {
					serviceToken: input.nativeMetadataWorker.serviceToken,
					...createRuntimeNativeMetadataCurrentCheckerV1({
						registry: nativeMetadataRequestRegistry,
						authorize: (identity, request) =>
							conversationAuthorization.authorize(identity, request),
					}),
				}
			: undefined);
	if (
		input.nativeCapabilityInvocation !== undefined &&
		(input.nativeCapabilityMetadata !== undefined ||
			assembledNativeMetadata !== undefined)
	)
		throw new Error("PLATFORM_NATIVE_CAPABILITY_METADATA_DUPLICATE");
	const nativeCapabilityMetadata = input.nativeCapabilityMetadata;
	const createDefaultNativeCapabilityMetadata = assembledNativeMetadata
		? (
				identity: import("./http/identity.js").IdentityContext,
				requestContext: import("./runtime-native-metadata-request-context.js").RuntimeNativeMetadataRequestContextV1,
			) =>
				createNativeCapabilityMetadataRevalidationV1({
					query: conversationQuery,
					reader: assembledNativeMetadata.reader,
					identity,
					requestContext,
				})
		: undefined;
	const assembledNativeCapabilityInvocation:
		| NativeCapabilityInvocationRouteDependenciesV1
		| undefined =
		input.nativeCapabilityInvocation ??
		(nativeCapabilityMetadata || createDefaultNativeCapabilityMetadata
			? {
					identity: input.identity,
					buildRequest: async ({ conversationId, body }) => ({
						...body,
						schemaVersion: 1 as const,
						conversationId,
					}),
					admitWithIdentity: async ({ identity, request, requestContext }) => {
						const metadata =
							nativeCapabilityMetadata ??
							createDefaultNativeCapabilityMetadata?.(identity, requestContext);
						if (!metadata)
							throw new Error("Native capability metadata unavailable");
						const admission = createNativeCapabilityAdmissionUseCaseV1({
							authorization: {
								async authorize(authorizationRequest) {
									const currentIdentity =
										await requestContext.revalidate(identity);
									const decision = await requestContext.run(() =>
										conversationAuthorization.authorize(
											currentIdentity,
											authorizationRequest,
										),
									);
									if (decision.outcome === "allowed")
										requestContext.confirmPolicy(
											decision.authority,
											request.conversationId,
										);
									await requestContext.revalidate(identity);
									return decision.outcome === "allowed"
										? decision
										: { outcome: "denied" as const };
								},
							},
							metadata,
							transaction: conversationTransaction,
							...(input.files
								? {
										inputLimits: {
											async read({
												actorId,
												agentId,
												channelId,
												conversationId,
											}) {
												if (actorId !== identity.userId) return null;
												const declarations =
													await readCurrentFileLimitDeclarations(
														identity,
														{
															actorId,
															agentId,
															channelId,
															conversationId,
														},
														"attachment",
													);
												return declarations
													? resolveFileLimitsV1(declarations, new Date())
													: null;
											},
										},
									}
								: {}),
						});
						return admission.admit(request);
					},
				}
			: undefined);
	const browserCommandAdmission =
		input.browserCommands ??
		createPostgresBrowserCommandAdmissionV1({
			databaseUrl: input.databaseUrl,
			authorization: conversationAuthorization,
		});
	const browserCommandStore =
		input.browserCommands === undefined
			? (
					browserCommandAdmission as ReturnType<
						typeof createPostgresBrowserCommandAdmissionV1
					>
				).store
			: undefined;
	// File-limit declarations are an independent management surface persisted in
	// the Platform DB; only the data-plane `files` adapter depends on the
	// deployment's file configuration (PR-Agent review, #3063).
	const fileLimitStore = new PostgresFileLimitDeclarationStoreV1(
		input.databaseUrl,
	);
	let readFileLimits:
		| ReturnType<typeof assemblePlatformFilesV1>["readLimits"]
		| undefined;
	async function authorizeFileLimitDeclaration(
		identity: IdentityContext,
		subject: FileLimitDeclarationSubjectV1,
	): Promise<boolean> {
		if (subject.scope === "deployment")
			return identity.roles.includes("system_admin");
		const configuration = await configurationQuery.read({
			agentId: subject.agentId,
			actorId: identity.userId,
			organizationIds: identity.organizationIds,
			isAdministrator: identity.roles.includes("system_admin"),
			intent: "manage",
		});
		return configuration.outcome === "found";
	}
	const fileLimits = fileLimitStore
		? {
				identity: input.identity,
				read: (
					identity: IdentityContext,
					subject: FileLimitDeclarationSubjectV1,
				) =>
					readFileLimitDeclarationV1({
						store: fileLimitStore,
						subject,
						authorize: () => authorizeFileLimitDeclaration(identity, subject),
					}),
				write: (
					identity: IdentityContext,
					subject: FileLimitDeclarationSubjectV1,
					request: {
						readonly declaration: unknown;
						readonly expectedRevision: number | null;
						readonly idempotencyKey: string;
					},
				) =>
					writeFileLimitDeclarationV1({
						store: fileLimitStore,
						subject,
						declaration: request.declaration,
						expectedRevision: request.expectedRevision,
						idempotencyKey: request.idempotencyKey,
						actorId: identity.userId,
						now: new Date(),
						authorize: () => authorizeFileLimitDeclaration(identity, subject),
					}),
			}
		: undefined;
	/**
	 * Current FileLimits for one already-authorized file scope. Invocation V2
	 * admission and the file data plane read the same configuration and
	 * management projections, so an attachment accepted here is checked against
	 * the same declarations the file plane enforces.
	 */
	async function readCurrentFileLimitDeclarations(
		identity: IdentityContext,
		scope: FileScopeV1,
		kind: "attachment" | "result",
	): Promise<FileLimitDeclarationsV1 | null> {
		const configuration = await configurationQuery.read({
			agentId: scope.agentId,
			actorId: identity.userId,
			organizationIds: identity.organizationIds,
			isAdministrator: identity.roles.includes("system_admin"),
			intent: "discover",
		});
		if (configuration.outcome !== "found") return null;
		const agent = await managementQuery.getAgent(
			{
				kind: "user",
				userId: identity.userId,
				organizationIds: identity.organizationIds,
			},
			scope.agentId,
		);
		if (!agent) return null;
		// 已验证的 Runtime 能力直接取自可信 capability reader（工程 Spec §15.4.1），按本次
		// 已授权的主体读取：浏览器请求是当前会话用户，执行期请求是服务端按持久执行解析的
		// actor。不经浏览器展示投影，它会按当前 HTTP 请求重新解析浏览器会话，而 Runtime 的
		// 执行期请求没有浏览器会话，附件读取与结果写入因此总被拒绝（#3307）。
		const runtime = await configurationQuery.readRuntimePresentation({
			agentId: scope.agentId,
			actorId: identity.userId,
			organizationIds: identity.organizationIds,
			accountStatus: identity.accountStatus,
			isAdministrator: identity.roles.includes("system_admin"),
			expected: {
				configurationRevision: configuration.configuration.revision,
				management: agent.management,
			},
		});
		if (runtime.outcome !== "found") return null;
		if (
			(kind === "attachment"
				? runtime.capabilities?.attachments
				: runtime.capabilities?.resultFiles) !== true
		)
			return null;
		if (!readFileLimits) return null;
		const revision = configuration.configuration.revision;
		const declared = await readFileLimits({
			agentId: scope.agentId,
			channelId: scope.channelId,
			configurationRevision: revision,
			kind,
		});
		return declared?.configurationRevision === revision
			? declared.declarations
			: null;
	}
	const files = input.files
		? assemblePlatformFilesV1({
				databaseUrl: input.databaseUrl,
				deployment: input.files,
				identity: input.identity,
				conversationAuthorization,
				limitDeclarations: fileLimitStore,
				// 与会话查询共用同一 Platform DB 读取（#3276）；连接池独立于文件 Store。
				sandboxCredentials: conversationQuery,
				async readCurrentLimits(identity, scope, kind) {
					return readCurrentFileLimitDeclarations(identity, scope, kind);
				},
			})
		: undefined;
	readFileLimits = files?.readLimits;
	const dependencies: PlatformAppDependencies = {
		...(installationStore &&
		installationCallbackConfiguration &&
		input.connectionInstallation
			? {
					connectionInstallations: {
						identity: input.identity,
						publicOrigin: input.connectionInstallation.publicOrigin,
						callbackEnabled: () =>
							input.connectionInstallationCallback !== undefined,
						installation: createConnectionInstallationAuthorizationV1({
							store: installationStore,
						}),
					},
				}
			: {}),
		...(installationStore &&
		installationCallbackConfiguration &&
		input.connectionInstallation &&
		input.connectionInstallationCallback
			? {
					connectionInstallationCallback: {
						publicOrigin: input.connectionInstallation.publicOrigin,
						callbackUrl: installationCallbackConfiguration.callbackUrl,
						issuer: installationCallbackConfiguration.issuer,
						configuration: installationCallbackConfiguration,
						installation: createConnectionInstallationAuthorizationV1({
							store: installationStore,
						}),
						forward: input.connectionInstallationCallback.forward,
					},
				}
			: {}),
		tasks,
		unknownStopOperations: {
			identity: input.identity,
			resolveTimedOutUnknownStop: (request) =>
				taskAuthorization.resolveTimedOutUnknownStop(request),
		},
		...(agentApiCreation
			? {
					agentApiCreation: {
						create: agentApiCreation.create,
						recordRefusal: (request) =>
							managementTransaction.recordApiManagementRefusal(request),
					},
				}
			: {}),
		...(personalRelayKeys
			? {
					personalRelayKeys: {
						identity: input.identity,
						keys: personalRelayKeys,
					},
				}
			: {}),
		...(agentDefaultRelayKeys
			? {
					agentDefaultRelayKeys: {
						identity: input.identity,
						keys: agentDefaultRelayKeys,
						...(input.readModelDisplayNames
							? { readModelDisplayNames: input.readModelDisplayNames }
							: {}),
						...(savedKeyCandidatesTransport
							? { savedCandidates: savedKeyCandidatesTransport }
							: {}),
					},
				}
			: {}),
		...(wecomReceipts
			? {
					wecomReceipts: {
						...wecomReceipts.dependencies,
						identity: input.identity,
					},
				}
			: {}),
		...(wecomSetup
			? {
					wecomSetup: {
						identity: input.identity,
						setup: wecomSetup.setup,
						...(wecomSetup.botQr ? { botQr: wecomSetup.botQr } : {}),
					},
					...(input.wecomApplicationSetup
						? {
								wecomApplicationSetup: {
									identity: input.identity,
									setup: wecomSetup.setup,
									callbackUrl: wecomSetup.callbackUrl,
								},
							}
						: {}),
				}
			: {}),
		...(wecom
			? { wecom: { ...wecom.dependencies, identity: input.identity } }
			: {}),
		requestScope: input.requestScope,
		...(files ? { files: files.dependencies } : {}),
		...(fileLimits ? { fileLimits } : {}),
		agentApplicationGrants: {
			identity: input.identity,
			change: (command, grantType) =>
				managementTransaction.changeApplicationGrant(command, grantType),
			recordRefusal: (request) =>
				managementTransaction.recordApiManagementRefusal(request),
		},
		agentUserUseGrants: {
			identity: input.identity,
			grant: (command) => managementTransaction.grantUserApiUse(command),
			revoke: (command) => managementTransaction.revokeUserApiUse(command),
			recordRefusal: (request) =>
				managementTransaction.recordApiManagementRefusal(request),
		},
		agentUserManageGrants: {
			identity: input.identity,
			grant: (command) => managementTransaction.grantUserApiManage(command),
			revoke: (command) => managementTransaction.revokeUserApiManage(command),
			recordRefusal: (request) =>
				managementTransaction.recordApiManagementRefusal(request),
		},
		agentApiLifecycle: {
			lifecycle: createAgentApiLifecycleV1(managementTransaction),
			readState: (request, material) =>
				managementTransaction.readApiState(request, material),
			recordRefusal: (request) =>
				managementTransaction.recordApiManagementRefusal(request),
		},
		management: {
			identity: input.identity,
			foundation,
			revision,
			management,
			configuration,
			query: managementQuery,
			allocateApplicationIds: input.allocateApplicationIds,
			prepareSecretReplacements: input.prepareApplicationSecrets,
			readApplicationProjection: projections.readApplicationProjection,
			readAgentProjection: projections.readManagementAgentProjection,
			readAgentDetailProjection: projections.readAgentDetailProjection,
			readWorkloadFailureReason: (agentId) =>
				managementQuery.getWorkloadFailureReason(agentId),
			personalApiAgentRead,
			readApiAgentProjection: projections.readApiAgentProjection,
			...(input.validateDefaultRelayKey
				? { validateDefaultRelayKey: input.validateDefaultRelayKey }
				: {}),
			...(input.agentDefaultRelayKeys ? { enforceDefaultRelayKey: true } : {}),
		},
		configuration: {
			identity: input.identity,
			configuration,
			configurationQuery,
			prepareSecretReplacements: input.prepareConfigurationSecrets,
			readAgentProjection: projections.readConfigurationAgentProjection,
			...(savedKeyCandidatesTransport
				? { savedKeyCandidates: savedKeyCandidatesTransport }
				: {}),
		},
		applications: { identity: input.identity, applications },
		applicationApiCredentials: {
			identity: input.identity,
			issuer: applicationApiCredentials,
		},
		applicationMaterialGrants: {
			identity: input.identity,
			grants: applicationMaterialGrants,
		},
		personalApiCredentials: {
			identity: input.identity,
			credentials: personalApiCredentials,
		},
		...(input.deploymentConfiguration === undefined
			? {}
			: { deploymentConfiguration: input.deploymentConfiguration }),
		conversation: {
			identity: input.identity,
			authorization: conversationAuthorization,
			browserCommands: browserCommandAdmission,
			...(modelSelection ? { modelSelection } : {}),
			commands: (identity) =>
				createConversationExecutionUseCaseV1({
					transaction: conversationTransaction,
					authorization: {
						async authorize(request) {
							const decision = await conversationAuthorization.authorize(
								identity,
								request,
							);
							return decision.outcome === "unavailable" ||
								decision.outcome === "revoked"
								? { outcome: "denied" }
								: decision;
						},
					},
				}),
			query: conversationQuery,
			eventWake: conversationEventWake,
			recent: createRecentPersonalConversationsUseCaseV1({
				query: conversationQuery,
				resolveCurrentUser: (actorId) =>
					resolveCurrentTaskUser(input.identity, actorId, randomUUID()),
			}),
		},
		...(assembledNativeMetadata
			? {
					nativeMetadata: {
						identity: input.identity,
						reader: assembledNativeMetadata.reader,
					},
				}
			: {}),
		...(assembledNativeMetadataCurrent
			? { nativeMetadataCurrent: assembledNativeMetadataCurrent }
			: {}),
		...(assembledNativeCapabilityInvocation
			? { nativeCapabilityInvocation: assembledNativeCapabilityInvocation }
			: {}),
		sessionAudit: {
			identity: input.identity,
			audit: auditQuery,
			...(input.connectionCapability
				? { connectionCapability: input.connectionCapability }
				: {}),
		},
		...(customAgentGateway ? { customAgentGateway } : {}),
		scopedAudit: { identity: input.identity, audit: scopedAuditQuery },
		skillHubRead: skillHubRead.dependencies,
		skillHubInstallations: skillHubRead.installationDependencies,
		skillHubInstallationList: skillHubRead.installationListDependencies,
		skillHubPublication: skillHubRead.publicationDependencies,
		skillHubReview: skillHubRead.reviewDependencies,
		skillHubVersionDetail: skillHubRead.versionDetailDependencies,
		skillHubAgentBindings: {
			identity: input.identity,
			bind: async (request) =>
				skillHubBinding.bind(
					{
						schemaVersion: 1,
						agentId: request.agentId,
						agentVersion: request.agentVersion,
						expectedConfigurationRevision:
							request.expectedConfigurationRevision,
						idempotencyKey: request.idempotencyKey,
						requestId: request.requestId,
						traceId: request.traceId,
						bindings: request.bindings as never,
					},
					{
						schemaVersion: 1,
						actorId: request.actorId,
						rawRequestDigest: request.rawRequestDigest,
					},
				),
			read: (request) =>
				skillHubBinding.read({
					schemaVersion: 1,
					agentId: request.agentId,
					agentVersion: request.agentVersion,
					actorId: request.actorId,
					requestId: request.requestId,
					traceId: request.traceId,
				}),
			currentVersion: (request) =>
				skillHubBinding.currentVersion({
					schemaVersion: 1,
					agentId: request.agentId,
					actorId: request.actorId,
					requestId: request.requestId,
					traceId: request.traceId,
				}),
		} satisfies SkillHubAgentBindingRoutesDependenciesV1,
		skillHubProjects: skillHubRead.projectDependencies,
		skillHubProjectContent: skillHubRead.projectContentDependencies,
		...(skillHubRead.importDependencies
			? { skillHubImport: skillHubRead.importDependencies }
			: {}),
		...(input.directory ? { directory: input.directory } : {}),
		...(input.userGovernance
			? {
					userGovernance: {
						identity: input.identity,
						users: input.userGovernance,
					},
				}
			: {}),
	};
	const adapters = [
		...(wecomReceipts ? [wecomReceipts] : []),
		...(wecomSetup ? [wecomSetup] : []),
		...(wecom ? [wecom] : []),
		...(files ? [files] : []),
		...(fileLimitStore ? [fileLimitStore] : []),
		foundationTransaction,
		revisionTransaction,
		managementTransaction,
		managementQuery,
		configurationTransaction,
		configurationQuery,
		conversationTransaction,
		conversationQuery,
		conversationWakeups,
		auditQuery,
		scopedAuditQuery,
		taskAuthorization,
		personalApiCredentialStore,
		applicationRegistrationStore,
		applicationMaterialGrantStore,
		skillHubRead,
		skillHubBindingAdmission,
		applicationApiCredentialStore,
		...(installationStore ? [installationStore] : []),
		...(browserCommandStore ? [browserCommandStore] : []),
		...(personalRelayKeyStore ? [personalRelayKeyStore] : []),
		...(input.userGovernance ? [input.userGovernance] : []),
		...(agentDefaultRelayKeyStore ? [agentDefaultRelayKeyStore] : []),
	];
	return {
		dependencies,
		readResourceSnapshot: (signal) =>
			conversationQuery.readResourceSnapshot(signal),
		async close() {
			nativeMetadataRequestRegistry?.clear();
			let failed = false;
			for (const adapter of adapters.toReversed()) {
				try {
					await adapter.close();
				} catch {
					failed = true;
				}
			}
			if (failed) {
				throw new Error("Platform API dependencies did not close cleanly");
			}
		},
	};
}

import type { RuntimeOAuthConfigurationV1 } from "@agent-infra/contracts/runtime";
import { createConnectionInstallationAuthorizationV1 } from "@agent-infra/platform-core";
import { PostgresConnectionInstallationAuthorizationTransactionV1 } from "@agent-infra/platform-store";
