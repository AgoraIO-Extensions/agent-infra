import {
	createHash,
	createHmac,
	generateKeyPairSync,
	randomUUID,
	sign,
} from "node:crypto";
import {
	auditEvents,
	clientCredentials,
	consumerInstances,
	consumers,
	createConnectionClientRepository,
	createConnectionDatabase,
	migrateConnectionDatabase,
	principals,
} from "@agent-infra/connection-store";
import { DirectOAuthErrorV1Schema } from "@agent-infra/contracts/pilot";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/connection-store/src/postgres-test.js";
import { createConnectionApp } from "./app.js";
import type { ConnectionAuthDependencies } from "./auth.js";
import { authenticateDirectClient } from "./client.js";

const origin = "https://connection.example.test";
const redirectUri = "https://client.example.test/callback";
const audience = `${origin}/mcp`;
const csrfKey = Buffer.alloc(32, 19);
const aliceCookie = "a".repeat(43);
const aliceOtherCookie = "c".repeat(43);
const bobCookie = "b".repeat(43);
const { privateKey, publicKey } = generateKeyPairSync("ec", {
	namedCurve: "P-256",
});
const otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });

let testDatabase: PostgresTestDatabase | undefined;
let database: ReturnType<typeof createConnectionDatabase> | undefined;

function dpop(
	path: string,
	options: {
		method?: string;
		token?: string;
		key?: typeof privateKey;
		publicJwk?: typeof jwk;
		jti?: string;
	} = {},
) {
	const header = Buffer.from(
		JSON.stringify({
			typ: "dpop+jwt",
			alg: "ES256",
			jwk: options.publicJwk ?? jwk,
		}),
	).toString("base64url");
	const claims = Buffer.from(
		JSON.stringify({
			htm: options.method ?? "POST",
			htu: `${origin}${path}`,
			iat: Math.floor(Date.now() / 1000),
			jti: options.jti ?? randomUUID(),
			...(options.token
				? {
						ath: createHash("sha256").update(options.token).digest("base64url"),
					}
				: {}),
		}),
	).toString("base64url");
	const payload = `${header}.${claims}`;
	const signature = sign("sha256", Buffer.from(payload), {
		key: options.key ?? privateKey,
		dsaEncoding: "ieee-p1363",
	}).toString("base64url");
	return `${payload}.${signature}`;
}

function browserHeaders(cookie = aliceCookie) {
	return {
		cookie: `__Host-connection_session=${cookie}`,
		origin,
		"sec-fetch-site": "same-origin",
		"x-csrf-token": createHmac("sha256", csrfKey)
			.update(cookie)
			.digest("base64url"),
	};
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase(
		"connection-client-installation",
	);
	await migrateConnectionDatabase(testDatabase.databaseUrl);
	database = createConnectionDatabase(testDatabase.databaseUrl);
	await database.db.insert(principals).values([
		{ id: "alice", issuer: "ldap", uid: "alice" },
		{ id: "bob", issuer: "ldap", uid: "bob" },
	]);
	await database.db.insert(consumers).values({
		id: "client",
		name: "Direct Client",
		actorRequired: true,
		redirectUris: [redirectUri],
		allowedScopes: ["action:read", "pat:issue"],
		patApproved: true,
	});
}, 120_000);

afterAll(async () => {
	await database?.close();
	await testDatabase?.stop();
});

it("binds OAuth, PAT and each call to one installation, rotates refresh and rejects replay/revocation", async () => {
	if (!database) throw new Error("Test database is unavailable");
	const repository = createConnectionClientRepository(database.db);
	const auth: ConnectionAuthDependencies = {
		service: {
			async login() {
				throw new Error("Unused in installation test");
			},
			async currentSession(token) {
				const id =
					token === aliceCookie || token === aliceOtherCookie
						? "alice"
						: token === bobCookie
							? "bob"
							: null;
				return id
					? {
							id,
							issuer: "ldap",
							uid: id,
							status: "active" as const,
							recoveryGeneration: 1,
						}
					: undefined;
			},
			async logout() {
				return undefined;
			},
		},
		publicOrigin: origin,
		csrfKey,
		source: () => "127.0.0.1",
	};
	const client = {
		repository,
		auth,
		audience,
		recheckPrincipal: async (principalId: string) => {
			if (principalId !== "alice") throw new Error("Unexpected Principal");
		},
	};
	const app = createConnectionApp(auth, client);
	app.get("/probe", async (context) => {
		try {
			return context.json(
				await authenticateDirectClient(context, client, "action:read"),
			);
		} catch {
			return context.json({ error: "denied" }, 401);
		}
	});
	app.get("/wrong-audience", async (context) => {
		try {
			await authenticateDirectClient(
				context,
				{ ...client, audience: `${origin}/other` },
				"action:read",
			);
			return context.json({ accepted: true });
		} catch {
			return context.json({ error: "denied" }, 401);
		}
	});
	const verifier = "v".repeat(64);
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const installationBody = {
		client_id: "client",
		redirect_uri: redirectUri,
		state: "state-from-client-123",
		code_challenge: challenge,
		code_challenge_method: "S256",
		scope: "action:read pat:issue",
	};
	const install = await app.request("/oauth/install", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			dpop: dpop("/oauth/install"),
		},
		body: JSON.stringify(installationBody),
	});
	expect(install.status).toBe(201);
	const { authorization_uri: authorizationUri } = (await install.json()) as {
		authorization_uri: string;
	};
	const path = new URL(authorizationUri).pathname;
	const installationId = path.split("/").at(-1) ?? "";
	const [requested] = (await database.db.select().from(auditEvents)).filter(
		(row) => row.action === "oauth.installation_requested",
	);
	expect(requested?.targetId).toBe(
		createHash("sha256").update(installationId).digest("hex"),
	);
	expect(
		(
			await app.request(path, {
				headers: { cookie: `__Host-connection_session=${aliceCookie}` },
			})
		).status,
	).toBe(403);
	expect(
		(
			await app.request(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...browserHeaders(bobCookie),
				},
				body: JSON.stringify({ approve: true }),
			})
		).status,
	).toBe(401);
	expect((await app.request(path, { headers: browserHeaders() })).status).toBe(
		200,
	);
	const wrongPrincipal = await app.request(path, {
		headers: browserHeaders(bobCookie),
	});
	expect(wrongPrincipal.status).toBe(401);
	expect(DirectOAuthErrorV1Schema.parse(await wrongPrincipal.json())).toEqual(
		expect.objectContaining({
			error: "invalid_grant",
			message: "Authorization denied",
			retryable: false,
		}),
	);
	expect(
		(await app.request(path, { headers: browserHeaders(aliceOtherCookie) }))
			.status,
	).toBe(401);
	expect(
		(
			await app.request(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...browserHeaders(bobCookie),
				},
				body: JSON.stringify({ approve: true }),
			})
		).status,
	).toBe(401);
	expect(
		(
			await app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json", ...browserHeaders() },
				body: JSON.stringify({ approve: true, principalId: "bob" }),
			})
		).status,
	).toBe(400);
	const approve = await app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...browserHeaders() },
		body: JSON.stringify({ approve: true }),
	});
	expect(approve.status).toBe(303);
	expect(approve.headers.get("cache-control")).toBe("no-store");
	const redirect = new URL(approve.headers.get("location") ?? "");
	expect(redirect.origin + redirect.pathname).toBe(redirectUri);
	expect(redirect.searchParams.get("state")).toBe(installationBody.state);
	const code = redirect.searchParams.get("code") ?? "";
	expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(
		(
			await app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json", ...browserHeaders() },
				body: JSON.stringify({ approve: true }),
			})
		).status,
	).toBe(401);
	const tokenForm = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: "client",
		code,
		code_verifier: verifier,
		redirect_uri: redirectUri,
	});
	const tokenRequest = async (proof: string, form = tokenForm) =>
		app.request("/oauth/token", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				dpop: proof,
			},
			body: form.toString(),
		});
	const withAuthority = new URLSearchParams(tokenForm);
	withAuthority.set("principalId", "bob");
	expect((await tokenRequest(dpop("/oauth/token"), withAuthority)).status).toBe(
		400,
	);
	const duplicateClient = new URLSearchParams(tokenForm);
	duplicateClient.append("client_id", "other");
	expect(
		(await tokenRequest(dpop("/oauth/token"), duplicateClient)).status,
	).toBe(400);
	expect(
		(
			await tokenRequest(
				dpop("/oauth/token", {
					key: otherKey.privateKey,
					publicJwk: otherKey.publicKey.export({ format: "jwk" }),
				}),
			)
		).status,
	).toBe(401);
	const tokenResponse = await tokenRequest(dpop("/oauth/token"));
	expect(tokenResponse.status).toBe(200);
	const tokens = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		token_type: string;
	};
	expect(tokens.token_type).toBe("DPoP");
	expect((await tokenRequest(dpop("/oauth/token"))).status).toBe(401);
	const probe = (
		token: string,
		proof = dpop("/probe", { method: "GET", token }),
	) =>
		app.request("/probe", {
			headers: { authorization: `DPoP ${token}`, dpop: proof },
		});
	const authorized = await probe(tokens.access_token);
	expect(authorized.status).toBe(200);
	expect(await authorized.json()).toMatchObject({
		principalId: "alice",
		consumerId: "client",
	});
	const reusedProof = dpop("/probe", {
		method: "GET",
		token: tokens.access_token,
	});
	expect((await probe(tokens.access_token, reusedProof)).status).toBe(200);
	expect((await probe(tokens.access_token, reusedProof)).status).toBe(401);
	expect(
		(
			await app.request("/wrong-audience", {
				headers: {
					authorization: `DPoP ${tokens.access_token}`,
					dpop: dpop("/wrong-audience", {
						method: "GET",
						token: tokens.access_token,
					}),
				},
			})
		).status,
	).toBe(401);
	expect(
		(
			await probe(
				tokens.access_token,
				dpop("/probe", {
					method: "GET",
					token: tokens.access_token,
					key: otherKey.privateKey,
					publicJwk: otherKey.publicKey.export({ format: "jwk" }),
				}),
			)
		).status,
	).toBe(401);
	const patResponse = await app.request("/oauth/pat", {
		method: "POST",
		headers: {
			authorization: `DPoP ${tokens.access_token}`,
			dpop: dpop("/oauth/pat", { token: tokens.access_token }),
		},
	});
	expect(patResponse.status).toBe(201);
	const pat = (await patResponse.json()) as { token: string; id: string };
	expect((await probe(pat.token)).status).toBe(200);
	const secondPatResponse = await app.request("/oauth/pat", {
		method: "POST",
		headers: {
			authorization: `DPoP ${tokens.access_token}`,
			dpop: dpop("/oauth/pat", { token: tokens.access_token }),
		},
	});
	expect(secondPatResponse.status).toBe(201);
	const secondPat = (await secondPatResponse.json()) as {
		token: string;
		id: string;
	};
	expect(
		(
			await app.request(`/oauth/pats/${pat.id}/revoke`, {
				method: "POST",
				headers: browserHeaders(),
			})
		).status,
	).toBe(204);
	expect((await probe(pat.token)).status).toBe(401);
	expect((await probe(secondPat.token)).status).toBe(200);
	const rotatedPatResponse = await app.request("/oauth/pat/rotate", {
		method: "POST",
		headers: {
			authorization: `DPoP ${secondPat.token}`,
			dpop: dpop("/oauth/pat/rotate", { token: secondPat.token }),
		},
	});
	expect(rotatedPatResponse.status).toBe(200);
	const rotatedPat = (await rotatedPatResponse.json()) as {
		token: string;
		id: string;
	};
	expect((await probe(secondPat.token)).status).toBe(401);
	expect((await probe(rotatedPat.token)).status).toBe(200);
	const refreshForm = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: "client",
		refresh_token: tokens.refresh_token,
	});
	const rotated = await tokenRequest(dpop("/oauth/token"), refreshForm);
	expect(rotated.status).toBe(200);
	const next = (await rotated.json()) as {
		access_token: string;
		refresh_token: string;
	};
	expect(next.refresh_token).not.toBe(tokens.refresh_token);
	expect((await probe(next.access_token)).status).toBe(200);
	expect((await tokenRequest(dpop("/oauth/token"), refreshForm)).status).toBe(
		401,
	);
	expect((await probe(next.access_token)).status).toBe(401);
	expect((await probe(rotatedPat.token)).status).toBe(200);
	const [instance] = await database.db.select().from(consumerInstances);
	expect(instance?.id).toBeTruthy();
	expect(
		(
			await app.request(`/oauth/instances/${instance?.id}/revoke`, {
				method: "POST",
				headers: browserHeaders(bobCookie),
			})
		).status,
	).toBe(401);
	expect(
		(
			await app.request(`/oauth/instances/${instance?.id}/revoke`, {
				method: "POST",
				headers: browserHeaders(),
			})
		).status,
	).toBe(204);
	expect((await probe(rotatedPat.token)).status).toBe(401);
	const stored = (await database.db.select().from(clientCredentials)).find(
		(row) => row.id === rotatedPat.id,
	);
	expect(stored?.tokenHash).toBe(
		createHash("sha256").update(rotatedPat.token).digest("hex"),
	);
	const audit = (await database.db.select().from(auditEvents)).filter(
		(row) => row.action === "oauth.refresh_replayed",
	);
	expect(audit).toHaveLength(1);
});
