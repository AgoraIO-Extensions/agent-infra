import {
	createHash,
	createHmac,
	generateKeyPairSync,
	randomUUID,
	sign,
} from "node:crypto";
import {
	actionCalls,
	actionVersions,
	actors,
	auditEvents,
	clientCredentials,
	connections,
	consumerInstances,
	consumers,
	createConnectionAuthorityRepository,
	createConnectionClientRepository,
	createConnectionDatabase,
	credentialVersions,
	grants,
	mcpCallBindings,
	migrateConnectionDatabase,
	principals,
	providerReleases,
	providers,
} from "@agent-infra/connection-store";
import {
	DirectActionReferenceV1Schema,
	DirectActionReservationV1Schema,
	DirectClientCallRecordV1Schema,
	DirectClientIdentityV1Schema,
	DirectMcpExecuteActionResponseV1Schema,
	DirectOAuthErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
		allowedScopes: ["action:read", "calls:read", "pat:issue"],
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
		authority: createConnectionAuthorityRepository(database.db),
		auth,
		audience,
		recheckPrincipal: async (principalId: string) => {
			if (principalId !== "alice" && principalId !== "bob")
				throw new Error("Unexpected Principal");
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
		scope: "action:read calls:read pat:issue",
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
	const [installedActor] = await database.db.select().from(actors);
	const [installedInstance] = await database.db
		.select()
		.from(consumerInstances);
	if (!installedActor || !installedInstance)
		throw new Error("Installation binding was not persisted");
	await database.db
		.insert(providers)
		.values({ id: "provider", name: "Provider" });
	await database.db.insert(providerReleases).values({
		id: "release",
		providerId: "provider",
		version: "v1",
		status: "active",
	});
	await database.db.insert(actionVersions).values([
		{
			id: "action-v1",
			providerId: "provider",
			providerReleaseId: "release",
			actionId: "read-issue",
			version: "v1",
			effect: "read",
			inputSchema: {
				type: "object",
				properties: { repositoryId: { type: "integer" } },
				required: ["repositoryId"],
				additionalProperties: false,
			},
			outputSchema: { type: "object" },
			requiredScopes: ["action:read"],
			status: "published",
		},
		{
			id: "action-v2",
			providerId: "provider",
			providerReleaseId: "release",
			actionId: "read-issue",
			version: "v2",
			effect: "read",
			inputSchema: {
				type: "object",
				properties: { issueNumber: { type: "integer" } },
				required: ["issueNumber"],
				additionalProperties: false,
			},
			outputSchema: { type: "object" },
			requiredScopes: ["action:read"],
			status: "published",
		},
		{
			id: "action-v3",
			providerId: "provider",
			providerReleaseId: "release",
			actionId: "read-issue",
			version: "v3",
			effect: "read",
			inputSchema: {
				type: "object",
				properties: { issueNumber: { type: "integer" } },
				required: ["issueNumber"],
				additionalProperties: false,
			},
			outputSchema: { type: "object" },
			requiredScopes: ["provider:read"],
			status: "published",
		},
	]);
	await database.db.insert(connections).values({
		id: "connection",
		providerId: "provider",
		externalAccountId: "test-account",
	});
	await database.db.insert(credentialVersions).values({
		id: "provider-credential-v1",
		connectionId: "connection",
		version: 1,
		ciphertext: "test-fixture-ciphertext",
	});
	await database.db
		.update(connections)
		.set({ currentCredentialVersionId: "provider-credential-v1" });
	await database.db.insert(grants).values({
		id: "grant",
		principalId: "alice",
		consumerId: "client",
		consumerInstanceId: installedInstance.id,
		actorId: installedActor.id,
		connectionId: "connection",
		credentialVersionId: "provider-credential-v1",
		approvedActionVersionIds: ["action-v1", "action-v2", "action-v3"],
		principalRecoveryGeneration: 1,
		expiresAt: new Date(Date.now() + 60_000),
	});
	const actionRequest = {
		schemaVersion: 1,
		requestId: "request-action-1",
		idempotencyKey: "action-key-1",
		traceId: "trace-action-1",
		action: {
			providerId: "provider",
			actionId: "read-issue",
			actionVersion: "v1",
			arguments: { repositoryId: 7 },
		},
	};
	const reserve = (body: unknown, key = privateKey) =>
		app.request("/api/v1/actions", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `DPoP ${tokens.access_token}`,
				dpop: dpop("/api/v1/actions", {
					token: tokens.access_token,
					key,
					publicJwk:
						key === privateKey
							? jwk
							: otherKey.publicKey.export({ format: "jwk" }),
				}),
			},
			body: JSON.stringify(body),
		});
	const firstReservation = await reserve(actionRequest);
	expect(firstReservation.status).toBe(202);
	const receipt = DirectActionReservationV1Schema.parse(
		await firstReservation.json(),
	);
	expect((await reserve(actionRequest)).status).toBe(202);
	expect(
		DirectActionReservationV1Schema.parse(
			await (await reserve(actionRequest)).json(),
		).callId,
	).toBe(receipt.callId);
	expect(
		(
			await reserve({
				...actionRequest,
				action: {
					...actionRequest.action,
					arguments: { repositoryId: 8 },
				},
			})
		).status,
	).toBe(409);
	expect(
		(
			await reserve({
				...actionRequest,
				action: {
					...actionRequest.action,
					arguments: { repositoryId: "invalid" },
				},
			})
		).status,
	).toBe(400);
	const parallelRequest = {
		...actionRequest,
		requestId: "request-action-parallel",
		idempotencyKey: "action-key-parallel",
	};
	const parallel = await Promise.all([
		reserve(parallelRequest),
		reserve(parallelRequest),
	]);
	expect(parallel.map((response) => response.status)).toEqual([202, 202]);
	expect(
		DirectActionReservationV1Schema.parse(await parallel[0]?.json()).callId,
	).toBe(
		DirectActionReservationV1Schema.parse(await parallel[1]?.json()).callId,
	);
	const competingRequest = {
		...actionRequest,
		requestId: "request-action-competing",
		idempotencyKey: "action-key-competing",
	};
	const competing = await Promise.all([
		reserve(competingRequest),
		reserve({
			...competingRequest,
			action: {
				...competingRequest.action,
				arguments: { repositoryId: 8 },
			},
		}),
	]);
	expect(competing.map((response) => response.status).sort()).toEqual([
		202, 409,
	]);
	expect((await reserve({ ...actionRequest, principalId: "bob" })).status).toBe(
		400,
	);
	expect((await reserve(actionRequest, otherKey.privateKey)).status).toBe(401);
	const actionPath = `/api/v1/actions/${receipt.callId}`;
	const actionReference = await app.request(actionPath, {
		headers: {
			authorization: `DPoP ${tokens.access_token}`,
			dpop: dpop(actionPath, {
				method: "GET",
				token: tokens.access_token,
			}),
		},
	});
	expect(actionReference.status).toBe(200);
	expect(
		DirectActionReferenceV1Schema.parse(await actionReference.json()).status,
	).toBe("created");
	const operationNonce = randomUUID();
	const attemptNonce = randomUUID();
	const mcpRequest = {
		jsonrpc: "2.0",
		id: 7,
		method: "tools/call",
		params: {
			name: "execute_action",
			arguments: {
				providerId: "provider",
				actionId: "read-issue",
				actionVersion: "v1",
				input: { repositoryId: 7 },
			},
			_meta: {
				"connection.clientRequest/v1": {
					operationNonce,
					attemptNonce,
					idempotencyKey: operationNonce,
				},
			},
		},
	};
	const mcp = (body: unknown, token = tokens.access_token, proof = true) =>
		app.request("/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `DPoP ${token}`,
				...(proof ? { dpop: dpop("/mcp", { token }) } : {}),
			},
			body: JSON.stringify(body),
		});
	expect((await mcp(mcpRequest, tokens.access_token, false)).status).toBe(401);
	expect(
		(
			await mcp(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "unauthenticated", version: "1.0.0" },
					},
				},
				tokens.access_token,
				false,
			)
		).status,
	).toBe(401);
	expect(
		(
			await mcp(
				{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
				tokens.access_token,
				false,
			)
		).status,
	).toBe(401);
	const mcpResponse = await mcp(mcpRequest);
	expect(mcpResponse.status).toBe(200);
	const mcpResult = DirectMcpExecuteActionResponseV1Schema.parse(
		await mcpResponse.json(),
	);
	const mcpReceipt = mcpResult.result._meta["connection.receipt/v1"];
	expect(mcpReceipt.callRef).toMatch(/^[0-9a-f-]{36}$/);
	expect(mcpReceipt.requestDigest).toMatch(/^[0-9a-f]{64}$/);
	expect((await mcp(mcpRequest)).status).toBe(200);
	const secondAttemptNonce = randomUUID();
	const replayWithAnotherAttempt = await mcp({
		...mcpRequest,
		id: 8,
		params: {
			...mcpRequest.params,
			_meta: {
				"connection.clientRequest/v1": {
					operationNonce,
					attemptNonce: secondAttemptNonce,
					idempotencyKey: operationNonce,
				},
			},
		},
	});
	expect(replayWithAnotherAttempt.status).toBe(200);
	expect(
		DirectMcpExecuteActionResponseV1Schema.parse(
			await replayWithAnotherAttempt.json(),
		).result.structuredContent.callId,
	).toBe(mcpReceipt.callRef);
	const conflictingCall = await mcp({
		...mcpRequest,
		id: 9,
		params: {
			...mcpRequest.params,
			arguments: { ...mcpRequest.params.arguments, input: { repositoryId: 8 } },
		},
	});
	expect(conflictingCall.status).toBe(200);
	expect(await conflictingCall.json()).toMatchObject({
		result: {
			isError: true,
			content: [{ type: "text", text: "ACTION_CONFLICT" }],
		},
	});
	const wrongProvider = await mcp({
		...mcpRequest,
		id: 10,
		params: {
			...mcpRequest.params,
			arguments: {
				...mcpRequest.params.arguments,
				providerId: "other-provider",
			},
		},
	});
	expect(await wrongProvider.json()).toMatchObject({
		result: { isError: true },
	});
	const missingScopeNonce = randomUUID();
	const missingScope = await mcp({
		...mcpRequest,
		id: 11,
		params: {
			...mcpRequest.params,
			arguments: {
				...mcpRequest.params.arguments,
				actionVersion: "v3",
				input: { issueNumber: 42 },
			},
			_meta: {
				"connection.clientRequest/v1": {
					operationNonce: missingScopeNonce,
					attemptNonce: randomUUID(),
					idempotencyKey: missingScopeNonce,
				},
			},
		},
	});
	expect(await missingScope.json()).toMatchObject({
		result: {
			isError: true,
			content: [{ type: "text", text: "ACTION_UNAVAILABLE" }],
		},
	});
	expect((await mcp({ ...mcpRequest, principalId: "bob" })).status).toBe(400);
	expect(await database.db.select().from(mcpCallBindings)).toMatchObject([
		{
			operationNonce,
			attemptNonces: [attemptNonce, secondAttemptNonce],
			requestDigestVersion: "connection-request-v1",
			requestDigest: mcpReceipt.requestDigest,
		},
	]);
	const sdkClient = new McpClient({
		name: "direct-installation-test",
		version: "1.0.0",
	});
	const sdkTransport = new StreamableHTTPClientTransport(new URL(audience), {
		fetch: async (input, init) => {
			const method = init?.method ?? "GET";
			const headers = new Headers(init?.headers);
			headers.set("authorization", `DPoP ${tokens.access_token}`);
			headers.set("dpop", dpop("/mcp", { method, token: tokens.access_token }));
			return app.fetch(new Request(input, { ...init, headers }));
		},
	});
	await sdkClient.connect(sdkTransport);
	expect(
		(await sdkClient.listTools()).tools.map((tool) => tool.name),
	).toContain("execute_action");
	const sdkOperationNonce = randomUUID();
	const sdkAttemptNonce = randomUUID();
	const sdkResult = await sdkClient.callTool({
		name: "execute_action",
		arguments: {
			providerId: "provider",
			actionId: "read-issue",
			actionVersion: "v2",
			input: { issueNumber: 42 },
		},
		_meta: {
			"connection.clientRequest/v1": {
				operationNonce: sdkOperationNonce,
				attemptNonce: sdkAttemptNonce,
				idempotencyKey: sdkOperationNonce,
			},
		},
	});
	expect(sdkResult.isError).not.toBe(true);
	expect(sdkResult.structuredContent).toMatchObject({ status: "RESERVED" });
	expect(sdkResult._meta?.["connection.receipt/v1"]).toMatchObject({
		operationNonce: sdkOperationNonce,
		attemptNonce: sdkAttemptNonce,
		actionVersionId: "action-v2",
	});
	await sdkClient.close();
	const identityPath = "/api/client/identity";
	const identity = await app.request(identityPath, {
		headers: {
			authorization: `DPoP ${tokens.access_token}`,
			dpop: dpop(identityPath, {
				method: "GET",
				token: tokens.access_token,
			}),
		},
	});
	expect(identity.status).toBe(200);
	expect(
		DirectClientIdentityV1Schema.parse(await identity.json()),
	).toMatchObject({
		principal: { type: "user", key: "alice" },
		actorId: installedActor.id,
		consumerId: "client",
		clientId: installedInstance.id,
		issuer: origin,
		resource: audience,
	});
	const callPath = `/api/client/calls/${mcpReceipt.callRef}`;
	const readCall = (token = tokens.access_token, key = privateKey) =>
		app.request(callPath, {
			headers: {
				authorization: `DPoP ${token}`,
				dpop: dpop(callPath, {
					method: "GET",
					token,
					key,
					publicJwk:
						key === privateKey
							? jwk
							: otherKey.publicKey.export({ format: "jwk" }),
				}),
			},
		});
	const callReadback = await readCall();
	expect(callReadback.status).toBe(200);
	expect(
		DirectClientCallRecordV1Schema.parse(await callReadback.json()),
	).toMatchObject({
		callRef: mcpReceipt.callRef,
		requestDigest: mcpReceipt.requestDigest,
		operationNonce,
		attemptNonces: [attemptNonce, secondAttemptNonce],
		principal: { type: "user", key: "alice" },
		actorId: installedActor.id,
		actionVersionId: "action-v1",
		consumerId: "client",
		clientId: installedInstance.id,
	});
	expect(
		(await readCall(tokens.access_token, otherKey.privateKey)).status,
	).toBe(401);
	const bobInstall = await app.request("/oauth/install", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			dpop: dpop("/oauth/install", {
				key: otherKey.privateKey,
				publicJwk: otherKey.publicKey.export({ format: "jwk" }),
			}),
		},
		body: JSON.stringify(installationBody),
	});
	expect(bobInstall.status).toBe(201);
	const bobInstallPath = new URL(
		((await bobInstall.json()) as { authorization_uri: string })
			.authorization_uri,
	).pathname;
	expect(
		(await app.request(bobInstallPath, { headers: browserHeaders(bobCookie) }))
			.status,
	).toBe(200);
	const bobApprove = await app.request(bobInstallPath, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...browserHeaders(bobCookie),
		},
		body: JSON.stringify({ approve: true }),
	});
	expect(bobApprove.status).toBe(303);
	const bobCode = new URL(
		bobApprove.headers.get("location") ?? "",
	).searchParams.get("code");
	const bobTokenForm = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: "client",
		code: bobCode ?? "",
		code_verifier: verifier,
		redirect_uri: redirectUri,
	});
	const bobTokenResponse = await app.request("/oauth/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			dpop: dpop("/oauth/token", {
				key: otherKey.privateKey,
				publicJwk: otherKey.publicKey.export({ format: "jwk" }),
			}),
		},
		body: bobTokenForm.toString(),
	});
	expect(bobTokenResponse.status).toBe(200);
	const bobToken = (await bobTokenResponse.json()) as { access_token: string };
	const bobInstance = (await database.db.select().from(consumerInstances)).find(
		(row) => row.principalId === "bob",
	);
	const bobActor = (await database.db.select().from(actors)).find(
		(row) => row.consumerInstanceId === bobInstance?.id,
	);
	if (!bobInstance || !bobActor)
		throw new Error("Second installation binding was not persisted");
	await database.db.insert(grants).values({
		id: "grant-bob",
		principalId: "bob",
		consumerId: "client",
		consumerInstanceId: bobInstance.id,
		actorId: bobActor.id,
		connectionId: "connection",
		credentialVersionId: "provider-credential-v1",
		approvedActionVersionIds: ["action-v1"],
		principalRecoveryGeneration: 1,
		expiresAt: new Date(Date.now() + 60_000),
	});
	const bobReservation = await app.request("/api/v1/actions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `DPoP ${bobToken.access_token}`,
			dpop: dpop("/api/v1/actions", {
				token: bobToken.access_token,
				key: otherKey.privateKey,
				publicJwk: otherKey.publicKey.export({ format: "jwk" }),
			}),
		},
		body: JSON.stringify(actionRequest),
	});
	expect(bobReservation.status).toBe(202);
	expect(
		DirectActionReservationV1Schema.parse(await bobReservation.json()).callId,
	).not.toBe(receipt.callId);
	expect(
		(
			await app.request(actionPath, {
				headers: {
					authorization: `DPoP ${bobToken.access_token}`,
					dpop: dpop(actionPath, {
						method: "GET",
						token: bobToken.access_token,
						key: otherKey.privateKey,
						publicJwk: otherKey.publicKey.export({ format: "jwk" }),
					}),
				},
			})
		).status,
	).toBe(404);
	expect(
		(await readCall(bobToken.access_token, otherKey.privateKey)).status,
	).toBe(404);
	const revocationRaceRequest = {
		...actionRequest,
		requestId: "request-action-revocation-race",
		idempotencyKey: "action-key-revocation-race",
	};
	const [racedReservation] = await Promise.all([
		reserve(revocationRaceRequest),
		database.db.update(grants).set({ status: "revoked", revision: 2 }),
	]);
	expect([202, 403]).toContain(racedReservation.status);
	expect(
		(
			await reserve({
				...actionRequest,
				requestId: "request-action-2",
				idempotencyKey: "action-key-2",
			})
		).status,
	).toBe(403);
	expect(await database.db.select().from(actionCalls)).toHaveLength(
		racedReservation.status === 202 ? 7 : 6,
	);
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
	const instance = (await database.db.select().from(consumerInstances)).find(
		(row) => row.principalId === "alice",
	);
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
