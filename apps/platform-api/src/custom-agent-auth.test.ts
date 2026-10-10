import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	createPlatformEntryContextSignerV1,
	createPlatformEntryContextVerifierV1,
} from "./custom-agent-auth.js";

describe("platform identity context for custom Agents", () => {
	it("signs and verifies a short-lived Agent-bound context", () => {
		const keys = generateKeyPairSync("ed25519");
		const signer = createPlatformEntryContextSignerV1({
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
			now: () => 1_700_000_000_000,
			id: () => "ctx_01",
		});
		const token = signer({
			userId: "user_01",
			organizationIds: ["org_01"],
			roles: ["employee"],
			authorizationRevision: "authrev_01",
			agentId: "agent_01",
		});
		const verify = createPlatformEntryContextVerifierV1({
			publicKeys: new Map([["key_01", keys.publicKey]]),
			expectedIssuer: "platform_01",
			expectedAgentId: "agent_01",
			now: () => 1_700_000_010_000,
		});
		expect(verify(token)).toMatchObject({
			userId: "user_01",
			agentId: "agent_01",
			contextId: "ctx_01",
		});
	});

	it.each([
		["wrong Agent", { expectedAgentId: "agent_02" }],
		["expired", { now: () => 1_700_000_031_000 }],
	])("rejects %s before the custom Agent can trust it", (_name, override) => {
		const keys = generateKeyPairSync("ed25519");
		const signer = createPlatformEntryContextSignerV1({
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
			now: () => 1_700_000_000_000,
		});
		const token = signer({
			userId: "user_01",
			organizationIds: [],
			roles: ["employee"],
			authorizationRevision: "authrev_01",
			agentId: "agent_01",
		});
		const verify = createPlatformEntryContextVerifierV1({
			publicKeys: new Map([["key_01", keys.publicKey]]),
			expectedIssuer: "platform_01",
			expectedAgentId: "agent_01",
			now: () => 1_700_000_010_000,
			...override,
		});
		expect(() => verify(token)).toThrow("PLATFORM_ENTRY_CONTEXT_INVALID");
	});

	it("rejects malformed and tampered platform contexts", () => {
		const keys = generateKeyPairSync("ed25519");
		const signer = createPlatformEntryContextSignerV1({
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
			now: () => 1_700_000_000_000,
		});
		const token = signer({
			userId: "user_01",
			organizationIds: [],
			roles: ["employee"],
			authorizationRevision: "authrev_01",
			agentId: "agent_01",
		});
		const verify = createPlatformEntryContextVerifierV1({
			publicKeys: new Map([["key_01", keys.publicKey]]),
			expectedIssuer: "platform_01",
			expectedAgentId: "agent_01",
			now: () => 1_700_000_010_000,
		});
		expect(() => verify({ ...token, token: "invalid" })).toThrow(
			"PLATFORM_ENTRY_CONTEXT_INVALID",
		);
		const parts = token.token.split(".");
		const signature = parts[2];
		if (!signature) throw new Error("Expected signature");
		expect(() =>
			verify({
				...token,
				token: `${parts[0]}.${parts[1]}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
			}),
		).toThrow("PLATFORM_ENTRY_CONTEXT_INVALID");
	});
});
