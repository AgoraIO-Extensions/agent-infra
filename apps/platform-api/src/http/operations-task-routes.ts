import {
	type OperationsTaskQueryV2,
	OperationsTaskQueryV2Schema,
	OperationsTasksV2Schema,
} from "@agent-infra/contracts/pilot";
import { OperationsScopeErrorV2 } from "@agent-infra/platform-core";
import type { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface OperationsTaskRoutesDependenciesV2 {
	identity: IdentityAdapter;
	tasks?: {
		read(input: OperationsTaskQueryV2, signal: AbortSignal): Promise<unknown>;
	};
}

export function registerOperationsTaskRoutesV2(
	app: Hono,
	dependencies: OperationsTaskRoutesDependenciesV2,
) {
	app.get("/api/v2/ops/tasks", async (context) => {
		const { traceId } = requestMetadata(context.req.raw);
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			traceId,
		);
		if (!identity.roles.includes("system_admin"))
			throw new HttpProtocolError("FORBIDDEN", traceId);
		const query = OperationsTaskQueryV2Schema.safeParse(context.req.query());
		if (!query.success || Date.parse(query.data.end) > Date.now() + 60_000)
			throw new HttpProtocolError("INVALID_REQUEST", traceId);
		context.header("Cache-Control", "no-store");
		try {
			if (dependencies.tasks) {
				const result = await dependencies.tasks.read(
					query.data,
					context.req.raw.signal,
				);
				return context.json(OperationsTasksV2Schema.parse(result));
			}
		} catch (error) {
			if (error instanceof OperationsScopeErrorV2)
				throw new HttpProtocolError("FORBIDDEN", traceId);
		}
		return context.json({
			schemaVersion: 2,
			source: "platform",
			state: "unavailable",
			truncated: false,
			tasks: [],
		} as const);
	});
}
