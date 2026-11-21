import {
	SkillPackageAdmissionErrorV1,
	SkillPackageMaterializerErrorV1,
} from "@agent-infra/object-storage";
import { SkillSyncErrorV1 } from "@agent-infra/platform-core";
import { expect, it } from "vitest";
import { classifySkillSyncFailureV1 } from "./skill-sync-failure.js";

it.each([
	"digest_mismatch",
	"signature_invalid",
	"scan_rejected",
	"source_untrusted",
] as const)("rejects %s without widening package admission", (code) => {
	expect(
		classifySkillSyncFailureV1(
			new SkillPackageAdmissionErrorV1(code),
			"package_verification",
		).failure,
	).toEqual({ stage: "package_verification", reason: code, retryable: false });
});
it.each(["materialization", "delivery"] as const)(
	"records a fixed %s dependency error with no message",
	(stage) => {
		const error = classifySkillSyncFailureV1(
			new Error("private-body"),
			"materialization",
		);
		expect(
			classifySkillSyncFailureV1(new Error("private-body"), stage).failure,
		).toEqual({ stage, reason: "dependency_unavailable", retryable: true });
		expect(JSON.stringify(error)).not.toContain("private-body");
	},
);
it("keeps a transient conflict distinct and strips extra untrusted error fields", () => {
	expect(
		classifySkillSyncFailureV1(
			new SkillPackageMaterializerErrorV1("conflict"),
			"materialization",
		).failure,
	).toMatchObject({ reason: "conflict", retryable: true });
	const error = new SkillSyncErrorV1({
		stage: "delivery",
		reason: "dependency_unavailable",
		retryable: true,
		secret: "must-not-log",
	} as never);
	expect(error.failure).toEqual({
		stage: "delivery",
		reason: "dependency_unavailable",
		retryable: true,
	});
});
