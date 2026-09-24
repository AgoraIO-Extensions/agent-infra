import { Hono } from "hono";
import {
	addConnectionAuthRoutes,
	type ConnectionAuthDependencies,
} from "./auth.js";

export const connectionApiService = "connection-api";

export function createConnectionApp(auth?: ConnectionAuthDependencies) {
	const app = new Hono();

	app.get("/healthz", (context) =>
		context.json({
			service: connectionApiService,
			status: "ok",
		}),
	);
	if (auth) addConnectionAuthRoutes(app, auth);

	return app;
}
