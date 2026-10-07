import { describe, expect, it } from "vitest";

import { resolveApprovedConnectionConsumerProfileV1 } from "../src/connection-consumer-profile.ts";

const profile = {
	schemaVersion: 1,
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp",
	consumerId: "platform-web",
	audience: "connection-api",
	egressProfile: { ref: "egress-platform", revision: "r1" },
};
const fingerprint =
	"7821b88d0acd40836eed51877a2e959774434f72cc4672475f7da41c89359331";
const approval = {
	schemaVersion: 1,
	configFingerprint: fingerprint,
	egressEnforced: true,
	source: { ref: "platform-deployment", revision: "r1" },
};

describe("approved Connection Consumer Profile", () => {
	it("supplies the complete approved snapshot and source to process consumers", () => {
		expect(
			resolveApprovedConnectionConsumerProfileV1(profile, approval),
		).toEqual({
			status: "available",
			schemaVersion: 1,
			profile,
			configFingerprint: fingerprint,
			source: approval.source,
		});
	});

	it.each([
		{ consumerId: "another-consumer" },
		{ audience: "another-resource" },
		{ publicOrigin: "https://another.example.test" },
		{ mcpPath: "/another/mcp" },
		{ egressProfile: { ref: "egress-platform", revision: "r2" } },
	])("does not expose a changed approved snapshot: %j", (change) => {
		expect(
			resolveApprovedConnectionConsumerProfileV1(
				{ ...profile, ...change },
				approval,
			),
		).toEqual({ status: "unavailable", schemaVersion: 1, reason: "invalid" });
	});

	it.each([
		{ token: "fixture-only-token" },
		{ consumerInstance: "other-instance" },
		{ actorId: "other-actor" },
	])("rejects credentials and caller identity fields: %j", (fields) => {
		expect(
			resolveApprovedConnectionConsumerProfileV1(
				{ ...profile, ...fields },
				approval,
			),
		).toEqual({ status: "unavailable", schemaVersion: 1, reason: "invalid" });
	});

	it.each([
		undefined,
		{ ...approval, egressEnforced: false },
		{ ...approval, source: { ref: "platform-deployment", revision: "" } },
		{ ...approval, token: "fixture-only-token" },
	])("requires the complete nonsecret approval: %j", (input) => {
		expect(resolveApprovedConnectionConsumerProfileV1(profile, input)).toEqual({
			status: "unavailable",
			schemaVersion: 1,
			reason: "unapproved",
		});
	});

	it("keeps the approved profile and source detached from mutable input", () => {
		const input = structuredClone(profile);
		const approved = structuredClone(approval);
		const result = resolveApprovedConnectionConsumerProfileV1(input, approved);
		input.consumerId = "changed-after-validation";
		input.egressProfile.revision = "r2";
		approved.source.revision = "r2";
		expect(result).toEqual({
			status: "available",
			schemaVersion: 1,
			profile,
			configFingerprint: fingerprint,
			source: approval.source,
		});
	});
});
