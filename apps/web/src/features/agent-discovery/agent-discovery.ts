import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	getAgentDetailV1,
	getAgentV2,
	listAgentsV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	AgentDetailProjectionV1,
	AgentProjectionV2,
	ListAgentsV2Data,
	ListAgentsV2Errors,
	ListAgentsV2Responses,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type CollectionReadUnavailable,
	collectionReadFailure,
} from "../collection-read-failure.js";

type UnavailableState = CollectionReadUnavailable;

export type AgentDiscoveryState =
	| {
			kind: "ready";
			agents: AgentProjectionV2[];
	  }
	| UnavailableState;

export type AgentDetailState =
	| { kind: "ready"; agent: AgentProjectionV2 }
	| UnavailableState;

/** Agent 详情页的读取结果：Owner 带服务端解析的当前有效状态（#2910）。 */
export type AgentDetailViewState =
	| { kind: "ready"; agent: AgentDetailProjectionV1 }
	| UnavailableState;

export function canStartPlatformConversation(
	agent: Pick<
		AgentProjectionV2,
		"managementStatus" | "serviceAvailability" | "source"
	>,
): boolean {
	return (
		agent.managementStatus === "available" &&
		agent.serviceAvailability === "ready" &&
		!(
			agent.source.kind === "custom" &&
			agent.source.interactionMode === "self-managed"
		)
	);
}

const retryableError = (): Error & { readonly retryable: true } =>
	Object.assign(new Error("Agent data is temporarily unavailable"), {
		retryable: true as const,
	});

export function isRetryableAgentDiscoveryError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(!("retryable" in error) || error.retryable === true)
	);
}
const maximumAgentDiscoveryPages = 100;

export type AgentDiscoveryScope = "visible" | "owner";

// Reuse the response schema that generates this endpoint's client contract.
const agentPageSchema =
	pilotBrowserHttpOpenApiPathsV2["/api/v2/agents"].get.responses["200"].content[
		"application/json"
	].schema;

function unavailable(
	error:
		| { retryable?: boolean; reason?: CollectionReadUnavailable["reason"] }
		| undefined,
) {
	if (error?.retryable !== false) throw retryableError();

	return {
		kind: "unavailable" as const,
		retryable: false,
		...(error?.reason ? { reason: error.reason } : {}),
	};
}

export async function loadAgentDiscovery(
	client?: Client,
	scope: AgentDiscoveryScope = "visible",
	signal?: AbortSignal,
): Promise<AgentDiscoveryState> {
	const agents: AgentProjectionV2[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	let pages = 0;

	do {
		signal?.throwIfAborted();
		if (pages >= maximumAgentDiscoveryPages) throw retryableError();
		pages += 1;
		const query: ListAgentsV2Data["query"] = {
			...(cursor === null ? {} : { cursor }),
			...(scope === "owner" ? { scope: "owner" as const } : {}),
		};
		const result: Awaited<
			RequestResult<ListAgentsV2Responses, ListAgentsV2Errors, false>
		> = await listAgentsV2<false>({
			client,
			query,
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		signal?.throwIfAborted();
		const status = result.response?.status;
		if (status !== 200) return unavailable(collectionReadFailure(status));
		if (!result.data || !agentPageSchema.safeParse(result.data).success)
			return unavailable({ retryable: false, reason: "invalid-response" });

		agents.push(...result.data.items);
		cursor = result.data.nextCursor;
		if (cursor !== null && cursors.has(cursor)) throw retryableError();
		if (cursor !== null) cursors.add(cursor);
	} while (cursor !== null);

	return { kind: "ready", agents };
}

export async function loadAgentDetail(
	agentId: string,
	client?: Client,
): Promise<AgentDetailState> {
	const result = await getAgentV2({
		client,
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (result.response?.status !== 200) {
		const failure = collectionReadFailure(result.response?.status);
		// 403 与 404 对页面是同一结果，不暴露不可见 Agent 是否存在（PRD §7.3）。
		return unavailable(
			failure.reason === "denied" || failure.reason === "not-found"
				? { retryable: false }
				: failure,
		);
	}
	const parsed = AgentProjectionV2Schema.safeParse(result.data);
	if (!parsed.success || parsed.data.agentId !== agentId)
		return unavailable({ retryable: false, reason: "invalid-response" });
	return { kind: "ready", agent: parsed.data };
}

/**
 * 详情页读取带 Owner 状态的详情投影（#2910）。失败映射与 loadAgentDetail 相同：
 * 403 与 404 合并，不暴露不可见 Agent 是否存在。
 */
export async function loadAgentDetailView(
	agentId: string,
	client?: Client,
): Promise<AgentDetailViewState> {
	const result = await getAgentDetailV1({
		client,
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (result.response?.status !== 200) {
		const failure = collectionReadFailure(result.response?.status);
		return unavailable(
			failure.reason === "denied" || failure.reason === "not-found"
				? { retryable: false }
				: failure,
		);
	}
	const parsed = AgentDetailProjectionV1Schema.safeParse(result.data);
	if (!parsed.success || parsed.data.agentId !== agentId)
		return unavailable({ retryable: false, reason: "invalid-response" });
	return { kind: "ready", agent: parsed.data };
}

import {
	AgentDetailProjectionV1Schema,
	AgentProjectionV2Schema,
	pilotBrowserHttpOpenApiPathsV2,
} from "@agent-infra/contracts/pilot";
