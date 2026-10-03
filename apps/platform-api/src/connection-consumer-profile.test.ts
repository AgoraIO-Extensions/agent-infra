import { describe, expect, it } from "vitest";

import { createConnectionCapability } from "./connection-consumer-profile.js";

const profile = {
	schemaVersion: 1,
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp",
	consumerId: "platform-web",
	audience: "connection-api",
	egressProfile: { ref: "egress-platform", revision: "r1" },
};

describe("Connection Consumer configuration", () => {
	it("publishes a deterministic capability and fingerprint", () => {
		const result = createConnectionCapability(profile);
		expect(result).toEqual({
			status: "available",
			schemaVersion: 1,
			publicOrigin: profile.publicOrigin,
			mcpPath: profile.mcpPath,
			configFingerprint:
				"7821b88d0acd40836eed51877a2e959774434f72cc4672475f7da41c89359331",
		});
	});

	it.each([
		["missing", undefined],
		["invalid origin", { ...profile, publicOrigin: "http://bad.test" }],
		["invalid path", { ...profile, mcpPath: "/mcp/../admin" }],
		["unapproved", profile],
	] as const)("fails closed for %s", (label, input) => {
		const result = createConnectionCapability(input, label !== "unapproved");
		expect(result.status).toBe("unavailable");
	});

	it("rejects unknown and cross-consumer fields", () => {
		expect(
			createConnectionCapability({ ...profile, consumerInstance: "other" }),
		).toMatchObject({ status: "unavailable", reason: "invalid" });
	});
});
