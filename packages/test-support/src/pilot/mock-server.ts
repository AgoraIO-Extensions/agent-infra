import { pilotBrowserHttpOpenApiPathsV1 } from "@agent-infra/contracts/pilot";

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

type Schema = { parse(input: unknown): unknown };
type Operation = {
	readonly requestParams: {
		readonly path?: Schema;
		readonly query?: Schema;
	};
	readonly responses: Record<
		string,
		{
			readonly content: {
				readonly "application/json": { readonly schema: Schema };
			};
		}
	>;
};

const listAgentsOperation = pilotBrowserHttpOpenApiPathsV1["/api/v1/agents"]
	.get as unknown as Operation;
const getAgentOperation = pilotBrowserHttpOpenApiPathsV1[
	"/api/v1/agents/{agentId}"
].get as unknown as Operation;

function validateResponse(
	operation: Operation,
	response: PilotAgentMockResponseV1,
) {
	if (!Number.isInteger(response.status)) {
		throw new TypeError("Pilot Agent Mock Server response status is invalid");
	}
	const schema =
		operation.responses[String(response.status)]?.content["application/json"]
			?.schema;
	if (!schema) {
		throw new TypeError("Pilot Agent Mock Server response is not declared");
	}
	schema.parse(response.body);
}

function validateStaticResponse<TArgs extends readonly unknown[]>(
	responder: PilotAgentMockResponderV1<TArgs>,
	operation: Operation,
) {
	if (typeof responder !== "function") validateResponse(operation, responder);
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
	validateStaticResponse(scenario.listAgents, listAgentsOperation);
	validateStaticResponse(scenario.getAgent, getAgentOperation);

	const requests: Request[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/api/v1/agents") {
			listAgentsOperation.requestParams.query?.parse(
				Object.fromEntries(url.searchParams),
			);
			const response =
				typeof scenario.listAgents === "function"
					? scenario.listAgents(request)
					: scenario.listAgents;
			validateResponse(listAgentsOperation, response);
			return jsonResponse(response);
		}

		const agentIdPath = /^\/api\/v1\/agents\/([^/]+)$/.exec(url.pathname)?.[1];
		if (request.method === "GET" && agentIdPath !== undefined) {
			const agentId = decodeURIComponent(agentIdPath);
			getAgentOperation.requestParams.path?.parse({ agentId });
			const response =
				typeof scenario.getAgent === "function"
					? scenario.getAgent(request, agentId)
					: scenario.getAgent;
			validateResponse(getAgentOperation, response);
			return jsonResponse(response);
		}

		throw new Error(
			`Pilot Agent Mock Server does not handle ${request.method} ${url.pathname}`,
		);
	};

	return { fetch, requests };
}
