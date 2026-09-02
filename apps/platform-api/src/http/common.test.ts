import {
	AgentLifecycleCommandRequestV1Schema,
	PilotInternalErrorV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	parsePageQuery,
	requestMetadata,
} from "./common";

const traceId = "trace-http-common";

describe("HTTP common boundary", () => {
	it("creates server-owned correlation IDs", () => {
		const metadata = requestMetadata(
			new Request("https://platform.example.test/api/v1/session", {
				headers: {
					"X-Request-ID": "caller-request",
					"X-Trace-ID": "caller-trace",
				},
			}),
		);

		expect(metadata.requestId).toMatch(/^[0-9a-f-]{36}$/);
		expect(metadata.traceId).toMatch(/^[0-9a-f-]{36}$/);
		expect(metadata).not.toContain("caller-request");
		expect(metadata).not.toContain("caller-trace");
	});

	it("validates an idempotency key without changing its case", () => {
		const request = new Request("https://platform.example.test/api/v1/agents", {
			headers: { "Idempotency-Key": "Command.Aa-01" },
		});

		expect(parseIdempotencyKey(request, traceId)).toBe("Command.Aa-01");
		expect(() =>
			parseIdempotencyKey(
				new Request("https://platform.example.test", {
					headers: { "Idempotency-Key": "contains space" },
				}),
				traceId,
			),
		).toThrow(HttpProtocolError);
	});

	it("parses only the bounded page query", () => {
		expect(
			parsePageQuery(
				new Request(
					"https://platform.example.test/api/v1/agents?cursor=c1&limit=100",
				),
				traceId,
			),
		).toEqual({ cursor: "c1", limit: 100 });
		for (const query of [
			"limit=0",
			"limit=101",
			"limit=1.5",
			"limit=1&limit=2",
			"userId=other",
		]) {
			expect(() =>
				parsePageQuery(
					new Request(`https://platform.example.test/api/v1/agents?${query}`),
					traceId,
				),
			).toThrow(HttpProtocolError);
		}
	});

	it("parses JSON through the authoritative request schema", async () => {
		const parsed = await parseJson(
			new Request("https://platform.example.test/api/v1/agents/a/lifecycle", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ schemaVersion: 1, command: "stop" }),
			}),
			AgentLifecycleCommandRequestV1Schema,
			traceId,
		);

		expect(parsed).toEqual({
			value: { schemaVersion: 1, command: "stop" },
			rawRequestDigest:
				"3f937159355efc5a07b6d0be2c1e80578e3088765908f9389833f055159ec62c",
		});
		await expect(
			parseJson(
				new Request("https://platform.example.test/api/v1/agents/a/lifecycle", {
					method: "POST",
					body: "{not-json",
				}),
				AgentLifecycleCommandRequestV1Schema,
				traceId,
			),
		).rejects.toThrow(HttpProtocolError);
		await expect(
			parseJson(
				new Request("https://platform.example.test/api/v1/agents/a/lifecycle", {
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: JSON.stringify({ schemaVersion: 1, command: "stop" }),
				}),
				AgentLifecycleCommandRequestV1Schema,
				traceId,
			),
		).rejects.toThrow(HttpProtocolError);
	});

	it("returns a stable redacted protocol error", () => {
		let error: HttpProtocolError | undefined;
		try {
			parseIdempotencyKey(
				new Request("https://platform.example.test"),
				traceId,
			);
		} catch (caught) {
			error = caught as HttpProtocolError;
		}

		expect(error?.status).toBe(400);
		expect(error?.body).toEqual({
			schemaVersion: 1,
			code: "INVALID_REQUEST",
			message: "Request is invalid.",
			retryable: false,
			traceId,
		});
		expect(PilotProtocolErrorV1Schema.safeParse(error?.body).success).toBe(
			true,
		);
		expect(JSON.stringify(error)).not.toContain("Idempotency-Key");

		const conflict = new HttpProtocolError("CONFLICT", traceId);
		expect(conflict.status).toBe(409);
		expect(conflict.body).toEqual({
			schemaVersion: 1,
			code: "INVALID_REQUEST",
			message: "Request conflicts with current state.",
			retryable: false,
			traceId,
		});

		const forbidden = new HttpProtocolError("FORBIDDEN", traceId);
		expect(forbidden.status).toBe(403);
		expect(forbidden.body).toEqual({
			schemaVersion: 1,
			code: "RESOURCE_UNAVAILABLE",
			message: "Request is not authorized.",
			retryable: false,
			traceId,
		});

		const internal = new HttpProtocolError("INTERNAL_ERROR", traceId);
		expect(internal.status).toBe(500);
		expect(internal.body).toEqual({
			schemaVersion: 1,
			code: "INTERNAL_ERROR",
			message: "The request could not be completed.",
			retryable: true,
			traceId,
		});
		expect(PilotInternalErrorV1Schema.safeParse(internal.body).success).toBe(
			true,
		);
	});
});
