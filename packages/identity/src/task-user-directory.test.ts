import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
	createHttpTaskUserDirectoryV1,
	type HttpTaskUserDirectoryOptionsV1,
	resolveCurrentTaskUserV1,
	TaskIdentityUnavailableErrorV1,
} from "./task-user-directory.js";

const active = {
	schemaVersion: 1,
	userId: "user-1",
	accountStatus: "active",
	organizationIds: ["org-1"],
	authorizationRevision: "identity-1",
} as const;

const options = (
	overrides: Partial<HttpTaskUserDirectoryOptionsV1> = {},
): HttpTaskUserDirectoryOptionsV1 => ({
	endpoint: "https://identity.example.test/current-user",
	loadServiceAuthorization: async () => "Bearer controlled-service-credential",
	// Explicit controlled fixture trust boundary; not a deployment verifier.
	verifyResponse: async ({ payload }) => payload,
	fetch: vi.fn().mockImplementation(async () => Response.json(active)),
	...overrides,
});

describe("requestless current task identity boundary", () => {
	it("reads current facts each time and preserves disabled or absent users", async () => {
		let current: unknown | null = active;
		const resolveUser = vi.fn(async () => current);
		const directory = { resolveUser };
		await expect(
			resolveCurrentTaskUserV1(directory, "user-1"),
		).resolves.toEqual(active);
		current = {
			...active,
			accountStatus: "disabled",
			organizationIds: [],
			authorizationRevision: "identity-2",
		};
		await expect(
			resolveCurrentTaskUserV1(directory, "user-1"),
		).resolves.toEqual(current);
		current = null;
		await expect(
			resolveCurrentTaskUserV1(directory, "user-1"),
		).resolves.toBeNull();
		expect(resolveUser.mock.calls).toEqual([
			["user-1"],
			["user-1"],
			["user-1"],
		]);
	});

	it("rejects another user, privileged response expansion, malformed arrays and accessor payloads", async () => {
		const getter = vi.fn(() => "user-1");
		const accessor = Object.defineProperty({ ...active }, "userId", {
			enumerable: true,
			get: getter,
		});
		for (const value of [
			{ ...active, userId: "owner-1" },
			{ ...active, roles: ["system_admin"] },
			{ ...active, organizationIds: ["org-1", "org-1"] },
			{ ...active, organizationIds: new Array(1) },
			{ ...active, authorizationRevision: "" },
			new Proxy(active, {}),
			accessor,
		]) {
			await expect(
				resolveCurrentTaskUserV1({ resolveUser: async () => value }, "user-1"),
			).rejects.toThrow(TaskIdentityUnavailableErrorV1);
		}
		expect(getter).not.toHaveBeenCalled();
	});

	it("does not query invalid references or expose provider errors", async () => {
		const resolveUser = vi.fn(async () => {
			throw new Error("secret-provider-detail");
		});
		for (const userId of ["", "bad\0id", "\ud800", "x".repeat(1025)]) {
			await expect(
				resolveCurrentTaskUserV1({ resolveUser }, userId),
			).rejects.toThrow("TASK_IDENTITY_UNAVAILABLE");
		}
		expect(resolveUser).not.toHaveBeenCalled();
		await expect(
			resolveCurrentTaskUserV1({ resolveUser }, "user-1"),
		).rejects.toThrow("TASK_IDENTITY_UNAVAILABLE");
		await expect(resolveCurrentTaskUserV1(undefined, "user-1")).rejects.toThrow(
			"TASK_IDENTITY_UNAVAILABLE",
		);
	});
});

describe("deployment HTTP task user directory", () => {
	it("requires a secure fixed endpoint and explicit deployment trust verification", () => {
		for (const endpoint of [
			"http://identity.example.test/current-user",
			"https://user:password@identity.example.test/current-user",
			"https://identity.example.test/current-user?token=secret",
			"https://identity.example.test/current-user#fragment",
		]) {
			expect(() =>
				createHttpTaskUserDirectoryV1(options({ endpoint })),
			).toThrow("TASK_IDENTITY_UNAVAILABLE");
		}
		for (const missing of [
			"loadServiceAuthorization",
			"verifyResponse",
		] as const) {
			const input = options();
			Reflect.deleteProperty(input, missing);
			expect(() => createHttpTaskUserDirectoryV1(input)).toThrow(
				"TASK_IDENTITY_UNAVAILABLE",
			);
		}
	});

	it("uses a fresh service credential and request nonce without cookies or browser identity", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json(active));
		const loadServiceAuthorization = vi
			.fn()
			.mockResolvedValueOnce("Bearer service-1")
			.mockResolvedValueOnce("Bearer service-2");
		const verifyResponse = vi
			.fn<HttpTaskUserDirectoryOptionsV1["verifyResponse"]>()
			.mockImplementation(async ({ payload }) => payload);
		const directory = createHttpTaskUserDirectoryV1(
			options({ fetch: fetcher, loadServiceAuthorization, verifyResponse }),
		);
		await directory.resolveUser("user-1");
		await directory.resolveUser("user-1");
		const requestIds: string[] = [];
		for (const [index, [url, init]] of fetcher.mock.calls.entries()) {
			expect(url).toBe("https://identity.example.test/current-user");
			expect(init).toMatchObject({
				method: "POST",
				redirect: "error",
				credentials: "omit",
				cache: "no-store",
				referrerPolicy: "no-referrer",
			});
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer service-${index + 1}`);
			expect(headers.has("cookie")).toBe(false);
			expect(headers.has("x-user-id")).toBe(false);
			const body = JSON.parse(String(init?.body));
			expect(Object.keys(body).sort()).toEqual([
				"requestId",
				"schemaVersion",
				"userId",
			]);
			expect(body).toMatchObject({ schemaVersion: 1, userId: "user-1" });
			requestIds.push(body.requestId);
			expect(verifyResponse.mock.calls[index]?.[0]).toMatchObject({
				requestId: body.requestId,
				userId: "user-1",
				payload: active,
			});
		}
		expect(new Set(requestIds).size).toBe(2);
	});

	it("rejects unverifiable, malformed and user-substituted responses", async () => {
		for (const verifyResponse of [
			async () => {
				throw new Error("untrusted-signature-private-detail");
			},
			async () => ({ ...active, userId: "admin" }),
			async () => ({ ...active, authorizationRevision: undefined }),
		]) {
			await expect(
				createHttpTaskUserDirectoryV1(options({ verifyResponse })).resolveUser(
					"user-1",
				),
			).rejects.toThrow("TASK_IDENTITY_UNAVAILABLE");
		}
	});

	it("does not send absent or header-injecting service authentication", async () => {
		for (const authorization of [
			"",
			" ",
			"Bearer secret\r\nCookie: browser-session",
			"x".repeat(8193),
		]) {
			const fetcher = vi.fn<typeof fetch>();
			const directory = createHttpTaskUserDirectoryV1(
				options({
					fetch: fetcher,
					loadServiceAuthorization: async () => authorization,
				}),
			);
			await expect(directory.resolveUser("user-1")).rejects.toThrow(
				"TASK_IDENTITY_UNAVAILABLE",
			);
			expect(fetcher).not.toHaveBeenCalled();
		}
	});

	it("rejects status, redirect, non-JSON, malformed UTF-8 and oversized bodies before verification", async () => {
		for (const response of [
			new Response("private-error-detail", { status: 503 }),
			new Response(null, {
				status: 302,
				headers: { location: "https://other.example.test/" },
			}),
			new Response(JSON.stringify(active), {
				headers: { "content-type": "text/html" },
			}),
			new Response("{invalid", {
				headers: { "content-type": "application/json" },
			}),
			new Response(new Uint8Array([0xff]), {
				headers: { "content-type": "application/json" },
			}),
			Response.json({ detail: "x".repeat(65_536) }),
		]) {
			const verifyResponse = vi.fn(async () => active);
			await expect(
				createHttpTaskUserDirectoryV1(
					options({
						fetch: vi.fn().mockResolvedValue(response),
						verifyResponse,
					}),
				).resolveUser("user-1"),
			).rejects.toThrow("TASK_IDENTITY_UNAVAILABLE");
			expect(verifyResponse).not.toHaveBeenCalled();
		}
	});

	it("bounds service-auth and verification waits without accepting late results", async () => {
		for (const stage of [
			"loadServiceAuthorization",
			"verifyResponse",
		] as const) {
			const fetcher = vi
				.fn<typeof fetch>()
				.mockImplementation(async () => Response.json(active));
			let finish: (() => void) | undefined;
			let signal: AbortSignal | undefined;
			const blocker = ({
				signal: currentSignal,
			}: {
				readonly signal: AbortSignal;
			}) => {
				signal = currentSignal;
				return new Promise<string>((resolve) => {
					finish = () => resolve("Bearer late-service");
				});
			};
			const directory = createHttpTaskUserDirectoryV1(
				options({ fetch: fetcher, timeoutMs: 10, [stage]: blocker }),
			);
			await expect(directory.resolveUser("user-1")).rejects.toThrow(
				"TASK_IDENTITY_UNAVAILABLE",
			);
			expect(signal?.aborted).toBe(true);
			finish?.();
			await Promise.resolve();
			if (stage === "loadServiceAuthorization")
				expect(fetcher).not.toHaveBeenCalled();
		}
	});

	it("cancels a stalled body and never invokes the verifier", async () => {
		const cancel = vi.fn();
		const response = new Response(new ReadableStream({ cancel }), {
			headers: { "content-type": "application/json" },
		});
		const verifyResponse = vi.fn(async () => active);
		const directory = createHttpTaskUserDirectoryV1(
			options({
				fetch: vi.fn().mockResolvedValue(response),
				verifyResponse,
				timeoutMs: 10,
			}),
		);
		await expect(directory.resolveUser("user-1")).rejects.toThrow(
			"TASK_IDENTITY_UNAVAILABLE",
		);
		expect(cancel).toHaveBeenCalledOnce();
		expect(verifyResponse).not.toHaveBeenCalled();
	});

	it("rechecks controlled signed HTTP facts and rejects replay and forged signatures", async () => {
		const key = randomBytes(32);
		const signature = (body: string) =>
			createHmac("sha256", key).update(body).digest("hex");
		let mode: "active" | "disabled" | "replay" | "forged" = "active";
		let previous = "";
		const observedHeaders: IncomingHttpHeaders[] = [];
		const server = createServer(async (request, response) => {
			observedHeaders.push(request.headers);
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const query = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const issuedAt = Date.now();
			const body = JSON.stringify({
				issuer: "controlled-identity",
				audience: "worker-test",
				deploymentId: "deployment-test",
				keyVersion: "key-test",
				requestId: query.requestId,
				contextId: query.requestId,
				issuedAt,
				expiresAt: issuedAt + 1_000,
				user: {
					...active,
					accountStatus: mode === "disabled" ? "disabled" : "active",
					authorizationRevision:
						mode === "disabled" ? "identity-2" : "identity-1",
				},
			});
			const envelope = JSON.stringify({
				body,
				signature: mode === "forged" ? "0".repeat(64) : signature(body),
			});
			response.writeHead(200, { "content-type": "application/json" });
			response.end(mode === "replay" ? previous : envelope);
			if (mode !== "replay") previous = envelope;
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const port = (server.address() as AddressInfo).port;
		const seen = new Set<string>();
		const verifyResponse: HttpTaskUserDirectoryOptionsV1["verifyResponse"] =
			async ({ payload, requestId, userId }) => {
				const envelope = payload as { body: string; signature: string };
				if (
					!timingSafeEqual(
						Buffer.from(envelope.signature, "hex"),
						Buffer.from(signature(envelope.body), "hex"),
					)
				)
					throw new Error("signature");
				const facts = JSON.parse(envelope.body);
				if (
					facts.issuer !== "controlled-identity" ||
					facts.audience !== "worker-test" ||
					facts.deploymentId !== "deployment-test" ||
					facts.keyVersion !== "key-test" ||
					facts.requestId !== requestId ||
					facts.contextId !== requestId ||
					seen.has(facts.contextId) ||
					facts.issuedAt > Date.now() ||
					facts.expiresAt <= Date.now() ||
					facts.user.userId !== userId
				)
					throw new Error("trust");
				seen.add(facts.contextId);
				return facts.user;
			};
		// Fixture transport maps the validated HTTPS destination to loopback HTTP.
		// This exercises real HTTP bytes, not deployment TLS or an actual identity service.
		const directory = createHttpTaskUserDirectoryV1(
			options({
				verifyResponse,
				fetch: async (_url, init) =>
					fetch(`http://127.0.0.1:${port}/current-user`, init),
			}),
		);
		try {
			await expect(directory.resolveUser("user-1")).resolves.toEqual(active);
			mode = "disabled";
			await expect(directory.resolveUser("user-1")).resolves.toMatchObject({
				accountStatus: "disabled",
				authorizationRevision: "identity-2",
			});
			mode = "replay";
			await expect(directory.resolveUser("user-1")).rejects.toThrow(
				"TASK_IDENTITY_UNAVAILABLE",
			);
			mode = "forged";
			await expect(directory.resolveUser("user-1")).rejects.toThrow(
				"TASK_IDENTITY_UNAVAILABLE",
			);
			expect(observedHeaders).toHaveLength(4);
			expect(
				observedHeaders.every(
					(headers) =>
						headers.cookie === undefined &&
						headers.authorization === "Bearer controlled-service-credential",
				),
			).toBe(true);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
