import { generateKeyPairSync, sign } from "node:crypto";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import { expect, it } from "vitest";
import { assemblePlatformFilesV1 } from "./file-assembly.ts";

it("requires both a signed execution delegation and a mapped service, then rechecks its actor", async () => {
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
	let revoked = false;
	let channelId = "web";
	const mapping = {
		token: "synthetic-service-token-442-123456789",
		component: "worker" as const,
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
			runtimePublicKeys: new Map([["runtime-key", keys.publicKey]]),
			intentTtlMs: 60000,
			accessTtlMs: 10000,
			maxConcurrentTransfers: 2,
			services: [mapping],
			resolveActor: async () => (revoked ? null : actor),
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
					channelId,
					authorizationRevision: "auth-1",
					supportsSupplementaryInstruction: false,
				},
			}),
		},
	});
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
		channelId = "other";
		expect(
			await accepted.authorization.authorize("conversation", "read"),
		).toBeNull();
		channelId = "web";
		revoked = true;
		await expect(
			accepted.authorization.authorize("conversation", "read"),
		).rejects.toThrow();
	} finally {
		await assembled.close();
	}
});
