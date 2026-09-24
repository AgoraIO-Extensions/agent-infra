import { Hono } from "hono";
import {
	addConnectionAuthRoutes,
	type ConnectionAuthDependencies,
} from "./auth.js";
import {
	addConnectionClientRoutes,
	type ConnectionClientDependencies,
} from "./client.js";

export const connectionApiService = "connection-api";

export function createConnectionApp(
	auth?: ConnectionAuthDependencies,
	client?: ConnectionClientDependencies,
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

	return app;
}
