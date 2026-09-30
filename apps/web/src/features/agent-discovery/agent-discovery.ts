import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import { getAgentV2, listAgentsV2 } from "../../pilot/generated-v2/sdk.gen.js";
import type {
	AgentProjectionV2,
	ListAgentsV2Data,
	ListAgentsV2Errors,
	ListAgentsV2Responses,
} from "../../pilot/generated-v2/types.gen.js";

type UnavailableState = {
	kind: "unavailable";
	retryable: boolean;
};

export type AgentDiscoveryState =
	| {
			kind: "ready";
			agents: AgentProjectionV2[];
	  }
	| UnavailableState;

export type AgentDetailState =
	| { kind: "ready"; agent: AgentProjectionV2 }
	| UnavailableState;

export function canStartPlatformConversation(
	agent: AgentProjectionV2,
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

function unavailable(error: { retryable?: boolean } | undefined) {
	if (error?.retryable !== false) throw retryableError();

	return {
		kind: "unavailable" as const,
		retryable: false,
	};
}

export async function loadAgentDiscovery(
	client?: Client,
	scope: AgentDiscoveryScope = "visible",
): Promise<AgentDiscoveryState> {
	const agents: AgentProjectionV2[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	let pages = 0;

	do {
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
			responseStyle: "fields",
			throwOnError: false,
		});
		if (!result.data) return unavailable(result.error);

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
	return result.data
		? { kind: "ready", agent: result.data }
		: unavailable(result.error);
}
