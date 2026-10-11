import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
