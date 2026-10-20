import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeExecutionGrantV5Schema,
	type RuntimeNativeCapabilityRequestV5,
	RuntimeNativeCapabilityRequestV5Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV5Schema,
	RuntimeRestoreExecutionKeyRequestV5Schema,
	runtimeRequestDigestV5,
	runtimeRestoreExecutionKeyRequestDigestV5,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
	createRuntimeExecutionGrantValidatorV5,
	createRuntimeExecutionKeyRecoveryValidatorV5,
} from "./grant-v4.js";

const keys = generateKeyPairSync("ed25519");
const publicKeys = new Map([["fixture", keys.publicKey]]);
const now = 1_800_000_000_000;
const options = {
	expectedIssuer: "platform-fixture",
	expectedWorkerId: "worker-fixture",
	now: () => now,
};
const validateGrant = createRuntimeExecutionGrantValidatorV5(
	publicKeys,
	options,
);
const validateRecovery = createRuntimeExecutionKeyRecoveryValidatorV5(
	publicKeys,
	options,
);

const text = new TextEncoder().encode("hello");
const sha256 = (value: Uint8Array | string) =>
	createHash("sha256")
		.update(typeof value === "string" ? value : Buffer.from(value))
		.digest("hex");

function token(claims: unknown) {
	const header = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: "fixture",
			typ: "runtime-execution+jws",
		}),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${header}.${payload}.${sign(
		null,
		Buffer.from(`${header}.${payload}`),
		keys.privateKey,
	).toString("base64url")}`;
}

function request(): RuntimeNativeCapabilityRequestV5 {
	return RuntimeNativeCapabilityRequestV5Schema.parse({
		schemaVersion: 5,
		requestId: "request-fixture",
		traceId: "trace-fixture",
		principal: { kind: "user", id: "user-fixture" },
		executionSource: "web",
		channelId: "web",
		agentId: "agent-fixture",
		conversationId: "conversation-fixture",
		executionId: "execution-fixture",
		turnId: "turn-fixture",
		sessionGeneration: 1,
		hostSessionRef: "host-fixture",
		operation: {
			kind: "execution",
			id: "execution-fixture",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		keyBinding: {
			purpose: "personal",
			subjectId: "user-fixture",
			ciphertextRef: "key-fixture",
			version: 1,
		},
		capabilityKind: "skill",
		capabilityId: "a".repeat(64),
		directoryRevision: "b".repeat(64),
		parameters: "{}",
		parametersDigest: sha256("{}"),
		capabilitySourceVersion: "1.0.0",
		attachments: [
			{
				attachmentId: "file-fixture",
				sha256: sha256(text),
				byteLength: text.byteLength,
				mediaType: "text/plain",
			},
		],
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
	});
}

async function accepted(
	value = request(),
	changes: Record<string, unknown> = {},
) {
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: "platform-fixture",
		audience: "runtime_host",
		workerId: "worker-fixture",
		issuedAt: now,
		expiresAt: now + 30_000,
		grantId: "grant-fixture",
		principal: value.principal,
		executionSource: value.executionSource,
		relayKeyBinding: value.keyBinding,
		agentId: value.agentId,
		channelId: value.channelId,
		conversationId: value.conversationId,
		executionId: value.executionId,
		turnId: value.turnId,
		sessionGeneration: value.sessionGeneration,
		traceId: value.traceId,
		hostSessionRef: value.hostSessionRef,
		operation: value.operation,
		allowedCommands: ["native-capability.invoke"],
		purpose: "business",
		authorizationRecordId: "authorization-fixture",
		attachments: value.attachments.map((entry) => ({
			attachmentId: entry.attachmentId,
			operations: ["read"] as const,
		})),
		requestDigest: await runtimeRequestDigestV5(value),
		...changes,
	});
	return { ...value, grant: { ...value.grant, token: token(claims) } };
}

describe("Runtime V5 Grant trust boundary", () => {
	it("verifies the reused V4 business Grant and the ordered V5 attachment binding", async () => {
		const signed = await accepted();
		const verified = await validateGrant(signed);
		expect(verified.request).toEqual(signed);
		expect(verified.claims.attachments).toEqual([
			{ attachmentId: "file-fixture", operations: ["read"] },
		]);
	});

	it.each([
		[
			"reordered attachments",
			{ attachments: [{ attachmentId: "file-other", operations: ["read"] }] },
		],
		[
			"a request digest that excludes the ordered set",
			{ requestDigest: "c".repeat(64) },
		],
	])("rejects %s", async (_label, changes) => {
		await expect(
			validateGrant(await accepted(request(), changes)),
		).rejects.toThrow();
	});

	it("rejects a V5 request whose parameters do not match their digest", async () => {
		await expect(
			validateGrant(await accepted({ ...request(), parameters: "changed" })),
		).rejects.toThrow();
	});
});

describe("Runtime V5 Key recovery trust boundary", () => {
	async function recovery(
		acceptedAttachmentIds = ["file-fixture"],
		original = request(),
	) {
		const unsigned = RuntimeRestoreExecutionKeyRequestV5Schema.parse({
			schemaVersion: 5,
			mode: "existing-accepted-only",
			acceptedHostSessionRef: original.hostSessionRef,
			acceptedOperationDigest: "A".repeat(43),
			acceptedAttachmentIds,
			grant: {
				schemaVersion: 5,
				format: "runtime-execution-jws",
				token: "a.b.c",
			},
			originalRequest: original,
		});
		const claims = RuntimeRestoreExecutionKeyGrantClaimsV5Schema.parse({
			schemaVersion: 5,
			issuer: "platform-fixture",
			audience: "runtime_host",
			workerId: "worker-fixture",
			issuedAt: now,
			expiresAt: now + 30_000,
			grantId: "recovery-fixture",
			principal: original.principal,
			executionSource: original.executionSource,
			relayKeyBinding: original.keyBinding,
			agentId: original.agentId,
			channelId: original.channelId,
			conversationId: original.conversationId,
			executionId: original.executionId,
			turnId: original.turnId,
			sessionGeneration: original.sessionGeneration,
			traceId: original.traceId,
			hostSessionRef: original.hostSessionRef,
			operation: original.operation,
			allowedCommands: ["execution.key.restore"],
			purpose: "business",
			authorizationRecordId: "authorization-fixture",
			attachments: [],
			requestDigest: await runtimeRestoreExecutionKeyRequestDigestV5(unsigned),
			mode: unsigned.mode,
			acceptedHostSessionRef: unsigned.acceptedHostSessionRef,
			acceptedOperationDigest: unsigned.acceptedOperationDigest,
			acceptedAttachmentIds: unsigned.acceptedAttachmentIds,
		});
		return {
			...unsigned,
			grant: RuntimeExecutionGrantV5Schema.parse({
				...unsigned.grant,
				token: token(claims),
			}),
		};
	}

	it("verifies the existing-accepted recovery binding without rematerializing inputs", async () => {
		const signed = await recovery();
		const verified = await validateRecovery(signed);
		expect(verified.request.acceptedAttachmentIds).toEqual(["file-fixture"]);
		expect(verified.claims.acceptedAttachmentIds).toEqual(["file-fixture"]);
	});

	it("rejects reordered or missing accepted attachment ids", async () => {
		await expect(
			validateRecovery(await recovery(["file-other"])),
		).rejects.toThrow();
		const two = {
			...request(),
			attachments: [
				...request().attachments,
				{
					attachmentId: "file-second",
					sha256: sha256("second"),
					byteLength: 6,
					mediaType: "text/plain" as const,
				},
			],
		};
		await expect(
			validateRecovery(await recovery(["file-fixture"], two)),
		).rejects.toThrow();
	});
});
