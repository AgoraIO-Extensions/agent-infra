import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import type { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface MaintenanceTerminalAccessDependencies {
	readonly identity: IdentityAdapter;
	readonly readAccess: (input: {
		agentId: string;
		actorId: string;
	}) => Promise<boolean>;
}

export function registerMaintenanceTerminalAccess(
	app: Hono,
	dependencies: MaintenanceTerminalAccessDependencies,
) {
	app.get("/api/v2/agents/:agentId/maintenance-terminal/access", async (c) => {
		const request = c.req.raw;
		const { traceId } = requestMetadata(request);
		c.header("Cache-Control", "no-store");
		if (request.headers.has("Authorization"))
			throw new HttpProtocolError("AUTHENTICATION_REQUIRED", traceId);
		const agentId = OpaqueIdV1Schema.safeParse(c.req.param("agentId"));
		if (!agentId.success || new URL(request.url).search)
			throw new HttpProtocolError("INVALID_REQUEST", traceId);
		const actor = await resolveIdentity(
			dependencies.identity,
			request,
			traceId,
		);
		let allowed: boolean;
		try {
			allowed = await dependencies.readAccess({
				agentId: agentId.data,
				actorId: actor.userId,
			});
		} catch {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
		}
		if (allowed !== true) throw new HttpProtocolError("FORBIDDEN", traceId);
		return c.body(null, 204);
	});
}
