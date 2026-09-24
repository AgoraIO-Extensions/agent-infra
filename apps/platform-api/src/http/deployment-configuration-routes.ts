import { DeploymentConfigurationProjectionV2Schema } from "@agent-infra/contracts/pilot";
import type { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface DeploymentConfigurationRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly read: () => Promise<unknown>;
}

export function registerDeploymentConfigurationRoutes(
	app: Hono,
	dependencies: DeploymentConfigurationRoutesDependencies,
): void {
	app.get("/api/v2/deployment/configuration", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		try {
			return context.json(
				DeploymentConfigurationProjectionV2Schema.parse(
					await dependencies.read(),
				),
			);
		} catch {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
	});
}
