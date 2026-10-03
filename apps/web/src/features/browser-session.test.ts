// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient } from "../pilot/generated/client/index.js";
import { loadBrowserSession } from "./browser-session.js";

const session = {
	schemaVersion: 1,
	user: {
		userId: "user-1",
		displayName: "Test user",
		roles: ["employee"],
	},
};

describe("shared browser session reader", () => {
	afterEach(() => vi.useRealTimers());
	it("reads the current session and its server-issued generation", async () => {
		const requests: Request[] = [];
		const generation = "g".repeat(43);
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (request) => {
				requests.push(request as Request);
				return Response.json(session, {
					headers: { "x-platform-session-generation": generation },
				});
			},
		});
		await expect(loadBrowserSession(client)).resolves.toEqual({
			kind: "ready",
			session,
			sessionGeneration: generation,
		});
		expect(requests.map((request) => [request.method, request.url])).toEqual([
			["GET", "https://platform.example.test/api/v1/session"],
			["GET", "https://platform.example.test/api/v1/connection/capability"],
		]);
	});

	it.each(["short", "g".repeat(44), `${"g".repeat(42)}!`])(
		"does not accept an invalid generation header %s",
		async (generation) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () =>
					Response.json(session, {
						headers: { "x-platform-session-generation": generation },
					}),
			});
			await expect(loadBrowserSession(client)).resolves.toEqual({
				kind: "ready",
				session,
			});
		},
	);

	it("makes the session ready when the capability request stalls", async () => {
		vi.useFakeTimers();
		let capabilityAborted = false;
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input) => {
				const request = input as Request;
				if (request.url.endsWith("/session")) return Response.json(session);
				return new Promise<Response>((_resolve, reject) => {
					request.signal.addEventListener(
						"abort",
						() => {
							capabilityAborted = true;
							reject(request.signal.reason);
						},
						{ once: true },
					);
				});
			},
		});
		const state = loadBrowserSession(client);
		await vi.advanceTimersByTimeAsync(3_000);
		await expect(state).resolves.toEqual({
			kind: "ready",
			session,
		});
		expect(capabilityAborted).toBe(true);
	});

	it("isolates a capability network failure from a successful session", async () => {
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input) => {
				if ((input as Request).url.endsWith("/session"))
					return Response.json(session);
				throw new TypeError("Controlled capability network failure");
			},
		});
		await expect(loadBrowserSession(client)).resolves.toEqual({
			kind: "ready",
			session,
		});
	});

	it.each([false, true])(
		"keeps a retryable=%s failure opaque",
		async (retryable) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () =>
					Response.json(
						{
							schemaVersion: 1,
							code: "RESOURCE_UNAVAILABLE",
							message: "private authorization detail",
							retryable,
							traceId: "trace-session",
						},
						{ status: retryable ? 503 : 403 },
					),
			});
			if (retryable) {
				await expect(loadBrowserSession(client)).rejects.toMatchObject({
					retryable: true,
					message: "Agent administration is temporarily unavailable",
				});
			} else {
				await expect(loadBrowserSession(client)).resolves.toEqual({
					kind: "unavailable",
					retryable: false,
				});
			}
		},
	);
});
