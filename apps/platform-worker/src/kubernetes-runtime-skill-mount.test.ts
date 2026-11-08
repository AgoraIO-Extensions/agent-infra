import { expect, it } from "vitest";
import { frozenSkillHubDeliveryImageV1 } from "./kubernetes-runtime-skill-mount.js";

const original = `registry.example.test/worker@sha256:${"a".repeat(64)}`;
const upgraded = `registry.example.test/worker@sha256:${"b".repeat(64)}`;

it("selects delivery for the first Skill binding on an existing unbound Agent", () => {
	expect(
		frozenSkillHubDeliveryImageV1({
			configuredImage: upgraded,
			candidate: null,
			verified: {},
			workloadExists: true,
		}),
	).toBe(upgraded);
});

it("keeps the verified delivery image when a new configuration is materialized", () => {
	expect(
		frozenSkillHubDeliveryImageV1({
			configuredImage: upgraded,
			candidate: null,
			verified: {
				skillDeliveryImage: original,
				skillGenerationId: "c".repeat(64),
			},
			workloadExists: true,
		}),
	).toBe(original);
});

it.each([true, false])(
	"keeps a verified PVC generation during recovery (exists=%s)",
	(workloadExists) => {
		expect(
			frozenSkillHubDeliveryImageV1({
				configuredImage: upgraded,
				candidate: null,
				verified: { skillGenerationId: "c".repeat(64) },
				workloadExists,
			}),
		).toBeUndefined();
	},
);

it.each([
	{},
	{ skillDeliveryImage: original, skillGenerationId: "c".repeat(64) },
])(
	"preserves a persisted candidate instead of changing its delivery mode",
	(candidate) => {
		expect(
			frozenSkillHubDeliveryImageV1({
				configuredImage: upgraded,
				candidate,
				verified: { skillDeliveryImage: upgraded },
				workloadExists: true,
			}),
		).toBe(candidate.skillDeliveryImage);
	},
);

it("does not infer a mode for an existing Workload with no verified deployment", () => {
	expect(
		frozenSkillHubDeliveryImageV1({
			configuredImage: upgraded,
			candidate: null,
			verified: null,
			workloadExists: true,
		}),
	).toBeUndefined();
});

it("selects the configured delivery for a new Agent", () => {
	expect(
		frozenSkillHubDeliveryImageV1({
			configuredImage: upgraded,
			candidate: null,
			verified: null,
			workloadExists: false,
		}),
	).toBe(upgraded);
});
