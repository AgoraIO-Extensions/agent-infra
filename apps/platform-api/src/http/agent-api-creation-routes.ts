import {
	AgentApiCreationRequestV1Schema,
	AgentApiCreationResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import type { AgentApiCreationResultV1 } from "@agent-infra/platform-core";
import type { Hono } from "hono";
import {
	type ApiManagementRefusalRecorderV1,
	apiManagementFailure,
	requireApiManagementMaterial,
} from "./agent-api-management-support.js";
import { parseIdempotencyKey, parseJson, requestMetadata } from "./common.js";

export interface AgentApiCreationRouteDependencies {
	readonly create: (
		input: unknown,
		material: string,
	) => Promise<AgentApiCreationResultV1>;
	readonly recordRefusal: ApiManagementRefusalRecorderV1;
}

export function registerAgentApiCreationRoutes(
	app: Hono,
	dependencies: AgentApiCreationRouteDependencies,
) {
	app.post("/api/v2/agents", async (context) => {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		try {
			const material = requireApiManagementMaterial(request, metadata.traceId);
			const { value } = await parseJson(
				request,
				AgentApiCreationRequestV1Schema,
				metadata.traceId,
			);
			const result = await dependencies.create(
				{
					...value,
					idempotencyKey: parseIdempotencyKey(request, metadata.traceId),
					requestId: metadata.requestId,
					traceId: metadata.traceId,
				},
				material,
			);
			return context.json(
				AgentApiCreationResponseV1Schema.parse(result),
				result.replayed ? 200 : 201,
			);
		} catch (error) {
			return apiManagementFailure(
				context,
				error,
				metadata,
				"create",
				dependencies.recordRefusal,
			);
		}
	});
}
