import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import { expect, it } from "vitest";

const document = JSON.parse(
	readFileSync(
		new URL("../../connection-contracts/openapi.json", import.meta.url),
		"utf8",
	),
);
const request = {
	id: "request-1",
	providerId: "jira",
	providerReleaseId: "jira-v1",
	capabilityProfileName: "Read",
	purpose: "Test",
	renewal: false,
	duration: { kind: "FINITE", days: 90 },
	state: "IN_REVIEW",
	currentStageOrdinal: 1,
	revision: "1",
	expiresAt: "2030-01-01T00:00:00Z",
	connectExpiresAt: null,
	createdAt: "2026-09-01T00:00:00Z",
	stages: [],
};

it("validates composed approval responses without accepting unknown fields", () => {
	const examples = [
		["AccessRequest", request, { ...request, unexpected: true }],
		[
			"ApprovalQueueItem",
			{
				...request,
				applicantDisplayName: "Alice",
				approverPrincipalId: "reviewer",
				currentRequestStageId: "stage-1",
			},
			{ ...request, applicantDisplayName: "Alice" },
		],
		[
			"ApprovalRoutingBlockedResponse",
			{ requests: [{ ...request, applicantDisplayName: "Alice" }] },
			{
				requests: [
					{ ...request, applicantDisplayName: "Alice", unexpected: true },
				],
			},
		],
	] as const;
	for (const [name, valid, invalid] of examples) {
		const validator = new Validator({
			...document,
			$ref: `#/components/schemas/${name}`,
		});
		expect(validator.validate(valid).valid, name).toBe(true);
		expect(validator.validate(invalid).valid, name).toBe(false);
		expect(validator.validate({ ...valid, unexpected: true }).valid, name).toBe(
			false,
		);
	}
});
