import {
	type ObservabilityStatusProjectionV1,
	ObservabilityStatusProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

type ObservabilityStatusReader = {
	readonly status: () => Omit<
		ObservabilityStatusProjectionV1,
		"schemaVersion" | "service"
	>;
};

export interface ObservabilityRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly observability?: ObservabilityStatusReader;
}

export function registerObservabilityRoutes(
	app: Hono,
	dependencies: ObservabilityRoutesDependencies,
): void {
	app.get("/api/v1/ops/observability", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		if (!identity.roles.includes("system_admin"))
			throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
		if (!dependencies.observability)
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		const projection = ObservabilityStatusProjectionV1Schema.parse({
			schemaVersion: 1,
			service: "platform-api",
			...dependencies.observability.status(),
		});
		return context.json(projection);
	});
}
