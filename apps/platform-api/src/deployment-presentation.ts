import {
	AgentProjectionV1Schema,
	AgentResourceProfileProjectionV1Schema,
	MultiServiceManifestDocumentV1Schema,
	type MultiServiceServiceProjectionV1,
	multiServiceServiceProjectionsV1,
} from "@agent-infra/contracts/pilot";
import type { PostgresAgentConfigurationQueryV1 } from "@agent-infra/platform-store";
import { parseAllDocuments } from "yaml";

import type { createDeploymentIdentityScope } from "./deployment-identity.js";
import {
	HttpProtocolError,
	requestMetadata,
	StaleProjectionError,
} from "./http/common.js";
import type { IdentityContext } from "./http/identity.js";
import type { PresentPlatformAgent } from "./projection.js";

type Presentation = Awaited<ReturnType<PresentPlatformAgent>>;

function canonicalHttpsOrigin(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	try {
		const url = new URL(value);
		return (
			value === url.origin &&
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === "" &&
			url.hostname !== ""
		);
	} catch {
		return false;
	}
}

/** Project only current, authorized Store evidence and the deployed resource policy. */
export function createDeploymentPresentation(input: {
	readonly identityScope: ReturnType<typeof createDeploymentIdentityScope>;
	readonly configurationQuery: Pick<
		PostgresAgentConfigurationQueryV1,
		"readRuntimePresentation"
	>;
	readonly resourceProfile: Presentation["resourceProfile"];
	readonly imageRepository: string;
	/** Runtime model capability is public only when the API reader is wired. */
	readonly modelSelectionAvailable?: boolean;
	/** Deployment-owned, readiness-aware resolver for platform-identity Web routes. */
	readonly resolveCustomAgentInteractionUrl?: (input: {
		readonly agentId: string;
		readonly identity: IdentityContext;
		readonly request: Request;
	}) => Promise<string | null>;
}): PresentPlatformAgent {
	const resourceProfile = AgentResourceProfileProjectionV1Schema.parse(
		input.resourceProfile,
	);
	return async ({ agentId, configuration, management, apiUser }) => {
		const { traceId } = requestMetadata(input.identityScope.currentRequest());
		// 只读展示：同一个请求里的所有 Agent 共用一次身份解析（#2632）。
		const identity =
			apiUser === undefined
				? await input.identityScope.requestIdentity(traceId)
				: null;
		const actor = apiUser ?? identity;
		if (!actor) throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		const runtime = await input.configurationQuery.readRuntimePresentation({
			agentId,
			actorId: actor.userId,
			organizationIds: actor.organizationIds,
			isAdministrator: identity?.roles.includes("system_admin") === true,
			accountStatus: actor.accountStatus,
			...(apiUser === undefined ? {} : { intent: "api_metadata" as const }),
			expected: { configurationRevision: configuration.revision, management },
		});
		if (runtime.outcome === "stale") {
			// 读取期间 Agent 状态或配置刚变化：交给读取路由按同一查询重读（#2661）。
			throw new StaleProjectionError(traceId);
		}
		if (runtime.outcome !== "found") {
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		}
		const source = configuration.source;
		let browserSource: Presentation["source"];
		if (source.kind === "standard") {
			browserSource = { kind: "standard", templateId: source.templateId };
		} else if (source.manifest !== undefined) {
			let services: readonly MultiServiceServiceProjectionV1[] | undefined;
			try {
				let documentInput: unknown;
				try {
					documentInput = JSON.parse(source.manifest);
				} catch {
					const documents = parseAllDocuments(source.manifest, {
						prettyErrors: false,
						maxAliasCount: 0,
					} as never);
					if (documents.length !== 1 || documents[0]?.errors.length)
						throw new Error();
					documentInput = documents[0]?.toJSON();
				}
				const document =
					MultiServiceManifestDocumentV1Schema.parse(documentInput);
				// 与准入、Worker 注入使用同一档位解析规则；未声明时为默认档位。
				services = multiServiceServiceProjectionsV1(document);
			} catch {
				services = undefined;
			}
			browserSource = {
				kind: "custom",
				manifest: source.manifest,
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
				...(services ? { services: [...services] } : {}),
			};
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
		const customPlatformAdapter =
			browserSource.kind === "custom" &&
			browserSource.interactionMode === "platform-adapter";
		const capabilities = AgentProjectionV1Schema.shape.capabilities.parse({
			modelSelection:
				verified?.modelSelection === true &&
				(!customPlatformAdapter || input.modelSelectionAvailable === true),
			attachments: verified?.attachments === true,
			resultFiles: verified?.resultFiles === true,
			connection: verified?.connection === true,
			supplementaryInstruction: verified?.supplementaryInstruction === true,
			...(verified?.browser ? { browser: verified.browser } : {}),
			...(verified?.skills ? { skills: verified.skills } : {}),
		});
		let interactionUrl = runtime.interactionUrl;
		if (
			interactionUrl === null &&
			browserSource.kind === "custom" &&
			browserSource.interactionMode === "self-managed" &&
			browserSource.identityResponsibility === "platform-managed" &&
			identity !== null &&
			input.resolveCustomAgentInteractionUrl
		) {
			try {
				const candidate = await input.resolveCustomAgentInteractionUrl({
					agentId,
					identity,
					request: input.identityScope.currentRequest(),
				});
				if (canonicalHttpsOrigin(candidate)) interactionUrl = candidate;
			} catch {
				// A route dependency that cannot prove readiness stays unavailable.
			}
		}
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
			interactionUrl,
		};
	};
}
