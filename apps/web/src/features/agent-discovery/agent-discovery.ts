import type { Client } from "../../pilot/generated/client/index.js";
import { getAgent, listAgents } from "../../pilot/generated/sdk.gen.js";
import type { AgentProjectionV1 } from "../../pilot/generated/types.gen.js";

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

function unavailable(error: { retryable?: boolean } | undefined) {
	return {
		kind: "unavailable" as const,
		retryable: error?.retryable ?? true,
	};
}

export async function loadAgentDiscovery(
	client?: Client,
): Promise<AgentDiscoveryState> {
	const result = await listAgents({ client, responseStyle: "fields" });
	if (result.data) {
		return {
			kind: "ready",
			agents: result.data.items,
		};
	}

	return unavailable(result.error);
}

export async function loadAgentDetail(
	agentId: string,
	client?: Client,
): Promise<AgentDetailState> {
	const result = await getAgent({
		client,
		path: { agentId },
		responseStyle: "fields",
	});
	return result.data
		? { kind: "ready", agent: result.data }
		: unavailable(result.error);
}
