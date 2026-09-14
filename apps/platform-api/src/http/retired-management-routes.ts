import type { Hono } from "hono";

import { HttpProtocolError, requestMetadata } from "./common.js";

/** Never reinterpret a legacy Action-bearing request as a new authorization. */
export function registerRetiredManagementRoutes(app: Hono): void {
	for (const path of [
		"/api/v1/agent-applications",
		"/api/v1/agent-applications/:applicationId",
		"/api/v1/agent-applications/:applicationId/withdraw",
		"/api/v1/admin/agent-applications",
		"/api/v1/admin/agent-applications/:applicationId/decision",
		"/api/v1/agents",
		"/api/v1/agents/:agentId",
		"/api/v1/agents/:agentId/configuration",
		"/api/v1/agents/:agentId/lifecycle",
	]) {
		app.all(path, (context) => {
			throw new HttpProtocolError(
				"VERSION_RETIRED",
				requestMetadata(context.req.raw).traceId,
			);
		});
	}
}
