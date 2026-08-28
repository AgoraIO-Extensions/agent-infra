import { Hono } from "hono";

export const connectionApiService = "connection-api";

export function createConnectionApp() {
	const app = new Hono();

	app.get("/healthz", (context) => {
		context.header("Cache-Control", "no-store");

		return context.json({
			service: connectionApiService,
			status: "ok",
		});
	});

	return app;
}
