import { createHash } from "node:crypto";
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

const approval = {
	egressEnforced: true,
	schemaVersion: 1,
	configFingerprint:
		"7821b88d0acd40836eed51877a2e959774434f72cc4672475f7da41c89359331",
	source: { ref: "platform-deployment", revision: "r1" },
};

const connectionCapability = (input: unknown, approval: unknown) =>
	createConnectionCapability(input, approval, "/connection/connections");

function approve(candidate: typeof profile) {
	return {
		...approval,
		configFingerprint: createHash("sha256")
			.update(
				JSON.stringify([
					candidate.schemaVersion,
					candidate.publicOrigin,
					candidate.mcpPath,
					candidate.consumerId,
					candidate.audience,
					candidate.egressProfile.ref,
					candidate.egressProfile.revision,
				]),
			)
			.digest("hex"),
	};
}
describe("Connection Consumer configuration", () => {
	it("publishes a deterministic capability and fingerprint", () => {
		const result = connectionCapability(profile, approval);
		expect(result).toEqual({
			status: "available",
			schemaVersion: 1,
			publicOrigin: profile.publicOrigin,
			mcpPath: profile.mcpPath,
			webPath: "/connection/connections",
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
		const result = connectionCapability(
			input,
			label === "unapproved" ? undefined : input ? approve(input) : approval,
		);
		expect(result.status).toBe("unavailable");
	});

	it("rejects unknown and cross-consumer fields", () => {
		expect(
			connectionCapability({ ...profile, consumerInstance: "other" }, approval),
		).toMatchObject({ status: "unavailable", reason: "invalid" });
	});
});

it.each([
	"/\n/evil.example",
	"/\r/evil.example",
	"/\t/evil.example",
	"/%5cevil.example",
	"/a b",
	"/a\u0000b",
])("rejects unsafe path %j", (mcpPath) => {
	expect(
		connectionCapability(
			{ ...profile, mcpPath },
			approve({ ...profile, mcpPath }),
		).status,
	).toBe("unavailable");
});
it.each([
	{ publicOrigin: "https://other.example.test" },
	{ consumerId: "other-consumer" },
	{ audience: "other-audience" },
	{ mcpPath: "/different" },
	{ egressProfile: { ref: "egress-platform", revision: "r2" } },
])("rejects changed approved snapshot %j", (change) => {
	expect(connectionCapability({ ...profile, ...change }, approval).status).toBe(
		"unavailable",
	);
});
it.each([
	{ ...approval, egressEnforced: false },
	undefined,
	true,
	{ ...approval, configFingerprint: "0".repeat(64) },
	{ ...approval, schemaVersion: 2 },
	{ ...approval, source: { ref: "", revision: "r1" } },
])("rejects missing or invalid approval %j", (input) => {
	expect(connectionCapability(profile, input).status).toBe("unavailable");
});

it("fails closed when the approved Web entry path is missing", () => {
	expect(createConnectionCapability(profile, approval, undefined).status).toBe(
		"unavailable",
	);
});

it("accepts an approved custom MCP path without rewriting it", () => {
	const candidate = { ...profile, mcpPath: "/client/mcp-v1" };
	expect(connectionCapability(candidate, approve(candidate))).toMatchObject({
		status: "available",
		mcpPath: candidate.mcpPath,
	});
});
