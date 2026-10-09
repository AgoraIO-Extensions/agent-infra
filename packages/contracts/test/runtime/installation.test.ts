import { describe, expect, it } from "vitest";
import {
	ConnectionInstallationAuthorizationV1Schema,
	ConnectionInstallationCommandV1Schema,
} from "../../src/runtime/installation.ts";

const scope = {
	agentId: "agent-a",
	sandboxId: "sandbox-a",
	podUid: "pod-a",
	sessionGeneration: 1,
	configFingerprint: "a".repeat(64),
	source: { ref: "approved-profile", revision: "r1" },
	oauthConfiguration: { ref: "approved-oauth", revision: "r1" },
};

describe("MCP installation contracts", () => {
	it("accepts a non-sensitive authorization snapshot", () => {
		expect(
			ConnectionInstallationAuthorizationV1Schema.parse({
				schemaVersion: 1,
				authorizationId: "authorization-a",
				confirmationRevision: "confirmation-a",
				principal: { kind: "user", id: "alice" },
				reference: {
					schemaVersion: 1,
					agentId: "agent-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					sessionGeneration: 1,
				},
				scope,
				status: "confirmed",
				expiresAt: Date.now() + 60_000,
			}),
		).toMatchObject({ authorizationId: "authorization-a", status: "confirmed" });
	});

	it("rejects secrets and caller-selected authority fields", () => {
		const value = {
			schemaVersion: 1,
			commandId: "command-a",
			authorizationId: "authorization-a",
			command: "begin",
			requestDigest: "b".repeat(64),
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			token: "secret-token",
		};
		expect(ConnectionInstallationCommandV1Schema.safeParse(value).success).toBe(false);
	});
});
