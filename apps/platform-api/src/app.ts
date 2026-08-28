import { Hono } from "hono";

export const platformApiService = "platform-api";

export function createPlatformApp() {
	const app = new Hono();

	app.get("/healthz", (context) => {
		context.header("Cache-Control", "no-store");

		return context.json({
			service: platformApiService,
			status: "ok",
		});
	});

	return app;
}
