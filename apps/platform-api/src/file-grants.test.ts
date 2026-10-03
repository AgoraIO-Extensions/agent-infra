import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { createFileGrantCodecV1 } from "./file-grants.ts";

it("accepts only the configured issuer, key and file audience with an intact signature", () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const codec = createFileGrantCodecV1({
		issuer: "platform",
		keyVersion: "key-1",
		privateKey,
		publicKeys: new Map([["key-1", publicKey]]),
	});
	const record = {
		schemaVersion: 1 as const,
		purpose: "file_access" as const,
		issuer: "platform",
		audience: "platform_files" as const,
		keyVersion: "key-1",
		idempotencyKey: "access-key",
		accessId: "access",
		fileId: "file",
		actorId: "alice",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
		operation: "read" as const,
		maxBytes: 5,
		issuedAt: "2026-09-15T00:00:00Z",
		expiresAt: "2026-09-15T00:01:00Z",
		execution: null,
	};
	const signed = codec.sign(record);
	const { keyVersion: _, idempotencyKey: _key, ...claims } = record;
	expect(codec.verify(signed)).toEqual(claims);
	expect(() =>
		codec.verify({
			...signed,
			token: `${signed.token.slice(0, -10)}AAAAAAAAAA`,
		}),
	).toThrow();
	const other = createFileGrantCodecV1({
		issuer: "other",
		keyVersion: "key-1",
		privateKey,
		publicKeys: new Map([["key-1", publicKey]]),
	});
	expect(() => other.verify(signed)).toThrow();
});

it("uses the original runtime grant only as a signed, current execution proof", async () => {
	const { sign } = await import("node:crypto");
	const { verifyExecutionGrantForFilesV1 } = await import("./file-grants.ts");
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const claims = {
		schemaVersion: 1,
		issuer: "platform",
		audience: ["runtime_host"],
		issuedAt: "2026-09-15T00:00:00Z",
		expiresAt: "2026-09-15T00:01:00Z",
		grantId: "grant",
		actorId: "alice",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		sessionGeneration: 1,
		allowedCommands: ["turn.submit"],
		attachments: [],
		actionSetVersion: "none",
		actionIds: [],
		traceId: "trace_fixture",
	};
	const envelope = (input: unknown) => {
		const data = `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "key" })).toString("base64url")}.${Buffer.from(JSON.stringify(input)).toString("base64url")}`;
		return {
			schemaVersion: 1 as const,
			format: "compact-jws" as const,
			token: `${data}.${sign(null, Buffer.from(data), privateKey).toString("base64url")}`,
		};
	};
	const options = {
		issuer: "platform",
		publicKeys: new Map([["key", publicKey]]),
		now: "2026-09-15T00:00:10Z",
	};
	expect(
		verifyExecutionGrantForFilesV1(envelope(claims), options).executionId,
	).toBe("execution");
	expect(() =>
		verifyExecutionGrantForFilesV1(
			envelope({ ...claims, allowedCommands: ["turn.stop"] }),
			options,
		),
	).toThrow();
	expect(() =>
		verifyExecutionGrantForFilesV1(envelope(claims), {
			...options,
			now: "2026-09-15T00:01:01Z",
		}),
	).toThrow();
});
