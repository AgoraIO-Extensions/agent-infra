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
	readonly listAgentApplications?: PilotAgentMockResponderV1<[Request]>;
	readonly createAgentApplication?: PilotAgentMockResponderV1<[Request]>;
	readonly getAgentApplication?: PilotAgentMockResponderV1<[Request, string]>;
	readonly updateAgentApplication?: PilotAgentMockResponderV1<
		[Request, string]
	>;
	readonly withdrawAgentApplication?: PilotAgentMockResponderV1<
		[Request, string]
	>;
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
		readonly header?: Schema;
	};
	readonly responses: Record<
		string,
		{
			readonly content: {
				readonly "application/json": { readonly schema: Schema };
			};
		}
	>;
	readonly requestBody?: {
		readonly content: {
			readonly "application/json": { readonly schema: Schema };
		};
	};
};

const listAgentsOperation = pilotBrowserHttpOpenApiPathsV1["/api/v1/agents"]
	.get as unknown as Operation;
const getAgentOperation = pilotBrowserHttpOpenApiPathsV1[
	"/api/v1/agents/{agentId}"
].get as unknown as Operation;
const listAgentApplicationsOperation = pilotBrowserHttpOpenApiPathsV1[
	"/api/v1/agent-applications"
].get as unknown as Operation;
const createAgentApplicationOperation = pilotBrowserHttpOpenApiPathsV1[
	"/api/v1/agent-applications"
].post as unknown as Operation;
const getAgentApplicationOperation = pilotBrowserHttpOpenApiPathsV1[
	"/api/v1/agent-applications/{applicationId}"
].get as unknown as Operation;
const updateAgentApplicationOperation = pilotBrowserHttpOpenApiPathsV1[
	"/api/v1/agent-applications/{applicationId}"
].put as unknown as Operation;
const withdrawAgentApplicationOperation = pilotBrowserHttpOpenApiPathsV1[
	"/api/v1/agent-applications/{applicationId}/withdraw"
].post as unknown as Operation;

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
	responder: PilotAgentMockResponderV1<TArgs> | undefined,
	operation: Operation,
) {
	if (responder !== undefined && typeof responder !== "function") {
		validateResponse(operation, responder);
	}
}

async function validateJsonRequestBody(operation: Operation, request: Request) {
	const schema = operation.requestBody?.content["application/json"].schema;
	if (!schema) {
		throw new TypeError("Pilot Agent Mock Server request body is not declared");
	}
	schema.parse(await request.clone().json());
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
	validateStaticResponse(
		scenario.listAgentApplications,
		listAgentApplicationsOperation,
	);
	validateStaticResponse(
		scenario.createAgentApplication,
		createAgentApplicationOperation,
	);
	validateStaticResponse(
		scenario.getAgentApplication,
		getAgentApplicationOperation,
	);
	validateStaticResponse(
		scenario.updateAgentApplication,
		updateAgentApplicationOperation,
	);
	validateStaticResponse(
		scenario.withdrawAgentApplication,
		withdrawAgentApplicationOperation,
	);

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

		if (
			request.method === "POST" &&
			url.pathname === "/api/v1/agent-applications" &&
			scenario.createAgentApplication !== undefined
		) {
			createAgentApplicationOperation.requestParams.header?.parse({
				"Idempotency-Key": request.headers.get("Idempotency-Key"),
			});
			await validateJsonRequestBody(createAgentApplicationOperation, request);
			const responder = scenario.createAgentApplication;
			const response =
				typeof responder === "function" ? responder(request) : responder;
			validateResponse(createAgentApplicationOperation, response);
			return jsonResponse(response);
		}

		if (
			request.method === "GET" &&
			url.pathname === "/api/v1/agent-applications" &&
			scenario.listAgentApplications !== undefined
		) {
			listAgentApplicationsOperation.requestParams.query?.parse(
				Object.fromEntries(url.searchParams),
			);
			const responder = scenario.listAgentApplications;
			const response =
				typeof responder === "function" ? responder(request) : responder;
			validateResponse(listAgentApplicationsOperation, response);
			return jsonResponse(response);
		}

		const withdrawalApplicationId =
			/^\/api\/v1\/agent-applications\/([^/]+)\/withdraw$/.exec(
				url.pathname,
			)?.[1];
		if (
			request.method === "POST" &&
			withdrawalApplicationId !== undefined &&
			scenario.withdrawAgentApplication !== undefined
		) {
			const applicationId = decodeURIComponent(withdrawalApplicationId);
			withdrawAgentApplicationOperation.requestParams.path?.parse({
				applicationId,
			});
			withdrawAgentApplicationOperation.requestParams.header?.parse({
				"Idempotency-Key": request.headers.get("Idempotency-Key"),
			});
			const responder = scenario.withdrawAgentApplication;
			const response =
				typeof responder === "function"
					? responder(request, applicationId)
					: responder;
			validateResponse(withdrawAgentApplicationOperation, response);
			return jsonResponse(response);
		}

		const applicationIdPath = /^\/api\/v1\/agent-applications\/([^/]+)$/.exec(
			url.pathname,
		)?.[1];
		if (
			request.method === "PUT" &&
			applicationIdPath !== undefined &&
			scenario.updateAgentApplication !== undefined
		) {
			const applicationId = decodeURIComponent(applicationIdPath);
			updateAgentApplicationOperation.requestParams.path?.parse({
				applicationId,
			});
			updateAgentApplicationOperation.requestParams.header?.parse({
				"Idempotency-Key": request.headers.get("Idempotency-Key"),
			});
			await validateJsonRequestBody(updateAgentApplicationOperation, request);
			const responder = scenario.updateAgentApplication;
			const response =
				typeof responder === "function"
					? responder(request, applicationId)
					: responder;
			validateResponse(updateAgentApplicationOperation, response);
			return jsonResponse(response);
		}
		if (
			request.method === "GET" &&
			applicationIdPath !== undefined &&
			scenario.getAgentApplication !== undefined
		) {
			const applicationId = decodeURIComponent(applicationIdPath);
			getAgentApplicationOperation.requestParams.path?.parse({ applicationId });
			const responder = scenario.getAgentApplication;
			const response =
				typeof responder === "function"
					? responder(request, applicationId)
					: responder;
			validateResponse(getAgentApplicationOperation, response);
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
