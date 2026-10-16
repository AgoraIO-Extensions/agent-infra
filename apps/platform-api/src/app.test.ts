import { PilotProtocolErrorV1Schema } from "@agent-infra/contracts/pilot";
import type { OperationalEvent } from "@agent-infra/observability";
import { describe, expect, it } from "vitest";

import { createPlatformHealthApp } from "./app";
import { HttpProtocolError, requestMetadata } from "./http/common.js";

describe("platform API health", () => {
	it("reports the service as ready", async () => {
		const response = await createPlatformHealthApp().request("/healthz");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "platform-api",
			status: "ok",
		});
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

	it("records protocol failures with the route template and status", async () => {
		const records: OperationalEvent[] = [];
		const app = createPlatformHealthApp({
			record: (event) => {
				records.push(event);
			},
			status: () => ({
				enabled: false,
				state: "active" as const,
				captureFailures: 0,
				exportFailures: 0,
				lastExportFailureAt: undefined,
				droppedLogs: 0,
				invalidRecords: 0,
			}),
		});
		app.get("/api/v2/agents/:agentId/lifecycle", (context) => {
			throw new HttpProtocolError(
				"DEPENDENCY_UNAVAILABLE",
				requestMetadata(context.req.raw).traceId,
			);
		});

		const response = await app.request(
			"/api/v2/agents/agent-private/lifecycle",
		);

		expect(response.status).toBe(503);
		expect(records).toEqual([
			expect.objectContaining({
				stage: "http",
				outcome: "failed",
				method: "GET",
				routeTemplate: "/api/v2/agents/:agentId/lifecycle",
				statusCode: 503,
				code: "DEPENDENCY_UNAVAILABLE",
			}),
		]);
		expect(JSON.stringify(records)).not.toContain("agent-private");
	});
});
