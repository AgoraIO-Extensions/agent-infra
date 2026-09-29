import { randomUUID } from "node:crypto";
import {
	type AgentConfigurationUseCaseDependenciesV1,
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	createApiIdentityManagementV1,
	createApplicationFoundationUseCaseV1,
	createApplicationRevisionUseCaseV1,
	createConversationExecutionUseCaseV1,
	createConversationTaskAdmissionUseCaseV1,
	createTaskApiAuditV1,
	taskApiChannelIdV1,
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
	PostgresPlatformAuditQueryV1,
	PostgresTaskApiAuditStoreV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
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
import type { TaskRoutesDependencies } from "./http/task-routes.js";
import {
	createPlatformProjectionReaders,
	type PresentPlatformAgent,
} from "./projection.js";

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
	readonly taskAdmissionPolicy?: {
		readonly maximumWaitingTasksPerAgent: number;
		readonly waitingTimeoutMs: number;
	};
	readonly identity: IdentityAdapter;
	readonly apiIdentity?: PostgresApiIdentityStoreV1;
	readonly admissions: Admissions | ((queries: AssemblyQueries) => Admissions);
	readonly deploymentConfiguration?: DeploymentConfigurationRoutesDependencies;
	readonly allocateApplicationIds: ManagementRouteDependencies["allocateApplicationIds"];
	readonly prepareApplicationSecrets: ManagementRouteDependencies["prepareSecretReplacements"];
	readonly prepareConfigurationSecrets: ConfigurationRoutesDependencies["prepareSecretReplacements"];
	readonly presentAgent:
		| PresentPlatformAgent
		| { readonly create: (queries: AssemblyQueries) => PresentPlatformAgent };
}

export interface PlatformApiAssembly {
	readonly dependencies: PlatformAppDependencies;
	close(): Promise<void>;
}

export function assemblePlatformApi(
	input: PlatformApiAssemblyInput,
): PlatformApiAssembly {
	const foundationTransaction = new PostgresApplicationFoundationTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const revisionTransaction = new PostgresApplicationRevisionTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const managementTransaction = new PostgresAgentManagementTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const apiIdentity =
		input.apiIdentity ??
		new PostgresApiIdentityStoreV1({ databaseUrl: input.databaseUrl });
	const identity: IdentityAdapter = withApiIdentityResolverV1(
		input.identity,
		apiIdentity,
	);
	const identityAdapter = identity;
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
	const taskApiAudit = new PostgresTaskApiAuditStoreV1({
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
	const foundation = createApplicationFoundationUseCaseV1({
		transaction: foundationTransaction,
		...admissions,
	});
	const revision = createApplicationRevisionUseCaseV1({
		transaction: revisionTransaction,
		...admissions,
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
	const authorizeTask: TaskRoutesDependencies["authorize"] = async (
		identity,
		request,
	) => {
		const principal = identity.principal;
		const channelId = taskApiChannelIdV1(principal);
		let agentId = request.agentId;
		if (request.conversationId !== undefined) {
			const target = await conversationQuery.getAuthorizationTarget(
				{ actorId: principal.id, channelId },
				request.conversationId,
			);
			if (!target || (agentId !== undefined && target.agentId !== agentId))
				return null;
			agentId = target.agentId;
		}
		if (!agentId) return null;
		const taskBoundary =
			principal.kind === "application"
				? await taskAuthorization.captureApplicationBoundary({
						applicationId: principal.id,
						agentId,
						channelId,
					})
				: await (async () => {
						const user = await resolveCurrentTaskUser(
							identityAdapter,
							principal.id,
							randomUUID(),
						);
						return user
							? taskAuthorization.captureUserBoundary({
									user,
									agentId,
									channelId,
								})
							: null;
					})();
		if (!taskBoundary) return null;
		return {
			schemaVersion: 1,
			actorId: principal.id,
			agentId,
			channelId,
			authorizationRevision: taskBoundary.agentAuthorizationRevision,
			taskBoundary,
			supportsSupplementaryInstruction: false,
		};
	};
	const tasks: TaskRoutesDependencies = {
		identity: identityAdapter,
		audit: createTaskApiAuditV1(taskApiAudit),
		authorize: authorizeTask,
		query: conversationQuery,
		commands(identity) {
			const admission = createConversationTaskAdmissionUseCaseV1(
				{
					transaction: conversationTransaction,
					authorization: {
						async authorize(request) {
							const authority = await authorizeTask(identity, request);
							return authority
								? { outcome: "allowed", authority }
								: { outcome: "denied" };
						},
					},
				},
				input.taskAdmissionPolicy ?? {
					maximumWaitingTasksPerAgent: 100,
					waitingTimeoutMs: 300_000,
				},
			);
			const controls = createConversationExecutionUseCaseV1({
				transaction: conversationTransaction,
				authorization: {
					async authorize(request) {
						const authority = await authorizeTask(identity, {
							schemaVersion: 1,
							operation: "task.cancel",
							conversationId: request.conversationId,
						});
						return authority
							? { outcome: "allowed", authority }
							: { outcome: "denied" };
					},
				},
			});
			return { submitTask: admission.submitTask, stop: controls.stop };
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
		requestScope: input.requestScope,
		...(files ? { files: files.dependencies } : {}),
		management: {
			identity: input.identity,
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
		tasks,
		sessionAudit: {
			identity: input.identity,
			audit: {
				listAudit: (scope, page) => auditQuery.listManagementAudit(scope, page),
			},
		},
	};
	const adapters = [
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
		taskAuthorization,
		taskApiAudit,
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
