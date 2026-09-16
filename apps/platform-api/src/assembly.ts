import { randomUUID } from "node:crypto";
import {
	type AgentConfigurationUseCaseDependenciesV1,
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	createApplicationFoundationUseCaseV1,
	createApplicationRevisionUseCaseV1,
	createConversationExecutionUseCaseV1,
	type WecomIdentityPortV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
	PostgresAgentManagementQueryV1,
	PostgresAgentManagementTransactionV1,
	PostgresApplicationFoundationTransactionV1,
	PostgresApplicationRevisionTransactionV1,
	PostgresConversationExecutionTransactionV1,
	PostgresConversationQueryV1,
	PostgresPlatformAuditQueryV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import { createWecomChannelAdmissionV1 } from "@agent-infra/wecom";
import type { PlatformAppDependencies } from "./app.js";
import type { ConfigurationRoutesDependencies } from "./http/configuration-routes.js";
import type { ConversationAuthorization } from "./http/conversation-routes.js";
import {
	type IdentityAdapter,
	resolveCurrentTaskUser,
} from "./http/identity.js";
import type { ManagementRouteDependencies } from "./http/management-routes.js";
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

export interface PlatformApiAssemblyInput {
	readonly requestScope?: PlatformAppDependencies["requestScope"];
	readonly wecom?: WecomApiDeploymentV1;
	readonly wecomCredentialEncryptionKeys?: unknown;
	readonly wecomIdentity?: WecomIdentityPortV1;
	readonly databaseUrl: string;
	readonly conversationReplayWindow?: number;
	readonly conversationReplayWindowMs?: number;
	readonly identity: IdentityAdapter;
	readonly admissions:
		| Admissions
		| ((queries: {
				readonly configurationQuery: PostgresAgentConfigurationQueryV1;
		  }) => Admissions);
	readonly allocateApplicationIds: ManagementRouteDependencies["allocateApplicationIds"];
	readonly prepareApplicationSecrets: ManagementRouteDependencies["prepareSecretReplacements"];
	readonly prepareConfigurationSecrets: ConfigurationRoutesDependencies["prepareSecretReplacements"];
	readonly presentAgent:
		| PresentPlatformAgent
		| {
				create(queries: {
					readonly configurationQuery: PostgresAgentConfigurationQueryV1;
				}): PresentPlatformAgent;
		  };
}

export interface PlatformApiAssembly {
	readonly dependencies: PlatformAppDependencies;
	close(): Promise<void>;
}

export function assemblePlatformApi(
	input: PlatformApiAssemblyInput,
): PlatformApiAssembly {
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
			})
		: undefined;
	const wecom = input.wecom
		? assembleWecomApiV1(input.databaseUrl, input.wecom)
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
	const presentAgent =
		typeof input.presentAgent === "function"
			? input.presentAgent
			: input.presentAgent.create({ configurationQuery });
	const channelAdmission = input.wecom
		? {
				channelAdmission: createWecomChannelAdmissionV1(
					input.wecom.resolveBinding,
				),
			}
		: {};
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
			if (currentUser?.accountStatus !== "active") return { outcome: "denied" };
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
					organizationIds: identity.organizationIds,
					isAdministrator: identity.roles.includes("system_admin"),
					intent: "discover",
				});
				if (configuration.outcome !== "found") return { outcome: "denied" };
				supportsSupplementaryInstruction = (
					await presentAgent({
						agentId,
						traceId: randomUUID(),
						configuration: configuration.configuration,
						management: agent.management,
					})
				).capabilities.supplementaryInstruction;
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
					supportsSupplementaryInstruction,
					taskBoundary,
				},
			};
		},
	};
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
			? { wecomSetup: { identity: input.identity, setup: wecomSetup.setup } }
			: {}),
		...(input.requestScope === undefined
			? {}
			: { requestScope: input.requestScope }),
		...(wecom
			? { wecom: { ...wecom.dependencies, identity: input.identity } }
			: {}),
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
		},
		configuration: {
			identity: input.identity,
			configuration,
			configurationQuery,
			prepareSecretReplacements: input.prepareConfigurationSecrets,
			readAgentProjection: projections.readConfigurationAgentProjection,
		},
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
							return decision.outcome === "unavailable"
								? { outcome: "denied" }
								: decision;
						},
					},
				}),
			query: conversationQuery,
		},
		sessionAudit: { identity: input.identity, audit: auditQuery },
	};
	const adapters = [
		...(wecomReceipts ? [wecomReceipts] : []),
		...(wecomSetup ? [wecomSetup] : []),
		...(wecom ? [wecom] : []),
		foundationTransaction,
		revisionTransaction,
		managementTransaction,
		managementQuery,
		configurationTransaction,
		configurationQuery,
		conversationTransaction,
		conversationQuery,
		auditQuery,
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
