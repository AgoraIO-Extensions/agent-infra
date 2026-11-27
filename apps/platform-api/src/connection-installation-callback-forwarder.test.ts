import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import { createProtectedConnectionInstallationForwarder } from "./connection-installation-callback-forwarder.js";

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

it("delivers only to the original Host with its configured CA and verified hostname", async () => {
	const auth = await fixture();
	const host = await runtimeTlsFixture();
	const other = await runtimeTlsFixture();
	const received: {
		method?: string;
		path?: string;
		authorization?: string;
		body: unknown;
	}[] = [];
	const server = createServer(
		{ key: host.key, cert: host.cert },
		async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk);
			received.push({
				method: req.method,
				path: req.url,
				authorization: req.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					schemaVersion: 1,
					authorizationId: target.authorizationId,
					phase: "awaiting_confirmation",
					expiresAt: Date.now() + 60_000,
				}),
			);
		},
	);
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address() as AddressInfo;
		const send = (hostname: string, hostCaFile?: string) =>
			createProtectedConnectionInstallationForwarder({
				authFile: auth.path,
				hostCaFile,
			})({
				target: {
					...target,
					runtimeOrigin: `https://${hostname}:${port}/`,
					expiresAt: Date.now() + 60_000,
				},
				callbackPath: target.callbackPath,
				request,
				signal: AbortSignal.timeout(5_000),
			});
		const caFile = join(host.directory, "ca.crt");
		await expect(send("localhost", caFile)).resolves.toBeUndefined();
		expect(received).toEqual([
			{
				method: "POST",
				path: target.callbackPath,
				authorization: "Bearer callback-secret-material",
				body: request,
			},
		]);
		await expect(
			send("localhost", join(other.directory, "ca.crt")),
		).rejects.toThrow();
		await expect(send("127.0.0.1", caFile)).rejects.toThrow();
		await expect(
			send("localhost", join(host.directory, "missing.crt")),
		).rejects.toThrow();
		await expect(send("localhost")).rejects.toThrow();
		expect(received).toHaveLength(1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await Promise.all([
			host.cleanup(),
			other.cleanup(),
			rm(auth.directory, { recursive: true, force: true }),
		]);
	}
});

it("reads a protected callback credential and posts only to the fixed Runtime callback", async () => {
	const f = await fixture();
	try {
		let received: { url: string; init?: RequestInit } | undefined;
		const forward = createProtectedConnectionInstallationForwarder({
			authFile: f.path,
			fetch: async (url, init) => {
				received = { url: String(url), init };
				return Response.json({
					schemaVersion: 1,
					authorizationId: target.authorizationId,
					phase: "awaiting_confirmation",
					expiresAt: target.expiresAt,
				});
			},
		});
		await forward({
			target,
			callbackPath: target.callbackPath,
			request,
			signal: new AbortController().signal,
		});
		expect(received?.url).toBe(
			"https://runtime.test:3443/internal/runtime/oauth/v1/callback",
		);
		expect(received?.init?.redirect).toBe("error");
		const headers = received?.init?.headers as
			| Record<string, string>
			| undefined;
		expect(headers?.authorization).toBe("Bearer callback-secret-material");
		expect(String(received?.init?.body)).not.toContain(
			"callback-secret-material",
		);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
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

it("fails closed when the protected file permissions are too broad or the Runtime response is foreign", async () => {
	const f = await fixture();
	try {
		await chmod(f.path, 0o644);
		const denied = createProtectedConnectionInstallationForwarder({
			authFile: f.path,
		});
		await expect(
			denied({
				target,
				callbackPath: target.callbackPath,
				request,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow();
		await chmod(f.path, 0o600);
		const foreign = createProtectedConnectionInstallationForwarder({
			authFile: f.path,
			fetch: async () =>
				Response.json({
					schemaVersion: 1,
					authorizationId: "foreign",
					phase: "awaiting_confirmation",
					expiresAt: target.expiresAt,
				}),
		});
		await expect(
			foreign({
				target,
				callbackPath: target.callbackPath,
				request,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow();
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});
