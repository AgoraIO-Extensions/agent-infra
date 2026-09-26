import assert from "node:assert/strict";
import { once } from "node:events";
import { request as requestHttp } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import { startAuthentikPlatformApi } from "../../deploy/local/authentik/platform-api.ts";

async function freePort() {
	const probe = createTcpServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const address = probe.address();
	assert(address && typeof address !== "string");
	const port = address.port;
	await new Promise<void>((resolve, reject) =>
		probe.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}

async function get(
	port: number,
	headers: Record<string, string>,
): Promise<{ status: number; location: string | undefined }> {
	return await new Promise((resolve, reject) => {
		const request = requestHttp(
			{
				hostname: "127.0.0.1",
				port,
				path: "/auth/login",
				headers,
			},
			(response) => {
				response.resume();
				response.once("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						location: response.headers.location,
					}),
				);
			},
		);
		request.once("error", reject);
		request.end();
	});
}

test("TLS-terminating proxy restores the configured public origin for OIDC routes", async () => {
	const port = await freePort();
	const running = await startAuthentikPlatformApi({
		directory: {
			origin: "https://identity.example.test",
			issuer: "https://identity.example.test/application/o/platform/",
			instanceNamespace: "proxy-test",
			apiToken: "synthetic-directory-test-token",
			roleGroups: { employee: [], system_admin: [] },
			organizationGroups: [],
		},
		browser: {
			publicOrigin: "https://localhost:3001",
			issuer: "https://identity.example.test/application/o/platform/",
			authorizationEndpoint:
				"https://identity.example.test/application/o/authorize/",
			tokenEndpoint: "https://identity.example.test/application/o/token/",
			jwksUri: "https://identity.example.test/application/o/jwks/",
			clientId: "platform-test",
			clientSecret: "synthetic-client-secret",
		},
		port,
		runtime: {
			assemblePlatformApi: (() => ({
				dependencies: {},
				close: async () => {},
			})) as never,
			createPlatformApp: (() => ({
				fetch: async () => new Response("fallback"),
			})) as never,
		},
		createAssemblyInput: ({ identity, loadAuthorityContext }) =>
			({ identity, loadAuthorityContext }) as never,
	});
	try {
		const accepted = await get(port, {
			host: "localhost:3001",
			"x-forwarded-proto": "https",
		});
		assert.equal(accepted.status, 302);
		assert.equal(
			new URL(accepted.location ?? "").origin,
			"https://identity.example.test",
		);

		const rejectedHeaders: ReadonlyArray<Record<string, string>> = [
			{ host: "localhost:3001" },
			{ host: "localhost:3001", "x-forwarded-proto": "http" },
			{ host: "attacker.example.test", "x-forwarded-proto": "https" },
		];
		for (const headers of rejectedHeaders) {
			assert.equal((await get(port, headers)).status, 400);
		}
	} finally {
		await running.close();
	}
});
