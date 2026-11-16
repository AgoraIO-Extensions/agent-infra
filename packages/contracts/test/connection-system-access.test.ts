import { describe, expect, it } from "vitest";

import {
	connectionSystemAccessFingerprintV1,
	deriveConnectionConsumerProfileV1,
	resolveApprovedConnectionConsumerProfileV1,
	resolveApprovedConnectionSystemAccessV1,
} from "../src/connection-consumer-profile.ts";

const system = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp",
	audience: "connection-api",
	egressProfile: { ref: "platform-egress", revision: "r1" },
	issuer: "https://connection.example.test/",
	oauthCallbackUrl:
		"https://platform.example.test/api/connection-installations/callback",
};
const approval = {
	schemaVersion: 1 as const,
	configFingerprint: connectionSystemAccessFingerprintV1(system),
	egressEnforced: true as const,
	source: { ref: "platform-deployment", revision: "r1" },
};

describe("one-time Connection system access", () => {
	it("is approved without any Consumer and derives a complete per-Agent profile", () => {
		const access = resolveApprovedConnectionSystemAccessV1(system, approval);
		if (access.status !== "available") throw new Error("unavailable");
		const derived = deriveConnectionConsumerProfileV1(access, {
			consumerId: "connection-agent-a",
			source: { ref: "connection-association:agent-a", revision: "3" },
		});
		expect(
			resolveApprovedConnectionConsumerProfileV1(
				derived.profile,
				derived.approval,
			),
		).toMatchObject({
			status: "available",
			profile: { consumerId: "connection-agent-a" },
			source: { ref: "connection-association:agent-a", revision: "3" },
		});
		// A later association revision yields a different source, never older material.
		expect(
			deriveConnectionConsumerProfileV1(access, {
				consumerId: "connection-agent-a",
				source: { ref: "connection-association:agent-a", revision: "4" },
			}).approval.source,
		).not.toEqual(derived.approval.source);
	});

	it.each([
		["consumerId", { ...system, consumerId: "platform" }],
		["agent map", { ...system, consumersByAgent: { a: "x" } }],
		["credential", { ...system, serviceCredential: "x".repeat(32) }],
		[
			"http origin",
			{ ...system, publicOrigin: "http://connection.example.test" },
		],
		["foreign issuer", { ...system, issuer: "https://other.example.test/" }],
		[
			"callback query",
			{ ...system, oauthCallbackUrl: `${system.oauthCallbackUrl}?a=1` },
		],
	])("rejects %s", (_name, input) => {
		expect(
			resolveApprovedConnectionSystemAccessV1(input, approval).status,
		).toBe("unavailable");
	});

	it("derives no profile from unapproved system access", () => {
		for (const access of [
			resolveApprovedConnectionSystemAccessV1(system, undefined),
			resolveApprovedConnectionSystemAccessV1(system, {
				...approval,
				egressEnforced: false,
			}),
		])
			expect(() =>
				deriveConnectionConsumerProfileV1(
					access as Parameters<typeof deriveConnectionConsumerProfileV1>[0],
					{
						consumerId: "connection-agent-a",
						source: { ref: "connection-association:agent-a", revision: "3" },
					},
				),
			).toThrow("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	});

	it("rejects an approval fingerprint for other fields or no egress enforcement", () => {
		expect(
			resolveApprovedConnectionSystemAccessV1(
				{ ...system, audience: "other" },
				approval,
			).status,
		).toBe("unavailable");
		expect(
			resolveApprovedConnectionSystemAccessV1(system, {
				...approval,
				egressEnforced: false,
			}).status,
		).toBe("unavailable");
	});
});
