import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createTrustedProxyVerifier } from "../trusted-proxy.js";
import { registerConnectionInstallationCallbackRoutesV1 } from "./connection-installation-callback-routes.js";

const publicOrigin = "https://platform.test";
const callbackPath = "/api/connection-installations/callback";
const query = `?code=synthetic-code&iss=https%3A%2F%2Fconnection.test%2F&state=${"a".repeat(64)}`;
const proxyToken = randomBytes(32).toString("base64url");
const headers = {
	host: "platform.test",
	"x-forwarded-proto": "https",
	"x-platform-proxy-token": proxyToken,
};
function fixture(
	options: { verifier?: boolean; expired?: boolean; mapped?: boolean } = {},
) {
	const claim = vi.fn(async () =>
		options.mapped === false
			? null
			: {
					authorizationId: "authorization-proxy",
					runtimeOrigin: "https://runtime.test:3443/",
					callbackPath: "/internal/runtime/oauth/v1/callback" as const,
					attemptId: "attempt-proxy",
					expiresAt: options.expired ? Date.now() - 1 : Date.now() + 60_000,
					issuer: "https://connection.test/",
				},
	);
	const settle = vi.fn(async () => true);
	const forward = vi.fn(async () => undefined);
	const app = new Hono();
	registerConnectionInstallationCallbackRoutesV1(app, {
		publicOrigin,
		callbackUrl: publicOrigin + callbackPath,
		issuer: "https://connection.test/",
		installation: { callback: { claim, settle } } as never,
		forward,
		...(options.verifier === false
			? {}
			: { isTrustedProxyRequest: createTrustedProxyVerifier(proxyToken) }),
	});
	return { app, claim, settle, forward };
}

it("accepts the registered HTTPS callback after the trusted proxy forwards it over HTTP", async () => {
	const f = fixture();
	const server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw Error("missing address");
		const status = await new Promise<number>((resolve, reject) => {
			const request = httpRequest(
				`http://127.0.0.1:${address.port}${callbackPath}${query}`,
				{ headers },
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				},
			);
			request.on("error", reject);
			request.end();
		});
		expect(status).toBe(204);
		expect(f.claim).toHaveBeenCalledOnce();
		expect(f.forward).toHaveBeenCalledOnce();
		expect(f.settle).toHaveBeenCalledWith(
			expect.objectContaining({ status: "delivered" }),
		);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

it.each([
	["missing proof", { ...headers, "x-platform-proxy-token": "" }],
	[
		"wrong same-length proof",
		{ ...headers, "x-platform-proxy-token": "x".repeat(43) },
	],
	["wrong-length proof", { ...headers, "x-platform-proxy-token": "short" }],
	["no Host", { ...headers, host: "" }],
	["alias Host", { ...headers, host: "alias.platform.test" }],
	["wrong port", { ...headers, host: "platform.test:8443" }],
	["wrong scheme", { ...headers, "x-forwarded-proto": "http" }],
	["scheme list", { ...headers, "x-forwarded-proto": "https,http" }],
	[
		"forged Forwarded",
		{
			host: "foreign.test",
			forwarded: "host=platform.test;proto=https",
			"x-forwarded-host": "platform.test",
			"x-forwarded-proto": "https",
		},
	],
	[
		"forwarded Host cannot replace Host",
		{ ...headers, host: "foreign.test", "x-forwarded-host": "platform.test" },
	],
])(
	"rejects %s before claiming an HTTP callback",
	async (_name, incomingHeaders) => {
		const f = fixture();
		const response = await f.app.request(
			`http://internal-api:3000${callbackPath}${query}`,
			{ headers: incomingHeaders },
		);
		expect(response.status).toBe(400);
		expect(f.claim).not.toHaveBeenCalled();
		expect(f.forward).not.toHaveBeenCalled();
	},
);

it("does not trust headers when the deployment has no proxy verifier", async () => {
	const f = fixture({ verifier: false });
	expect(
		(
			await f.app.request(`http://internal-api:3000${callbackPath}${query}`, {
				headers,
			})
		).status,
	).toBe(400);
	expect(f.claim).not.toHaveBeenCalled();
});

it("retains direct HTTPS exact-origin behavior", async () => {
	const f = fixture({ verifier: false });
	expect(
		(await f.app.request(publicOrigin + callbackPath + query)).status,
	).toBe(204);
});

it.each([
	query + "&state=" + "b".repeat(64),
	query.replace("connection.test", "foreign.test"),
	query + "&actorId=other",
	query + "&agentId=other",
	query + "&runtimeOrigin=https%3A%2F%2Fforeign.test",
])(
	"retains strict callback parsing after proxy verification",
	async (search) => {
		const f = fixture();
		expect(
			(
				await f.app.request(
					`http://internal-api:3000${callbackPath}${search}`,
					{ headers },
				)
			).status,
		).toBe(400);
		expect(f.claim).not.toHaveBeenCalled();
		expect(f.forward).not.toHaveBeenCalled();
	},
);

it.each([{ expired: true }, { mapped: false }])(
	"does not forward expired or unmapped bindings (%j)",
	async (options) => {
		const f = fixture(options);
		expect(
			(
				await f.app.request(`http://internal-api:3000${callbackPath}${query}`, {
					headers,
				})
			).status,
		).toBe(404);
		expect(f.forward).not.toHaveBeenCalled();
	},
);

it("does not replay a consumed callback through the proxy", async () => {
	const f = fixture();
	const request = () =>
		f.app.request(`http://internal-api:3000${callbackPath}${query}`, {
			headers,
		});
	expect((await request()).status).toBe(204);
	f.claim.mockResolvedValueOnce(null);
	expect((await request()).status).toBe(404);
	expect(f.forward).toHaveBeenCalledOnce();
});

it.each(["", "short", "x".repeat(129), "x".repeat(43) + "\n"])(
	"rejects invalid proxy configuration without including its value",
	(token) => {
		expect(() => createTrustedProxyVerifier(token)).toThrowError(
			/^BROWSER_SESSION_PROXY_CONFIGURATION_INVALID$/,
		);
	},
);
