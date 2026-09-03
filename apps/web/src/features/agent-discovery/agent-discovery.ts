import type {
	Client,
	RequestResult,
} from "../../pilot/generated/client/index.js";
import { getAgent, listAgents } from "../../pilot/generated/sdk.gen.js";
import type {
	AgentProjectionV1,
	ListAgentsData,
	ListAgentsErrors,
	ListAgentsResponses,
} from "../../pilot/generated/types.gen.js";

type UnavailableState = {
	kind: "unavailable";
	retryable: boolean;
};

export type AgentDiscoveryState =
	| {
			kind: "ready";
			agents: AgentProjectionV1[];
	  }
	| UnavailableState;

export type AgentDetailState =
	| { kind: "ready"; agent: AgentProjectionV1 }
	| UnavailableState;

const retryableError = () => new Error("Agent data is temporarily unavailable");
const maximumAgentDiscoveryPages = 100;

function unavailable(error: { retryable?: boolean } | undefined) {
	if (error?.retryable !== false) throw retryableError();

	return {
		kind: "unavailable" as const,
		retryable: false,
	};
}

export async function loadAgentDiscovery(
	client?: Client,
): Promise<AgentDiscoveryState> {
	const agents: AgentProjectionV1[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	let pages = 0;

	do {
		if (pages >= maximumAgentDiscoveryPages) throw retryableError();
		pages += 1;
		const query: ListAgentsData["query"] =
			cursor === null ? undefined : { cursor };
		const result: Awaited<
			RequestResult<ListAgentsResponses, ListAgentsErrors, false>
		> = await listAgents<false>({
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
	const result = await getAgent({
		client,
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	return result.data
		? { kind: "ready", agent: result.data }
		: unavailable(result.error);
}
