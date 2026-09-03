import { Hono } from "hono";

import { HttpProtocolError, requestMetadata } from "./http/common.js";
import {
	type ConfigurationRoutesDependencies,
	registerConfigurationRoutes,
} from "./http/configuration-routes.js";
import {
	type ManagementRouteDependencies,
	registerManagementRoutes,
} from "./http/management-routes.js";
import {
	registerSessionAuditRoutes,
	type SessionAuditRoutesDependencies,
} from "./http/session-audit-routes.js";

export const platformApiService = "platform-api";

export interface PlatformAppDependencies {
	readonly configuration: ConfigurationRoutesDependencies;
	readonly management: ManagementRouteDependencies;
	readonly sessionAudit: SessionAuditRoutesDependencies;
}

export function createPlatformHealthApp() {
	const app = new Hono();
	app.onError((error, context) => {
		const protocol =
			error instanceof HttpProtocolError
				? error
				: new HttpProtocolError(
						"INTERNAL_ERROR",
						requestMetadata(context.req.raw).traceId,
					);
		return context.json(protocol.body, protocol.status);
	});

	app.get("/healthz", (context) =>
		context.json({
			service: platformApiService,
			status: "ok",
		}),
	);
	return app;
}

export function createPlatformApp(dependencies: PlatformAppDependencies) {
	const app = createPlatformHealthApp();
	registerManagementRoutes(app, dependencies.management);
	registerConfigurationRoutes(app, dependencies.configuration);
	registerSessionAuditRoutes(app, dependencies.sessionAudit);
	return app;
}
