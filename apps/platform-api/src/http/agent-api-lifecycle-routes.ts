import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	AgentApiLifecycleRequestV1Schema,
	AgentApiLifecycleResponseV1Schema,
	AgentApiStateResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import type { AgentApiLifecycleV1 } from "@agent-infra/platform-core";
import type { Hono } from "hono";
import {
	type ApiManagementRefusalRecorderV1,
	apiManagementFailure,
	requireApiManagementMaterial,
} from "./agent-api-management-support.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";

export interface AgentApiLifecycleRouteDependencies {
	readonly lifecycle: AgentApiLifecycleV1;
	readonly readState: (
		request: {
			readonly agentId: string;
			readonly requestId: string;
			readonly traceId: string;
		},
		material: string,
	) => Promise<unknown>;
	readonly recordRefusal: ApiManagementRefusalRecorderV1;
}

export function registerAgentApiLifecycleRoutes(
	app: Hono,
	dependencies: AgentApiLifecycleRouteDependencies,
) {
	app.get("/api/v2/agents/:agentId/state", async (context) => {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		try {
			const material = requireApiManagementMaterial(request, metadata.traceId);
			if (
				request.body !== null ||
				Number(request.headers.get("Content-Length") ?? 0) > 0 ||
				request.headers.has("Transfer-Encoding")
			)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const agentId = OpaqueIdV1Schema.safeParse(context.req.param("agentId"));
			if (!agentId.success)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const state = await dependencies.readState(
				{ ...metadata, agentId: agentId.data },
				material,
			);
			return context.json(AgentApiStateResponseV1Schema.parse(state));
		} catch (error) {
			return apiManagementFailure(
				context,
				error,
				metadata,
				"state",
				dependencies.recordRefusal,
			);
		}
	});

	app.post("/api/v2/agents/:agentId/commands", async (context) => {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		try {
			const material = requireApiManagementMaterial(request, metadata.traceId);
			const agentId = OpaqueIdV1Schema.safeParse(context.req.param("agentId"));
			if (!agentId.success)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const { value } = await parseJson(
				request,
				AgentApiLifecycleRequestV1Schema,
				metadata.traceId,
			);
			const decision = await dependencies.lifecycle.execute(
				{
					...value,
					agentId: agentId.data,
					idempotencyKey: parseIdempotencyKey(request, metadata.traceId),
					...metadata,
				},
				material,
			);
			if (decision.outcome === "denied")
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			if (decision.outcome === "conflict")
				throw new HttpProtocolError("CONFLICT", metadata.traceId);
			return context.json(
				AgentApiLifecycleResponseV1Schema.parse({
					schemaVersion: 1,
					agentId: decision.result.agentId,
					status: decision.result.status,
					revision: decision.result.revision,
					replayed: decision.outcome === "replayed",
				}),
				202,
			);
		} catch (error) {
			return apiManagementFailure(
				context,
				error,
				metadata,
				"lifecycle",
				dependencies.recordRefusal,
			);
		}
	});
}
