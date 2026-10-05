import { randomUUID } from "node:crypto";
import {
	type AgentConfigurationUseCaseDependenciesV1,
	type ConversationTaskAdmissionPolicyV1,
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	createApplicationApiCredentialIssuerV1,
	createApplicationFoundationUseCaseV1,
	createApplicationMaterialGrantUseCaseV1,
	createApplicationRegistrationUseCaseV1,
	createApplicationRevisionUseCaseV1,
	createConversationExecutionUseCaseV1,
	createPersonalApiAgentReadUseCaseV1,
	createPersonalApiCredentialUseCaseV1,
	createPersonalRelayKeyUseCaseV1,
	createRecentPersonalConversationsUseCaseV1,
	type WecomIdentityPortV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
	PostgresAgentManagementQueryV1,
	PostgresAgentManagementTransactionV1,
	PostgresApplicationApiCredentialIssuerStoreV1,
	PostgresApplicationFoundationTransactionV1,
	PostgresApplicationMaterialGrantStoreV1,
	PostgresApplicationRegistrationStoreV1,
	PostgresApplicationRevisionTransactionV1,
	PostgresConversationExecutionTransactionV1,
	PostgresConversationQueryV1,
	PostgresPersonalApiCredentialStoreV1,
	PostgresPersonalRelayKeyStoreV1,
	PostgresPlatformAuditQueryV1,
	PostgresScopedPlatformAuditQueryV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import {
	createWecomChannelAdmissionV1,
	type WecomCallbackKeysV1,
} from "@agent-infra/wecom";
import type { PlatformAppDependencies } from "./app.js";
import type { ConnectionCapabilityV1 } from "./connection-consumer-profile.js";
import {
	assemblePlatformFilesV1,
	type PlatformFileDeploymentV1,
} from "./file-assembly.js";
import { createApplicationCredentialProcessDeliveryV1 } from "./http/application-api-credential-routes.js";
import type { ConfigurationRoutesDependencies } from "./http/configuration-routes.js";
import type { ConversationAuthorization } from "./http/conversation-routes.js";
import type { DeploymentConfigurationRoutesDependencies } from "./http/deployment-configuration-routes.js";
import type { DirectoryRouteDependencies } from "./http/directory-routes.js";
import {
	type IdentityAdapter,
	resolveCurrentMaterialGrantActor,
	resolveCurrentTaskUser,
} from "./http/identity.js";
import { createTaskRoutesDependenciesV1 } from "./http/task-dependencies.js";
import type { ManagementRouteDependencies } from "./http/v2-management-routes.js";
import {
	createPlatformProjectionReaders,
	type PresentPlatformAgent,
} from "./projection.js";
import {
	assembleWecomApiV1,
	assembleWecomReceiptApiV1,
	type WecomApiDeploymentV1,
} from "./wecom-assembly.js";
import { assembleWecomSetupApiV1 } from "./wecom-setup-assembly.js";

type Admissions = Omit<AgentConfigurationUseCaseDependenciesV1, "transaction">;

interface AssemblyQueries {
	readonly configurationQuery: PostgresAgentConfigurationQueryV1;
}

export interface PlatformApiAssemblyInput {
	readonly applicationCredentialDelivery?: Parameters<
		typeof createApplicationCredentialProcessDeliveryV1
	>[0];
	readonly requestScope?: PlatformAppDependencies["requestScope"];
	readonly files?: PlatformFileDeploymentV1;
	readonly databaseUrl: string;
	readonly taskAdmissionPolicy: ConversationTaskAdmissionPolicyV1;
	readonly conversationReplayWindow?: number;
	readonly conversationReplayWindowMs?: number;
	readonly identity: IdentityAdapter;
	readonly personalRelayKeys?: Pick<
		Parameters<typeof createPersonalRelayKeyUseCaseV1>[0],
		"currentIdentity" | "validate" | "encrypt"
	>;
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
	readonly directory?: DirectoryRouteDependencies;
}

export interface PlatformApiAssembly {
	readonly dependencies: PlatformAppDependencies;
	readResourceSnapshot: PostgresConversationQueryV1["readResourceSnapshot"];
	close(): Promise<void>;
}

export function assemblePlatformApi(
	input: PlatformApiAssemblyInput,
): PlatformApiAssembly {
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
	});
	const revisionTransaction = new PostgresApplicationRevisionTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const managementTransaction = new PostgresAgentManagementTransactionV1({
		databaseUrl: input.databaseUrl,
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
		});
	const conversationQuery = new PostgresConversationQueryV1({
		databaseUrl: input.databaseUrl,
		...(input.conversationReplayWindow === undefined
			? {}
			: { replayWindow: input.conversationReplayWindow }),
		...(input.conversationReplayWindowMs === undefined
			? {}
			: { replayWindowMs: input.conversationReplayWindowMs }),
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
	});
	const revision = createApplicationRevisionUseCaseV1({
		transaction: revisionTransaction,
		...admissions,
		...channelAdmission,
	});
	const management = createAgentManagementV1(managementTransaction);
	const configuration = createAgentConfigurationUseCaseV1({
		transaction: configurationTransaction,
		...admissions,
		...channelAdmission,
	});
	const projections = createPlatformProjectionReaders({
		identity: input.identity,
		managementQuery,
		configurationQuery,
		presentAgent,
	});
	const conversationAuthorization: ConversationAuthorization = {
		async authorize(identity, request) {
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
					{ actorId: identity.userId, channelId: "web" },
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
				channelId: "web",
			});
			if (!taskBoundary) return { outcome: "denied" };
			return {
				outcome: "allowed",
				authority: {
					schemaVersion: 1,
					actorId: identity.userId,
					agentId,
					channelId: "web",
					authorizationRevision: taskBoundary.agentAuthorizationRevision,
					taskBoundary,
					supportsSupplementaryInstruction,
				},
			};
		},
	};
	const files = input.files
		? assemblePlatformFilesV1({
				databaseUrl: input.databaseUrl,
				deployment: input.files,
				identity: input.identity,
				conversationAuthorization,
				async readCurrentLimits(identity, scope, kind) {
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
					const projection = await presentAgent({
						agentId: scope.agentId,
						configuration: configuration.configuration,
						management: agent.management,
					});
					if (
						!(kind === "attachment"
							? projection.capabilities.attachments
							: projection.capabilities.resultFiles)
					)
						return null;
					const revision = configuration.configuration.revision;
					const declared = await input.files?.readLimits({
						agentId: scope.agentId,
						channelId: scope.channelId,
						configurationRevision: revision,
						kind,
					});
					return declared?.configurationRevision === revision
						? declared.declarations
						: null;
				},
			})
		: undefined;
	const dependencies: PlatformAppDependencies = {
		tasks,
		...(personalRelayKeys
			? {
					personalRelayKeys: {
						identity: input.identity,
						keys: personalRelayKeys,
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
					wecomSetup: { identity: input.identity, setup: wecomSetup.setup },
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
			personalApiAgentRead,
			readApiAgentProjection: projections.readApiAgentProjection,
		},
		configuration: {
			identity: input.identity,
			configuration,
			configurationQuery,
			prepareSecretReplacements: input.prepareConfigurationSecrets,
			readAgentProjection: projections.readConfigurationAgentProjection,
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
			recent: createRecentPersonalConversationsUseCaseV1({
				query: conversationQuery,
				resolveCurrentUser: (actorId) =>
					resolveCurrentTaskUser(input.identity, actorId, randomUUID()),
			}),
		},
		sessionAudit: {
			identity: input.identity,
			audit: auditQuery,
			...(input.connectionCapability
				? { connectionCapability: input.connectionCapability }
				: {}),
		},
		scopedAudit: { identity: input.identity, audit: scopedAuditQuery },
		...(input.directory ? { directory: input.directory } : {}),
	};
	const adapters = [
		...(wecomReceipts ? [wecomReceipts] : []),
		...(wecomSetup ? [wecomSetup] : []),
		...(wecom ? [wecom] : []),
		...(files ? [files] : []),
		foundationTransaction,
		revisionTransaction,
		managementTransaction,
		managementQuery,
		configurationTransaction,
		configurationQuery,
		conversationTransaction,
		conversationQuery,
		auditQuery,
		scopedAuditQuery,
		taskAuthorization,
		personalApiCredentialStore,
		applicationRegistrationStore,
		applicationMaterialGrantStore,
		applicationApiCredentialStore,
		...(personalRelayKeyStore ? [personalRelayKeyStore] : []),
	];
	return {
		dependencies,
		readResourceSnapshot: (signal) =>
			conversationQuery.readResourceSnapshot(signal),
		async close() {
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
