import {
	AgentApplicationProjectionV1Schema,
	AgentProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import type { AgentManagementStateV1 } from "@agent-infra/platform-core";
import type {
	AgentConfigurationProjectionV1,
	AgentManagementAgentProjectionV1,
	AgentManagementApplicationProjectionV1,
	PostgresAgentConfigurationQueryV1,
	PostgresAgentManagementQueryV1,
} from "@agent-infra/platform-store";

import { HttpProtocolError } from "./http/common.js";
import {
	hydrateBrowserUsers,
	type IdentityAdapter,
	type IdentityContext,
} from "./http/identity.js";

type ApplicationProjection = ReturnType<
	typeof AgentApplicationProjectionV1Schema.parse
>;
type AgentProjection = ReturnType<typeof AgentProjectionV1Schema.parse>;

export type PresentPlatformAgent = (input: {
	readonly agentId: string;
	readonly configuration: AgentConfigurationProjectionV1;
	readonly management: AgentManagementStateV1;
}) => Promise<{
	readonly source: AgentProjection["source"];
	readonly resourceProfile: ApplicationProjection["resourceProfile"];
	readonly modelOptions: AgentProjection["configuration"]["modelOptions"];
	readonly channels: AgentProjection["configuration"]["channels"];
	readonly capabilities: AgentProjection["capabilities"];
	readonly interactionUrl: AgentProjection["interactionUrl"];
}>;

interface ProjectionReaderDependencies {
	readonly identity: IdentityAdapter;
	readonly managementQuery: Pick<PostgresAgentManagementQueryV1, "getAgent">;
	readonly configurationQuery: Pick<PostgresAgentConfigurationQueryV1, "read">;
	readonly presentAgent: PresentPlatformAgent;
}

interface ProjectionMetadata {
	readonly identity: IdentityContext;
	readonly requestId: string;
	readonly traceId: string;
}

function sourceMatches(
	configuration: AgentConfigurationProjectionV1,
	source: AgentProjection["source"],
): boolean {
	if (configuration.source.kind !== source.kind) return false;
	if (configuration.source.kind === "standard") {
		return (
			source.kind === "standard" &&
			source.templateId === configuration.source.templateId
		);
	}
	if (source.kind !== "custom") return false;
	return (
		source.interactionMode === configuration.source.interactionMode &&
		(source.interactionMode !== "self-managed" ||
			source.identityResponsibility ===
				configuration.source.identityResponsibility)
	);
}

export function createPlatformProjectionReaders(
	dependencies: ProjectionReaderDependencies,
) {
	async function configurationProjection(
		agentId: string,
		management: AgentManagementStateV1,
		metadata: ProjectionMetadata,
	) {
		const result = await dependencies.configurationQuery.read({
			agentId,
			actorId: metadata.identity.userId,
			organizationIds: metadata.identity.organizationIds,
			isAdministrator: metadata.identity.roles.includes("system_admin"),
			intent: "discover",
		});
		if (result.outcome !== "found") {
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
		}
		const configuration = result.configuration;
		const [owners, presentation] = await Promise.all([
			hydrateBrowserUsers(
				dependencies.identity,
				configuration.ownerIds,
				metadata.traceId,
			),
			dependencies.presentAgent({ agentId, configuration, management }),
		]);
		if (!sourceMatches(configuration, presentation.source)) {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
		return {
			configuration,
			presentation,
			wire: {
				owners,
				availability: configuration.availability,
				modelOptions: presentation.modelOptions,
				defaultModelOptionId: configuration.defaultModelOptionId,
				defaultReasoningLevel: configuration.defaultReasoningLevel,
				actions: configuration.actions,
				environment: configuration.environment,
				channels: presentation.channels,
				secrets: configuration.secrets,
			},
		};
	}

	async function projectAgent(
		agent: AgentManagementAgentProjectionV1,
		metadata: ProjectionMetadata,
	): Promise<AgentProjection> {
		const { presentation, wire } = await configurationProjection(
			agent.agentId,
			agent.management,
			metadata,
		);
		return AgentProjectionV1Schema.parse({
			schemaVersion: 1,
			agentId: agent.agentId,
			name: agent.name,
			description: agent.description,
			source: presentation.source,
			managementStatus: agent.management.status,
			serviceAvailability: agent.management.serviceAvailability,
			configuration: wire,
			capabilities: presentation.capabilities,
			interactionUrl: presentation.interactionUrl,
		});
	}

	return {
		async readApplicationProjection(
			input: ProjectionMetadata & {
				readonly application?: AgentManagementApplicationProjectionV1;
			},
		): Promise<ApplicationProjection> {
			if (!input.application) {
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", input.traceId);
			}
			const { presentation, wire } = await configurationProjection(
				input.application.agentId,
				input.application.management,
				input,
			);
			return AgentApplicationProjectionV1Schema.parse({
				schemaVersion: 1,
				applicationId: input.application.applicationId,
				agentId: input.application.agentId,
				name: input.application.name,
				description: input.application.description,
				source: presentation.source,
				status: input.application.management.status,
				resourceProfile: presentation.resourceProfile,
				configuration: wire,
				submittedAt: input.application.submittedAt.toISOString(),
				decision: input.application.decision
					? {
							decidedAt: input.application.decision.decidedAt.toISOString(),
							reason: input.application.decision.reason,
						}
					: null,
			});
		},

		async readManagementAgentProjection(
			input: ProjectionMetadata & {
				readonly agent?: AgentManagementAgentProjectionV1;
			},
		): Promise<AgentProjection> {
			if (!input.agent) {
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", input.traceId);
			}
			return projectAgent(input.agent, input);
		},

		async readConfigurationAgentProjection(
			input: ProjectionMetadata & { readonly agentId: string },
		): Promise<AgentProjection | null> {
			const scope = input.identity.roles.includes("system_admin")
				? ({ kind: "administrator" } as const)
				: ({ kind: "owner", ownerId: input.identity.userId } as const);
			const agent = await dependencies.managementQuery.getAgent(
				scope,
				input.agentId,
			);
			return agent ? projectAgent(agent, input) : null;
		},
	};
}
