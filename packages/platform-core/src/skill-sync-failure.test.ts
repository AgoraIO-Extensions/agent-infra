import { expect, it } from "vitest";
import {
	SkillSyncErrorV1,
	skillSyncFailureCodeV1,
} from "./skill-sync-failure.js";

it("rejects unknown stages/reasons and contradictory retry classifications before persistence", () => {
	for (const value of [
		{
			stage: "arbitrary-secret",
			reason: "dependency_unavailable",
			retryable: true,
		},
		{ stage: "delivery", reason: "vendor-body", retryable: true },
		{
			stage: "package_verification",
			reason: "signature_invalid",
			retryable: true,
		},
		{ stage: "delivery", reason: "dependency_unavailable", retryable: false },
	])
		expect(() => skillSyncFailureCodeV1(value as never)).toThrow(
			"Invalid Skill sync",
		);
});
it("freezes only fixed safe facts for later logging", () => {
	const input = {
		stage: "delivery" as const,
		reason: "dependency_unavailable" as const,
		retryable: true,
		secret: "no",
	};
	const error = new SkillSyncErrorV1(input);
	expect(error.message).toBe(
		"SKILL_SYNC_DELIVERY_DEPENDENCY_UNAVAILABLE_RETRYABLE",
	);
	expect(Object.isFrozen(error.failure)).toBe(true);
	expect(JSON.stringify(error)).not.toContain("secret");
});
