import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { createAuthentikBrowserAdapter } from "../../deploy/local/authentik/browser.ts";
import type { createAuthentikDirectory } from "../../deploy/local/authentik/directory.ts";

test("OIDC verifies signed claims, binds browser challenge, and resolves current directory", async () => {
	const folder = await mkdtemp(join(tmpdir(), "platform-oidc-test-"));
	const originalCa = getCACertificates("default");
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	let issuer = "";
	let nonce = "";
	let mutation: Record<string, unknown> = {};
	let invalidSignature = false;
	let exchanges = 0;
	let verifier = "";
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=IP:127.0.0.1,DNS:localhost",
			"-keyout",
			join(folder, "key.pem"),
			"-out",
			join(folder, "cert.pem"),
		],
		{ stdio: "ignore" },
	);
	const cert = await readFile(join(folder, "cert.pem"), "utf8");
	setDefaultCACertificates([...originalCa, cert]);
	const server = createServer(
		{ key: await readFile(join(folder, "key.pem")), cert },
		async (request, response) => {
			response.setHeader("Content-Type", "application/json");
			if (request.url === "/jwks") {
				response.end(
					JSON.stringify({
						keys: [
							{
								...keys.publicKey.export({ format: "jwk" }),
								kid: "test",
								use: "sig",
								alg: "RS256",
							},
						],
					}),
				);
				return;
			}
			exchanges++;
			let body = "";
			for await (const chunk of request) body += chunk;
			verifier = new URLSearchParams(body).get("code_verifier") ?? "";
			const encode = (value: unknown) =>
				Buffer.from(JSON.stringify(value)).toString("base64url");
			const payload = `${encode({ alg: "RS256", kid: "test" })}.${encode({ iss: issuer, sub: "verified-subject", aud: "platform-test", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce, ...mutation })}`;
			const signature = sign(
				"RSA-SHA256",
				Buffer.from(payload),
				invalidSignature
					? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
					: keys.privateKey,
			).toString("base64url");
			response.end(
				JSON.stringify({
					access_token: "synthetic-unused",
					token_type: "Bearer",
					id_token: `${payload}.${signature}`,
				}),
			);
		},
	);
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert(address && typeof address !== "string");
		issuer = `https://127.0.0.1:${address.port}`;
		let unavailable = false;
		let revision = "1";
		let lookups = 0;
		const identity = () => ({
			schemaVersion: 1 as const,
			userId: "stable-user",
			displayName: "Test",
			accountStatus: "active" as const,
			organizationIds: ["org"],
			roles: ["employee" as const],
			authorizationRevision: revision,
		});
		const directory = {
			async resolveVerifiedSubject(value: { issuer: string; subject: string }) {
				assert.deepEqual(value, { issuer, subject: "verified-subject" });
				return identity();
			},
			async resolveIdentity(id: string) {
				assert.equal(id, "stable-user");
				lookups++;
				if (unavailable) throw new Error("unavailable");
				return identity();
			},
			async hydrateUsers() {
				return [];
			},
			async resolveUser() {
				return null;
			},
		} as unknown as ReturnType<typeof createAuthentikDirectory>;
		const configuration = {
			publicOrigin: "https://platform.test",
			issuer,
			authorizationEndpoint: `${issuer}/authorize`,
			tokenEndpoint: `${issuer}/token`,
			jwksUri: `${issuer}/jwks`,
			clientId: "platform-test",
			clientSecret: "synthetic-client-secret",
		};
		const adapter = createAuthentikBrowserAdapter(configuration, directory);
		const request = (path: string, cookie?: string) =>
			new Request(`https://platform.test${path}`, {
				headers: cookie ? { cookie } : {},
			});
		async function start() {
			const result = await adapter.handleRequest(request("/auth/login"));
			assert.equal(result?.status, 302);
			const target = new URL(result?.headers.get("location") ?? "");
			assert.equal(target.searchParams.get("code_challenge_method"), "S256");
			nonce = target.searchParams.get("nonce") ?? "";
			return {
				cookie: result?.headers.get("set-cookie")?.split(";")[0] ?? "",
				state: target.searchParams.get("state"),
				challenge: target.searchParams.get("code_challenge"),
			};
		}
		assert.equal(
			await adapter.identityAdapter.resolve(
				new Request("https://platform.test/api", {
					headers: {
						"x-user-id": "stable-user",
						"x-authentik-uid": "verified-subject",
					},
				}),
			),
			null,
		);
		for (const badState of ["", "forged"]) {
			const login = await start();
			assert.equal(
				(
					await adapter.handleRequest(
						request(`/auth/callback?code=test&state=${badState}`, login.cookie),
					)
				)?.status,
				401,
			);
		}
		assert.equal(
			(
				await adapter.handleRequest(
					request("/auth/callback?code=test&state=forged"),
				)
			)?.status,
			401,
		);
		assert.equal(exchanges, 0);
		for (const changes of [
			{ nonce: "wrong" },
			{ iss: "https://wrong.test" },
			{ aud: "wrong" },
			{ exp: 1 },
			{
				iat: Math.floor(Date.now() / 1000) + 86_400,
				exp: Math.floor(Date.now() / 1000) + 86_700,
			},
			{
				iat: Math.floor(Date.now() / 1000),
				exp: Math.floor(Date.now() / 1000),
			},
		]) {
			mutation = changes;
			const login = await start();
			assert.equal(
				(
					await adapter.handleRequest(
						request(
							`/auth/callback?code=test&state=${login.state}`,
							login.cookie,
						),
					)
				)?.status,
				401,
			);
		}
		mutation = {};
		invalidSignature = true;
		let login = await start();
		assert.equal(
			(
				await adapter.handleRequest(
					request(
						`/auth/callback?code=test&state=${login.state}`,
						login.cookie,
					),
				)
			)?.status,
			401,
		);
		invalidSignature = false;
		login = await start();
		const callback = request(
			`/auth/callback?code=test&state=${login.state}`,
			login.cookie,
		);
		const result = await adapter.handleRequest(callback);
		assert.equal(result?.status, 303);
		assert(verifier.length >= 43);
		assert.equal(
			createHash("sha256").update(verifier).digest("base64url"),
			login.challenge,
		);
		const cookies = result?.headers.getSetCookie() ?? [];
		const session = cookies.find((value) =>
			value.startsWith("__Host-platform-session="),
		);
		assert(session?.includes("HttpOnly; Secure; SameSite=Lax; Max-Age=900"));
		const sessionCookie = session?.split(";")[0] ?? "";
		assert.equal((await adapter.handleRequest(callback))?.status, 401);
		assert.equal(
			(await adapter.identityAdapter.resolve(request("/api", sessionCookie)))
				?.authorizationRevision,
			"1",
		);
		revision = "2";
		assert.equal(
			(await adapter.identityAdapter.resolve(request("/api", sessionCookie)))
				?.authorizationRevision,
			"2",
		);
		assert.equal(lookups, 2);
		unavailable = true;
		await assert.rejects(
			adapter.identityAdapter.resolve(request("/api", sessionCookie)),
		);
		unavailable = false;
		assert.equal(
			await createAuthentikBrowserAdapter(
				configuration,
				directory,
			).identityAdapter.resolve(request("/api", sessionCookie)),
			null,
		);
		const confirmation = await adapter.handleRequest(
			request("/auth/logout", sessionCookie),
		);
		assert.equal(confirmation?.status, 200);
		assert.equal(confirmation?.headers.get("cache-control"), "no-store");
		assert.equal(confirmation?.headers.get("set-cookie"), null);
		assert.match(
			confirmation?.headers.get("content-security-policy") ?? "",
			/frame-ancestors 'none'/,
		);
		const html = await confirmation?.text();
		assert.match(html ?? "", /确认退出/);
		assert.match(html ?? "", /'x-platform-csrf':'1'/);
		assert.equal(
			(await adapter.identityAdapter.resolve(request("/api", sessionCookie)))
				?.authorizationRevision,
			"2",
		);

		assert.equal(
			(
				await adapter.handleRequest(
					new Request("https://platform.test/auth/logout", {
						method: "POST",
						headers: {
							cookie: sessionCookie,
							origin: "https://evil.test",
							"x-platform-csrf": "1",
						},
					}),
				)
			)?.status,
			403,
		);
		assert.equal(
			(
				await adapter.handleRequest(
					new Request("https://platform.test/auth/logout", {
						method: "POST",
						headers: {
							cookie: sessionCookie,
							origin: "https://platform.test",
							"x-platform-csrf": "1",
						},
					}),
				)
			)?.status,
			204,
		);
		assert.equal(
			await adapter.identityAdapter.resolve(request("/api", sessionCookie)),
			null,
		);
		assert.equal(
			(
				await adapter.handleRequest(
					request("/auth/login?returnTo=https://evil.test"),
				)
			)?.status,
			400,
		);
		login = await start();
		const expiring = await adapter.handleRequest(
			request(`/auth/callback?code=test&state=${login.state}`, login.cookie),
		);
		assert.equal(expiring?.status, 303);
		const expiringCookie = expiring?.headers
			.getSetCookie()
			.find((value) => value.startsWith("__Host-platform-session="))
			?.split(";")[0];
		login = await start();
		const currentTime = Date.now();
		mock.method(Date, "now", () => currentTime + 16 * 60_000);
		assert.equal(
			await adapter.identityAdapter.resolve(request("/api", expiringCookie)),
			null,
		);
		assert.equal(
			(
				await adapter.handleRequest(
					request(
						`/auth/callback?code=test&state=${login.state}`,
						login.cookie,
					),
				)
			)?.status,
			401,
		);
		mock.restoreAll();
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		setDefaultCACertificates(originalCa);
		await rm(folder, { recursive: true, force: true });
	}
});
