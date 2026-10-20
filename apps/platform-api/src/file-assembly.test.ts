import { generateKeyPairSync, sign } from "node:crypto";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import { expect, it } from "vitest";
import { assemblePlatformFilesV1 } from "./file-assembly.ts";
import { verifyRuntimeExecutionGrantForFilesV4 } from "./file-grants.ts";

function createAssemblyFixture() {
	const keys = generateKeyPairSync("ed25519");
	const actor = {
		schemaVersion: 1 as const,
		userId: "alice",
		displayName: "Alice",
		accountStatus: "active" as const,
		organizationIds: ["org"],
		roles: ["employee" as const],
		authorizationRevision: "auth-1",
	};
	const limits = {
		revision: "limits",
		expiresAt: "2099-01-01T00:00:00Z",
		maxBytes: 100,
		mediaTypes: ["text/plain"],
	};
	const state = { revoked: false, channelId: "web" };
	const mapping = {
		token: "synthetic-service-token-442-123456789",
		agentIds: ["agent"],
	};
	const assembled = assemblePlatformFilesV1({
		databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused",
		identity: { resolve: async () => actor, hydrateUsers: async () => [] },
		deployment: {
			storage: new FakeObjectStorageV1(),
			issuer: "platform-files",
			keyVersion: "file-key",
			...keys,
			publicKeys: new Map([["file-key", keys.publicKey]]),
			runtimeIssuer: "platform-runtime",
			runtimeWorkerId: "runtime-worker",
			runtimePublicKeys: new Map([["runtime-key", keys.publicKey]]),
			intentTtlMs: 60000,
			accessTtlMs: 10000,
			maxConcurrentTransfers: 2,
			services: [mapping],
			resolveActor: async () => (state.revoked ? null : actor),
			readLimits: async () => ({
				configurationRevision: 1,
				declarations: { agent: limits, channel: limits, deployment: limits },
			}),
		},
		readCurrentLimits: async () => ({
			agent: limits,
			channel: limits,
			deployment: limits,
		}),
		conversationAuthorization: {
			authorize: async (identity) => ({
				outcome: "allowed",
				authority: {
					schemaVersion: 1,
					actorId: identity.userId,
					agentId: "agent",
					channelId: state.channelId,
					authorizationRevision: "auth-1",
					supportsSupplementaryInstruction: false,
				},
			}),
		},
	});
	return { assembled, keys, mapping, state };
}

it("requires both a signed execution delegation and a mapped service, then rechecks its actor", async () => {
	const { assembled, keys, mapping, state } = createAssemblyFixture();
	const claims = {
		schemaVersion: 1,
		issuer: "platform-runtime",
		audience: ["runtime_host"],
		issuedAt: new Date(Date.now() - 1000).toISOString(),
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		grantId: "grant",
		actorId: "alice",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		sessionGeneration: 1,
		allowedCommands: ["turn.submit"],
		attachments: [{ attachmentId: "file-input", operations: ["read"] }],
		actionSetVersion: "none",
		actionIds: [],
		traceId: "trace",
	};
	const data = `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "runtime-key" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
	const grant = {
		schemaVersion: 1 as const,
		format: "compact-jws" as const,
		token: `${data}.${sign(null, Buffer.from(data), keys.privateKey).toString("base64url")}`,
	};
	const request = (token: string) =>
		new Request("http://platform/internal/v1/files/exchange", {
			headers: { Authorization: `Bearer ${token}` },
		});
	try {
		const exchange = assembled.dependencies.exchange;
		if (!exchange) throw new Error("Exchange missing");
		await expect(
			exchange.authenticate(
				request("unmapped-service-token-123456789012"),
				grant,
			),
		).rejects.toThrow();
		await expect(
			exchange.authenticate(request(mapping.token), {
				...grant,
				token: "a.b.c",
			}),
		).rejects.toThrow();
		const accepted = await exchange.authenticate(request(mapping.token), grant);
		expect(
			await accepted.authorization.authorize("conversation", "read"),
		).toMatchObject({
			actorId: "alice",
			execution: { executionId: "execution", attachments: ["file-input"] },
		});
		state.channelId = "other";
		expect(
			await accepted.authorization.authorize("conversation", "read"),
		).toBeNull();
		state.channelId = "web";
		state.revoked = true;
		await expect(
			accepted.authorization.authorize("conversation", "read"),
		).rejects.toThrow();
	} finally {
		await assembled.close();
	}
});

function runtimeClaims() {
	const issuedAt = Date.now() - 1000;
	return {
		schemaVersion: 4,
		issuer: "platform-runtime",
		audience: "runtime_host",
		issuedAt,
		expiresAt: issuedAt + 30_000,
		grantId: "grant-1",
		workerId: "runtime-worker",
		principal: { kind: "user", id: "alice" },
		executionSource: "web",
		relayKeyBinding: {
			purpose: "personal",
			subjectId: "alice",
			ciphertextRef: "key-1",
			version: 1,
		},
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		sessionGeneration: 1,
		traceId: "trace",
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: "execution",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		allowedCommands: ["turn.submit"],
		purpose: "business",
		authorizationRecordId: "authorization-1",
		attachments: [{ attachmentId: "file-input", operations: ["read"] }],
		requestDigest: "a".repeat(64),
	};
}

function v4Grant(
	keys: ReturnType<typeof createAssemblyFixture>["keys"],
	claims: Record<string, unknown>,
) {
	const header = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: "runtime-key",
			typ: "runtime-execution+jws",
		}),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const content = `${header}.${payload}`;
	return {
		schemaVersion: 4 as const,
		format: "runtime-execution-jws" as const,
		token: `${content}.${sign(null, Buffer.from(content), keys.privateKey).toString("base64url")}`,
	};
}

it("verifies a signed V4 business grant as a delegation-scope proof", () => {
	const { keys } = createAssemblyFixture();
	const options = {
		issuer: "platform-runtime",
		workerId: "runtime-worker",
		publicKeys: new Map([["runtime-key", keys.publicKey]]),
	};
	const claims = verifyRuntimeExecutionGrantForFilesV4(
		v4Grant(keys, runtimeClaims()),
		options,
	);
	// Only the signed attachment allowlist is available to the exchange.
	expect(claims.attachments).toEqual([
		{ attachmentId: "file-input", operations: ["read"] },
	]);
	// The proof is a delegation scope, not continuous authority: a Grant whose
	// signed 30 s window already lapsed still verifies, while persisted rows
	// decide current authorization (OQ-1 in #2968).
	const lapsed = runtimeClaims();
	lapsed.issuedAt = Date.now() - 120_000;
	lapsed.expiresAt = lapsed.issuedAt + 30_000;
	expect(
		verifyRuntimeExecutionGrantForFilesV4(v4Grant(keys, lapsed), options),
	).toMatchObject({ authorizationRecordId: "authorization-1" });
	for (const mutate of [
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.issuer = "foreign-runtime";
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.workerId = "foreign-worker";
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.allowedCommands = ["native-capability.invoke"];
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.allowedCommands = ["turn.submit", "native-capability.invoke"];
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.purpose = "control";
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.expiresAt = claims.issuedAt + 31_000;
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.operation.deliveryFence = 2;
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.audience = "platform_files";
		},
	]) {
		const altered = runtimeClaims();
		mutate(altered);
		expect(() =>
			verifyRuntimeExecutionGrantForFilesV4(v4Grant(keys, altered), options),
		).toThrow();
	}
	// A valid grant for a different deployment still fails when the Worker is
	// unknown, and a tampered token never verifies.
	expect(() =>
		verifyRuntimeExecutionGrantForFilesV4(v4Grant(keys, runtimeClaims()), {
			...options,
			workerId: "other-worker",
		}),
	).toThrow();
	const tampered = v4Grant(keys, runtimeClaims());
	expect(() =>
		verifyRuntimeExecutionGrantForFilesV4(
			{ ...tampered, token: `${tampered.token.slice(0, -2)}xx` },
			options,
		),
	).toThrow();
});

it("denies a V4 exchange whose service identity is not mapped to the Agent", async () => {
	const { assembled, keys } = createAssemblyFixture();
	const request = new Request(
		"http://platform/internal/v1/files/runtime-exchange",
		{ headers: { Authorization: "Bearer unmapped-service-token-123456789" } },
	);
	const grant = v4Grant(keys, runtimeClaims());
	try {
		const runtimeExchange = assembled.dependencies.runtimeExchange;
		if (!runtimeExchange) throw new Error("Runtime exchange missing");
		await expect(
			runtimeExchange.authenticate(request, {
				schemaVersion: 2,
				executionGrant: grant,
				operation: "read",
				fileId: "file-input",
				idempotencyKey: "runtime-1",
			}),
		).rejects.toThrow();
	} finally {
		await assembled.close();
	}
});

it("fails closed when files are configured without a runtime Worker identity", () => {
	expect(() =>
		assemblePlatformFilesV1({
			databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused",
			identity: { resolve: async () => null, hydrateUsers: async () => [] },
			deployment: {
				storage: new FakeObjectStorageV1(),
				issuer: "platform-files",
				keyVersion: "file-key",
				...generateKeyPairSync("ed25519"),
				publicKeys: new Map(),
				runtimeIssuer: "platform-runtime",
				runtimeWorkerId: "",
				runtimePublicKeys: new Map(),
				intentTtlMs: 60000,
				accessTtlMs: 10000,
				maxConcurrentTransfers: 2,
				services: [],
				resolveActor: async () => null,
				readLimits: async () => {
					throw new Error("unused");
				},
			},
			readCurrentLimits: async () => null,
			conversationAuthorization: {
				authorize: async () => ({ outcome: "denied" as const }),
			},
		}),
	).toThrow("runtime worker identity");
});
