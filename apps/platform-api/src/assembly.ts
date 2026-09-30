import { randomUUID } from "node:crypto";
import {
	type AgentConfigurationUseCaseDependenciesV1,
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	createApiIdentityManagementV1,
	createApplicationFoundationUseCaseV1,
	createApplicationRevisionUseCaseV1,
	createConversationExecutionUseCaseV1,
	createPersonalRelayKeyUseCaseV1,
	type WecomIdentityPortV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
	PostgresAgentManagementQueryV1,
	PostgresAgentManagementTransactionV1,
	PostgresApiIdentityStoreV1,
	PostgresApplicationFoundationTransactionV1,
	PostgresApplicationRevisionTransactionV1,
	PostgresConversationExecutionTransactionV1,
	PostgresConversationQueryV1,
	PostgresPersonalRelayKeyStoreV1,
	PostgresPlatformAuditQueryV1,
	PostgresScopedPlatformAuditQueryV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import type { RelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import {
	createWecomChannelAdmissionV1,
	type WecomCallbackKeysV1,
} from "@agent-infra/wecom";
import type { PlatformAppDependencies } from "./app.js";
import { withApiIdentityResolverV1 } from "./deployment-identity.js";
import {
	assemblePlatformFilesV1,
	type PlatformFileDeploymentV1,
} from "./file-assembly.js";
import type { ConfigurationRoutesDependencies } from "./http/configuration-routes.js";
import type { ConversationAuthorization } from "./http/conversation-routes.js";
import type { DeploymentConfigurationRoutesDependencies } from "./http/deployment-configuration-routes.js";
import {
	type IdentityAdapter,
	resolveCurrentTaskUser,
} from "./http/identity.js";
import type { ManagementRouteDependencies } from "./http/management-routes.js";
import type { UserGovernanceRoutesDependencies } from "./http/user-governance-routes.js";
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
	readonly requestScope?: PlatformAppDependencies["requestScope"];
	readonly files?: PlatformFileDeploymentV1;
	readonly databaseUrl: string;
	readonly conversationReplayWindow?: number;
	readonly conversationReplayWindowMs?: number;
	readonly identity: IdentityAdapter;
	readonly apiIdentity?: PostgresApiIdentityStoreV1;
	readonly userGovernance?: UserGovernanceRoutesDependencies["users"];
	readonly personalRelayKeyEncryptor?: RelayKeyEncryptorV1;
	readonly personalRelayKeyValidation?: (
		keyValue: string,
	) => Promise<"valid" | "invalid" | "unavailable">;
	readonly admissions: Admissions | ((queries: AssemblyQueries) => Admissions);
	readonly deploymentConfiguration?: DeploymentConfigurationRoutesDependencies;
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
}

export interface PlatformApiAssembly {
	readonly dependencies: PlatformAppDependencies;
	close(): Promise<void>;
}

export function assemblePlatformApi(
	input: PlatformApiAssemblyInput,
): PlatformApiAssembly {
	const apiIdentity =
		input.apiIdentity ??
		new PostgresApiIdentityStoreV1({
			databaseUrl: input.databaseUrl,
			resolveUser: input.identity.resolveUser
				? async (userId) => (await input.identity.resolveUser?.(userId)) ?? null
				: undefined,
		});
	const identity: IdentityAdapter = withApiIdentityResolverV1(
		input.identity,
		apiIdentity,
	);
	const identityAdapter = identity;
	const personalRelayKeyStore = input.personalRelayKeyEncryptor
		? new PostgresPersonalRelayKeyStoreV1(
				input.databaseUrl,
				async (userId) => {
					const current = await resolveCurrentTaskUser(
						identityAdapter,
						userId,
						randomUUID(),
					);
					return current
						? { userId: current.userId, accountStatus: current.accountStatus }
						: null;
				},
				input.personalRelayKeyEncryptor,
			)
		: undefined;
	const personalRelayKey = personalRelayKeyStore
		? createPersonalRelayKeyUseCaseV1({
				store: personalRelayKeyStore,
				validate:
					input.personalRelayKeyValidation ?? (async () => "unavailable"),
			})
		: undefined;
	if (input.wecomApplicationSetup && !input.wecomCredentialEncryptionKeys)
		throw new Error("WeCom application setup requires encryption keys");
	if (
		input.wecomCredentialEncryptionKeys &&
		!input.wecom &&
		!input.wecomIdentity
	)
		throw new Error("WeCom setup requires a receipt identity deployment");
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
		input.wecom ??
		(input.wecomApplicationSetup && input.wecomIdentity
			? {
					identity: input.wecomIdentity,
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
		resolveUser: identityAdapter.resolveUser,
	});
	const revisionTransaction = new PostgresApplicationRevisionTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const managementTransaction = new PostgresAgentManagementTransactionV1({
		databaseUrl: input.databaseUrl,
		resolveUser: identityAdapter.resolveUser,
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
	const conversationTransaction =
		new PostgresConversationExecutionTransactionV1({
			databaseUrl: input.databaseUrl,
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
	const apiIdentityManagement = createApiIdentityManagementV1({
		store: apiIdentity,
		directory: {
			async resolveUser(userId) {
				const current = await resolveCurrentTaskUser(
					identityAdapter,
					userId,
					randomUUID(),
				);
				return current
					? { userId: current.userId, accountStatus: current.accountStatus }
					: null;
			},
		},
		agentAccess: {
			async canManage({ actor, agentId }) {
				const principal = actor.principal ?? {
					kind: "user" as const,
					id: actor.userId,
				};
				if (actor.isAdministrator)
					return (
						(await managementQuery.getAgent(
							{ kind: "administrator" },
							agentId,
						)) !== undefined
					);
				if (
					actor.principal === undefined &&
					principal.kind === "user" &&
					(await managementQuery.getAgent(
						{ kind: "owner", ownerId: principal.id },
						agentId,
					))
				)
					return true;
				return (
					(await managementQuery.getAgent(
						{ kind: "principal", principal, grantType: "manage" },
						agentId,
					)) !== undefined
				);
			},
		},
		idFactory: randomUUID,
	});
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
				identityAdapter,
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
				identity: identityAdapter,
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
		userGovernance: { identity: input.identity, users: input.userGovernance },
		personalRelayKey: { identity: input.identity, keys: personalRelayKey },
		...(files ? { files: files.dependencies } : {}),
		management: {
			identity: identityAdapter,
			foundation,
			revision,
			management,
			configuration,
			query: managementQuery,
			apiIdentity: apiIdentityManagement,
			allocateApplicationIds: input.allocateApplicationIds,
			prepareSecretReplacements: input.prepareApplicationSecrets,
			readApplicationProjection: projections.readApplicationProjection,
			readAgentProjection: projections.readManagementAgentProjection,
		},
		configuration: {
			identity: input.identity,
			configuration,
			configurationQuery,
			prepareSecretReplacements: input.prepareConfigurationSecrets,
			readAgentProjection: projections.readConfigurationAgentProjection,
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
		},
		sessionAudit: { identity: input.identity, audit: auditQuery },
		scopedAudit: { identity: input.identity, audit: scopedAuditQuery },
	};
	const adapters = [
		...(personalRelayKeyStore ? [personalRelayKeyStore] : []),
		...(wecomReceipts ? [wecomReceipts] : []),
		...(wecomSetup ? [wecomSetup] : []),
		...(wecom ? [wecom] : []),
		...(files ? [files] : []),
		foundationTransaction,
		revisionTransaction,
		managementTransaction,
		apiIdentity,
		managementQuery,
		configurationTransaction,
		configurationQuery,
		conversationTransaction,
		conversationQuery,
		auditQuery,
		scopedAuditQuery,
		taskAuthorization,
	];
	return {
		dependencies,
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
