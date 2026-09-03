import { OpaqueCursorV1Schema } from "@agent-infra/contracts";
import {
	AgentProjectionV1Schema,
	PilotProtocolErrorV1Schema,
	pilotBrowserHttpOpenApiPathsV1,
} from "@agent-infra/contracts/pilot";

export type PilotAgentMockResponseV1 = {
	readonly status: number;
	readonly body: unknown;
};

type PilotAgentMockResponderV1<TArgs extends readonly unknown[]> =
	| PilotAgentMockResponseV1
	| ((...args: TArgs) => PilotAgentMockResponseV1);

export type PilotAgentMockServerScenarioV1 = {
	readonly listAgents: PilotAgentMockResponderV1<[Request]>;
	readonly getAgent: PilotAgentMockResponderV1<[Request, string]>;
};

export type PilotAgentMockServerV1 = {
	readonly fetch: typeof fetch;
	readonly requests: readonly Request[];
};

const agentListResponseSchema =
	pilotBrowserHttpOpenApiPathsV1["/api/v1/agents"].get.responses["200"].content[
		"application/json"
	].schema;

function validateListResponse(response: PilotAgentMockResponseV1) {
	if (response.status !== 200) {
		PilotProtocolErrorV1Schema.parse(response.body);
		return;
	}

	const page = agentListResponseSchema.parse(response.body) as {
		items: unknown[];
		nextCursor: unknown;
	};
	for (const agent of page.items) AgentProjectionV1Schema.parse(agent);
	if (page.nextCursor !== null) OpaqueCursorV1Schema.parse(page.nextCursor);
}

function validateDetailResponse(response: PilotAgentMockResponseV1) {
	if (response.status === 200) {
		AgentProjectionV1Schema.parse(response.body);
		return;
	}
	PilotProtocolErrorV1Schema.parse(response.body);
}

function validateStaticResponse<TArgs extends readonly unknown[]>(
	responder: PilotAgentMockResponderV1<TArgs>,
	validate: (response: PilotAgentMockResponseV1) => void,
) {
	if (typeof responder !== "function") validate(responder);
}

function jsonResponse(response: PilotAgentMockResponseV1) {
	return new Response(JSON.stringify(response.body), {
		status: response.status,
		headers: { "Content-Type": "application/json" },
	});
}

export function createPilotAgentMockServerV1(
	scenario: PilotAgentMockServerScenarioV1,
): PilotAgentMockServerV1 {
	validateStaticResponse(scenario.listAgents, validateListResponse);
	validateStaticResponse(scenario.getAgent, validateDetailResponse);

	const requests: Request[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/api/v1/agents") {
			const response =
				typeof scenario.listAgents === "function"
					? scenario.listAgents(request)
					: scenario.listAgents;
			validateListResponse(response);
			return jsonResponse(response);
		}

		const agentIdPath = /^\/api\/v1\/agents\/([^/]+)$/.exec(url.pathname)?.[1];
		if (request.method === "GET" && agentIdPath !== undefined) {
			const agentId = decodeURIComponent(agentIdPath);
			const response =
				typeof scenario.getAgent === "function"
					? scenario.getAgent(request, agentId)
					: scenario.getAgent;
			validateDetailResponse(response);
			return jsonResponse(response);
		}

		throw new Error(
			`Pilot Agent Mock Server does not handle ${request.method} ${url.pathname}`,
		);
	};

	return { fetch, requests };
}
