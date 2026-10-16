import { PilotProtocolErrorV1Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it, vi } from "vitest";

import { createPlatformHealthApp } from "./app";
import { requestMetadata } from "./http/common.js";

describe("platform API health", () => {
	it("reports the service as ready", async () => {
		const response = await createPlatformHealthApp().request("/healthz");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "platform-api",
			status: "ok",
		});
	});

	it("fails readiness closed until the deployment dependency is ready", async () => {
		const readiness = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		const app = createPlatformHealthApp(undefined, readiness);

		const starting = await app.request("/readyz");
		expect(starting.status).toBe(503);
		expect(await starting.json()).toEqual({
			service: "platform-api",
			status: "starting",
		});

		const ready = await app.request("/readyz");
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({
			service: "platform-api",
			status: "ready",
		});
		expect(readiness).toHaveBeenCalledTimes(2);
	});

	it("serializes unexpected failures without private details", async () => {
		const app = createPlatformHealthApp();
		app.get("/failure", () => {
			throw new Error("private failure");
		});

		const response = await app.request("/failure");

		expect(response.status).toBe(500);
		const body = await response.json();
		expect(PilotProtocolErrorV1Schema.parse(body)).toMatchObject({
			code: "INTERNAL_ERROR",
			retryable: true,
		});
		expect(JSON.stringify(body)).not.toContain("private failure");
	});

	it("reuses server-owned request IDs and reports exporter health separately", async () => {
		const records: { requestId?: string; traceId?: string }[] = [];
		const status = {
			enabled: true,
			state: "active" as const,
			captureFailures: 0,
			exportFailures: 1,
			lastExportFailureAt: "2026-09-30T00:00:00.000Z",
			droppedLogs: 0,
			invalidRecords: 0,
		};
		const app = createPlatformHealthApp({
			record: (event) => records.push(event),
			status: () => status,
		});
		app.get("/correlation", (context) => {
			const first = requestMetadata(context.req.raw);
			const second = requestMetadata(context.req.raw);
			expect(second).toEqual(first);
			return context.json(first);
		});
		const response = await app.request("/correlation", {
			headers: {
				"X-Request-ID": "caller-request",
				"X-Trace-ID": "caller-trace",
			},
		});
		const metadata = (await response.json()) as {
			requestId: string;
			traceId: string;
		};
		expect(metadata.requestId).not.toBe("caller-request");
		expect(metadata.traceId).not.toBe("caller-trace");
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject(metadata);

		const health = await app.request("/healthz");
		expect(await health.json()).toEqual({
			service: "platform-api",
			status: "ok",
			observability: status,
		});
	});
});
