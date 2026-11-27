import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import { createProtectedConnectionInstallationForwarder } from "./connection-installation-callback-forwarder.js";
import { registerConnectionInstallationCallbackRoutesV1 } from "./http/connection-installation-callback-routes.js";

const target = {
	authorizationId: "authorization-a",
	runtimeOrigin: "https://runtime.test:3443/",
	callbackPath: "/internal/runtime/oauth/v1/callback" as const,
	attemptId: "attempt-a",
	expiresAt: Date.now() + 60_000,
	issuer: "https://connection.test/",
};
const request = {
	schemaVersion: 1 as const,
	code: "code-a",
	issuer: "https://connection.test/",
	state: "a".repeat(64),
};

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "callback-forwarder-"));
	const path = join(directory, "callback.auth");
	await writeFile(path, "callback-secret-material");
	await chmod(path, 0o600);
	return { directory, path };
}

describe("the protected callback route to the original TLS Host", () => {
	let auth: Awaited<ReturnType<typeof fixture>>;
	let host: Awaited<ReturnType<typeof runtimeTlsFixture>>;
	let other: Awaited<ReturnType<typeof runtimeTlsFixture>>;
	let server: ReturnType<typeof createServer>;
	let port: number;
	let replyStatus: number;
	let replyAuthorizationId: string;
	const received: {
		method?: string;
		path?: string;
		authorization?: string;
		body: string;
	}[] = [];

	beforeAll(async () => {
		auth = await fixture();
		host = await runtimeTlsFixture();
		other = await runtimeTlsFixture();
		server = createServer(
			{ key: host.key, cert: host.cert },
			async (req, res) => {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(chunk);
				received.push({
					method: req.method,
					path: req.url,
					authorization: req.headers.authorization,
					body: Buffer.concat(chunks).toString("utf8"),
				});
				res.writeHead(replyStatus, {
					"content-type": "application/json",
					...(replyStatus === 307 ? { location: "/redirected" } : {}),
				});
				res.end(
					JSON.stringify({
						schemaVersion: 1,
						authorizationId: replyAuthorizationId,
						phase: "awaiting_confirmation",
						expiresAt: Date.now() + 60_000,
					}),
				);
			},
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		port = (server.address() as AddressInfo).port;
	});
	beforeEach(async () => {
		received.length = 0;
		replyStatus = 200;
		replyAuthorizationId = target.authorizationId;
		await chmod(auth.path, 0o600);
	});
	afterAll(async () => {
		server?.closeAllConnections();
		if (server?.listening)
			await new Promise<void>((resolve) => server.close(() => resolve()));
		await host?.cleanup();
		await other?.cleanup();
		if (auth) await rm(auth.directory, { recursive: true, force: true });
	});

	async function callback(hostname: string, hostCaFile?: string) {
		const app = new Hono();
		const settle = vi.fn(async () => true);
		const claim = async () => ({
			...target,
			runtimeOrigin: `https://${hostname}:${port}/`,
			expiresAt: Date.now() + 60_000,
		});
		const callbackUrl = "https://platform.test/connection/callback";
		registerConnectionInstallationCallbackRoutesV1(app, {
			publicOrigin: "https://platform.test",
			callbackUrl,
			issuer: target.issuer,
			installation: { callback: { claim, settle } } as never,
			forward: createProtectedConnectionInstallationForwarder({
				authFile: auth.path,
				hostCaFile,
			}),
		});
		const query = new URLSearchParams({
			code: request.code,
			iss: request.issuer,
			state: request.state,
		});
		const result = await app.request(`${callbackUrl}?${query}`);
		return { status: result.status, settle };
	}

	it("sends one authenticated callback and settles the original attempt as delivered", async () => {
		const { status, settle } = await callback(
			"localhost",
			join(host.directory, "ca.crt"),
		);
		expect(status).toBe(204);
		expect(settle).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				attemptId: target.attemptId,
				status: "delivered",
			}),
		);
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			method: "POST",
			path: target.callbackPath,
			authorization: "Bearer callback-secret-material",
		});
		expect(received.map(({ body }) => JSON.parse(body))).toEqual([request]);
	});

	it("rejects untrusted certificates, incorrect hostnames and unreadable CA files before sending", async () => {
		const caFile = join(host.directory, "ca.crt");
		for (const [hostname, ca] of [
			["localhost", join(other.directory, "ca.crt")],
			["127.0.0.1", caFile],
			["localhost", join(host.directory, "missing.crt")],
			["localhost", undefined],
		] as const) {
			const { status, settle } = await callback(hostname, ca);
			expect(status).toBe(503);
			expect(settle).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					attemptId: target.attemptId,
					status: "unknown",
				}),
			);
		}
		expect(received).toHaveLength(0);
	});

	it.each([
		[421, target.authorizationId],
		[307, target.authorizationId],
		[200, "foreign"],
	] as const)(
		"settles an unsuccessful Host reply (%i, %s) as unknown after a single POST",
		async (statusCode, authorizationId) => {
			replyStatus = statusCode;
			replyAuthorizationId = authorizationId;
			const { status, settle } = await callback(
				"localhost",
				join(host.directory, "ca.crt"),
			);
			expect(status).toBe(503);
			expect(received).toHaveLength(1);
			expect(settle).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					attemptId: target.attemptId,
					status: "unknown",
				}),
			);
		},
	);

	it("rejects a callback credential file with overly broad permissions", async () => {
		await chmod(auth.path, 0o644);
		const { status } = await callback(
			"localhost",
			join(host.directory, "ca.crt"),
		);
		expect(status).toBe(503);
		expect(received).toHaveLength(0);
	});
});

it.each(["wrong-callback", "http://runtime.test:3443/"])(
	"rejects an unapproved target (%s)",
	async (value) => {
		const f = await fixture();
		try {
			const forward = createProtectedConnectionInstallationForwarder({
				authFile: f.path,
			});
			await expect(
				forward({
					target: {
						...target,
						...(value.startsWith("http")
							? { runtimeOrigin: value }
							: { callbackPath: value as never }),
					},
					callbackPath: target.callbackPath,
					request,
					signal: new AbortController().signal,
				}),
			).rejects.toThrow();
		} finally {
			await rm(f.directory, { recursive: true, force: true });
		}
	},
);
