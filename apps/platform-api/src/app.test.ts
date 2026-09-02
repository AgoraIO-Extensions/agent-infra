import { PilotProtocolErrorV1Schema } from "@agent-infra/contracts/pilot";
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

	it("registers injected routes and serializes protocol failures", async () => {
		const app = createPlatformApp({
			sessionAudit: {
				identity: {
					async resolve() {
						throw new Error("private identity failure");
					},
					async hydrateUsers() {
						return [];
					},
				},
				audit: {
					async listAudit() {
						return { items: [], nextCursor: null };
					},
				},
			},
		});

		const response = await app.request("/api/v1/session");

		expect(response.status).toBe(503);
		const body = await response.json();
		expect(PilotProtocolErrorV1Schema.parse(body)).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
			retryable: true,
		});
		expect(JSON.stringify(body)).not.toContain("private identity failure");
	});
});
