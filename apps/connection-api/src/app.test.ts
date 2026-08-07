import { describe, expect, it } from "vitest";

import { createConnectionApp } from "./app";

describe("Connection API health", () => {
	it("reports the independent service as ready", async () => {
		const response = await createConnectionApp().request("/healthz");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "connection-api",
			status: "ok",
		});
	});
});
