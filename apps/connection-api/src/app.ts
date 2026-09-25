import type { createConnectionCatalogRepository } from "@agent-infra/connection-store";
import { Hono } from "hono";
import { addConnectionActionRoutes } from "./actions.js";
import {
	addConnectionAuthRoutes,
	type ConnectionAuthDependencies,
} from "./auth.js";
import { addConnectionCatalogRoutes } from "./catalog.js";
import {
	addConnectionClientRoutes,
	type ConnectionClientDependencies,
} from "./client.js";

export const connectionApiService = "connection-api";

export function createConnectionApp(
	auth?: ConnectionAuthDependencies,
	client?: ConnectionClientDependencies,
	catalog?: ReturnType<typeof createConnectionCatalogRepository>,
) {
	const app = new Hono();

	app.get("/healthz", (context) =>
		context.json({
			service: connectionApiService,
			status: "ok",
		}),
	);
	if (auth) addConnectionAuthRoutes(app, auth);
	if (client) addConnectionClientRoutes(app, client);
	if (client && catalog) addConnectionCatalogRoutes(app, client, catalog);
	if (client?.authority) addConnectionActionRoutes(app, client);

	return app;
}
