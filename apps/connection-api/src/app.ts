import { Hono } from "hono";

export const connectionApiService = "connection-api";

export function createConnectionApp() {
	const app = new Hono();

	app.get("/healthz", (context) =>
		context.json({
			service: connectionApiService,
			status: "ok",
		}),
	);

	return app;
}
