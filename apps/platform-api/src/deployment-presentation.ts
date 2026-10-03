import { AgentResourceProfileProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { RuntimeCapabilitiesV1Schema } from "@agent-infra/contracts/runtime";
import type { PostgresAgentConfigurationQueryV1 } from "@agent-infra/platform-store";

import type { createDeploymentIdentityScope } from "./deployment-identity.js";
import { HttpProtocolError, requestMetadata } from "./http/common.js";
import type { PresentPlatformAgent } from "./projection.js";

type Presentation = Awaited<ReturnType<PresentPlatformAgent>>;

/** Project only current, authorized Store evidence and the deployed resource policy. */
export function createDeploymentPresentation(input: {
	readonly identityScope: ReturnType<typeof createDeploymentIdentityScope>;
	readonly configurationQuery: Pick<
		PostgresAgentConfigurationQueryV1,
		"readRuntimePresentation"
	>;
	readonly resourceProfile: Presentation["resourceProfile"];
	readonly imageRepository: string;
}): PresentPlatformAgent {
	const resourceProfile = AgentResourceProfileProjectionV1Schema.parse(
		input.resourceProfile,
	);
	return async ({ agentId, configuration, management }) => {
		const { traceId } = requestMetadata(input.identityScope.currentRequest());
		const identity = await input.identityScope.currentIdentity(traceId);
		const runtime = await input.configurationQuery.readRuntimePresentation({
			agentId,
			actorId: identity.userId,
			organizationIds: identity.organizationIds,
			isAdministrator: identity.roles.includes("system_admin"),
			accountStatus: identity.accountStatus,
			expected: { configurationRevision: configuration.revision, management },
		});
		if (runtime.outcome === "stale") {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
		}
		if (runtime.outcome !== "found") {
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		}
		const source = configuration.source;
		let browserSource: Presentation["source"];
		if (source.kind === "standard") {
			browserSource = { kind: "standard", templateId: source.templateId };
		} else if (source.interactionMode === "self-managed") {
			if (!source.identityResponsibility) {
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
			}
			browserSource = {
				kind: "custom",
				imageReference: `${input.imageRepository}@${runtime.sourceReference}`,
				interactionMode: "self-managed",
				identityResponsibility: source.identityResponsibility,
			};
		} else {
			browserSource = {
				kind: "custom",
				imageReference: `${input.imageRepository}@${runtime.sourceReference}`,
				interactionMode: "platform-adapter",
			};
		}
		const verified = runtime.capabilities;
		const capabilities = RuntimeCapabilitiesV1Schema.parse({
			modelSelection: verified?.modelSelection === true,
			attachments: verified?.attachments === true,
			resultFiles: verified?.resultFiles === true,
			connection: verified?.connection === true,
			supplementaryInstruction: verified?.supplementaryInstruction === true,
		});
		return {
			source: browserSource,
			resourceProfile,
			modelOptions: configuration.modelOptions.map((option) => ({
				...option,
				reasoningLevels: [...option.reasoningLevels],
				displayName: option.modelId,
			})),
			channels: [
				{ kind: "web", status: "available" },
				...configuration.channelKinds.map((kind) => ({
					kind,
					// Admission records a requested binding; it does not prove a live channel.
					status: "binding" as const,
				})),
			],
			capabilities,
			interactionUrl: runtime.interactionUrl,
		};
	};
}
