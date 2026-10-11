import { expect, it } from "vitest";
import { standardTemplateReadinessV1 } from "./template-readiness.js";

const binding = {
	templateId: "claude",
	imageDigest: `sha256:${"a".repeat(64)}`,
	driver: "claude" as const,
	protocol: "anthropic-messages-v1" as const,
};

const validation = {
	schemaVersion: 1,
	templateId: "claude",
	imageDigest: binding.imageDigest,
	driver: "claude",
	configurationRevision: "config-1",
	status: "passed",
	evidenceKind: "real-runtime-model",
	executionId: "execution-1",
	modelId: "claude-opus-5",
	validatedAt: 100,
	validUntil: 1_000,
};

it("only marks matching, non-expired real runtime evidence ready", () => {
	expect(
		standardTemplateReadinessV1({
			templateId: "claude",
			imageDigest: binding.imageDigest,
			binding,
			configurationRevision: "config-1",
			validation,
			now: 500,
		}),
	).toMatchObject({ state: "ready" });
	expect(
		standardTemplateReadinessV1({
			templateId: "claude",
			imageDigest: binding.imageDigest,
			binding,
			configurationRevision: "config-1",
			validation: { ...validation, evidenceKind: "simulation" },
			now: 500,
		}),
	).toMatchObject({ state: "unverified" });
	expect(
		standardTemplateReadinessV1({
			templateId: "claude",
			imageDigest: binding.imageDigest,
			binding,
			configurationRevision: "config-1",
			validation,
			now: 1_000,
		}),
	).toMatchObject({ state: "stale" });
});
