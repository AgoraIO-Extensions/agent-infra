import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	AgentApplicationManagerRequestV1Schema,
	AgentApplicationManagerResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	AgentApplicationGrantCommandV1,
	AgentApplicationGrantResultV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import {
	type ApiManagementRefusalRecorderV1,
	apiManagementFailure,
} from "./agent-api-management-support.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface AgentApplicationGrantRouteDependencies {
	readonly identity: IdentityAdapter;
	readonly change: (
		input: AgentApplicationGrantCommandV1,
		grantType: "manage" | "use",
	) => Promise<AgentApplicationGrantResultV1>;
	readonly recordRefusal: ApiManagementRefusalRecorderV1;
}

export function registerAgentApplicationGrantRoutes(
	app: Hono,
	dependencies: AgentApplicationGrantRouteDependencies,
) {
	async function handle(
		context: Context,
		granted: boolean,
		grantType: "manage" | "use",
	) {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		try {
			if (request.headers.has("Authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			if (new URL(request.url).search)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			const agentId = OpaqueIdV1Schema.safeParse(context.req.param("agentId"));
			const applicationId = OpaqueIdV1Schema.safeParse(
				context.req.param("applicationId"),
			);
			if (!agentId.success || !applicationId.success)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			await parseJson(
				request,
				AgentApplicationManagerRequestV1Schema,
				metadata.traceId,
			);
			const result = await dependencies.change(
				{
					schemaVersion: 1,
					...metadata,
					agentId: agentId.data,
					applicationId: applicationId.data,
					actorId: identity.userId,
					granted,
					idempotencyKey: parseIdempotencyKey(request, metadata.traceId),
				},
				grantType,
			);
			return context.json(
				AgentApplicationManagerResponseV1Schema.parse(result),
			);
		} catch (error) {
			return apiManagementFailure(
				context,
				error,
				metadata,
				grantType === "manage" ? "manager" : "use",
				dependencies.recordRefusal,
			);
		}
	}
	for (const grantType of ["manage", "use"] as const) {
		const segment =
			grantType === "manage"
				? "application-managers"
				: "application-use-grants";
		const path = `/api/v2/agents/:agentId/${segment}/:applicationId`;
		app.put(path, (context) => handle(context, true, grantType));
		app.delete(path, (context) => handle(context, false, grantType));
	}
}
