import { describe, expect, it } from "vitest";

import { createPlatformApp } from "./app";

describe("platform API health", () => {
	it("reports the service as ready", async () => {
		const response = await createPlatformApp().request("/healthz");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "platform-api",
			status: "ok",
		});
	});
});
