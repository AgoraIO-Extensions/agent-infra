import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	connectionConsumerProfileFingerprintV1,
	parseConnectionConsumerSnapshotV1,
	resolveConnectionConsumerTargetV1,
	validateConnectionConsumerProfileV1,
} from "./connection-consumer-profile.js";

const profile = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp",
	consumerId: "consumer-1",
	audience: "agent-1",
	egressProfile: { ref: "egress/default", revision: "r1" },
};

const approval = {
	schemaVersion: 1 as const,
	configFingerprint: connectionConsumerProfileFingerprintV1(profile),
	egressEnforced: true as const,
	source: { ref: "main", revision: "abc" },
};

describe("Connection Consumer profile", () => {
	it("accepts the approved tuple and resolves the exact target", () => {
		const target = validateConnectionConsumerProfileV1(profile, approval);
		expect(target.url).toBe("https://connection.example.test/mcp");
		expect(target.configFingerprint).toBe(approval.configFingerprint);
		expect(target.source).toEqual(approval.source);
	});

	it("uses the contract fingerprint tuple", () => {
		const expected = createHash("sha256")
			.update(
				JSON.stringify([
					1,
					profile.publicOrigin,
					profile.mcpPath,
					profile.consumerId,
					profile.audience,
					"egress/default",
					"r1",
				]),
				"utf8",
			)
			.digest("hex");
		expect(approval.configFingerprint).toBe(expected);
	});

	it("fails closed for stale approval and request overrides", () => {
		expect(() =>
			validateConnectionConsumerProfileV1(profile, {
				...approval,
				configFingerprint: "0".repeat(64),
			}),
		).toThrow("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
		const target = validateConnectionConsumerProfileV1(profile, approval);
		expect(() =>
			resolveConnectionConsumerTargetV1(target, {
				publicOrigin: "https://attacker.example.test",
				consumerId: "other",
			}),
		).toThrow("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	});

	it("rejects unsafe origins and paths", () => {
		expect(() =>
			validateConnectionConsumerProfileV1(
				{ ...profile, publicOrigin: "http://connection.example.test" },
				approval,
			),
		).toThrow();
		expect(() =>
			validateConnectionConsumerProfileV1(
				{ ...profile, mcpPath: "/mcp/%2e%2e/admin" },
				approval,
			),
		).toThrow();
	});

	it("accepts only an approved profile and approval snapshot", () => {
		expect(parseConnectionConsumerSnapshotV1({ profile, approval })).toEqual({
			profile,
			approval,
		});
		expect(() =>
			parseConnectionConsumerSnapshotV1({
				profile,
				approval: { ...approval, configFingerprint: "0".repeat(64) },
			}),
		).toThrow("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	});
});
