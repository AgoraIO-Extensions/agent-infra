import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	adoptTemplateValidationV2,
	standardTemplateReadinessV1,
	templateValidationPayloadHashV1,
} from "./template-readiness.js";

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

it("keeps an exact formally adopted registration ready beyond the candidate TTL while legacy evidence expires", () => {
	const context = {
		sourceCommit: "a".repeat(40),
		clusterUid: "11111111-1111-4111-8111-111111111111",
		namespace: "ack-test",
		namespaceUid: "22222222-2222-4222-8222-222222222222",
		installationId: "33333333-3333-4333-8333-333333333333",
	};
	const candidate = { ...validation, sourceCommit: context.sourceCommit };
	const canonical = {
		schemaVersion: candidate.schemaVersion,
		templateId: candidate.templateId,
		sourceCommit: candidate.sourceCommit,
		imageDigest: candidate.imageDigest,
		driver: candidate.driver,
		configurationRevision: candidate.configurationRevision,
		status: candidate.status,
		evidenceKind: candidate.evidenceKind,
		executionId: candidate.executionId,
		modelId: candidate.modelId,
		validatedAt: candidate.validatedAt,
		validUntil: candidate.validUntil,
	};
	const input = {
		templateId: "claude",
		imageDigest: binding.imageDigest,
		binding,
		configurationRevision: "config-1",
		validationContext: context,
		now: 2_000,
	};
	expect(
		standardTemplateReadinessV1({ ...input, validation: candidate }),
	).toMatchObject({ state: "stale" });
	expect(
		standardTemplateReadinessV1({
			...input,
			validation: {
				schemaVersion: 2,
				kind: "adopted-template-validation",
				candidate,
				adoption: {
					adoptedAt: 500,
					candidatePayloadSha256: createHash("sha256")
						.update(JSON.stringify(canonical))
						.digest("hex"),
					provenance: {
						candidateFileSha256: "b".repeat(64),
						preflightFileSha256: "c".repeat(64),
					},
					target: context,
				},
			},
		}),
	).toMatchObject({ state: "ready" });
});

const context = {
	sourceCommit: "a".repeat(40),
	clusterUid: "cluster-a",
	namespace: "ack-test",
	namespaceUid: "namespace-a",
	installationId: "installation-a",
};
const adopt = () =>
	adoptTemplateValidationV2({
		candidate: { ...validation, sourceCommit: context.sourceCommit },
		context,
		adoptedAt: 500,
		candidateFileSha256: "b".repeat(64),
		preflightFileSha256: "c".repeat(64),
	});
const read = (record: unknown, expected = context) =>
	standardTemplateReadinessV1({
		templateId: "claude",
		imageDigest: binding.imageDigest,
		binding,
		configurationRevision: "config-1",
		validationContext: expected,
		validation: record,
		now: 10_000,
	});

it("keeps adopted readiness identity stable across the old TTL and rejects missing expected context", () => {
	const record = adopt();
	const result = read(record);
	expect(result.state).toBe("ready");
	expect(
		standardTemplateReadinessV1({
			templateId: "claude",
			imageDigest: binding.imageDigest,
			binding,
			configurationRevision: "config-1",
			validationContext: context,
			validation: record,
			now: 600,
		}),
	).toEqual(result);
	expect(
		standardTemplateReadinessV1({
			templateId: "claude",
			imageDigest: binding.imageDigest,
			binding,
			configurationRevision: "config-1",
			validation: record,
			now: 10_000,
		}).state,
	).toBe("unverified");
});

it.each([
	"sourceCommit",
	"clusterUid",
	"namespace",
	"namespaceUid",
	"installationId",
] as const)("rejects adopted evidence from a different %s", (field) => {
	expect(
		read(adopt(), {
			...context,
			[field]: field === "sourceCommit" ? "d".repeat(40) : "different",
		}).state,
	).not.toBe("ready");
});

it("compares schema canonical payloads after JSON parsing and rejects altered fields", () => {
	const candidate = { ...validation, sourceCommit: context.sourceCommit };
	const reordered = Object.fromEntries(Object.entries(candidate).reverse());
	expect(
		templateValidationPayloadHashV1(
			JSON.parse(JSON.stringify(reordered, null, 4)),
		),
	).toBe(templateValidationPayloadHashV1(candidate));
	expect(
		templateValidationPayloadHashV1({ ...candidate, modelId: "different" }),
	).not.toBe(templateValidationPayloadHashV1(candidate));
	const record = adopt();
	record.candidate.modelId = "different";
	expect(read(record).state).not.toBe("ready");
});

it.each([1000, 1001, 99, -1])(
	"refuses candidate adoption at invalid time %s",
	(adoptedAt) => {
		expect(() =>
			adoptTemplateValidationV2({
				candidate: { ...validation, sourceCommit: context.sourceCommit },
				context,
				adoptedAt,
				candidateFileSha256: "b".repeat(64),
				preflightFileSha256: "c".repeat(64),
			}),
		).toThrow();
	},
);

it.each(["failed", "disabled"] as const)(
	"preserves %s rejection and never falls back to prior passed evidence",
	(status) => {
		const record = adopt();
		record.candidate.status = status;
		record.adoption.candidatePayloadSha256 = templateValidationPayloadHashV1(
			record.candidate,
		);
		expect(read(record).state).toBe(status);
	},
);

it("rejects forged adoption metadata, simulation, future adoption and extra caller fields", () => {
	for (const change of [
		(r: ReturnType<typeof adopt>) => {
			r.adoption.candidatePayloadSha256 = "f".repeat(64);
		},
		(r: ReturnType<typeof adopt>) => {
			r.adoption.adoptedAt = 10_001;
		},
		(r: ReturnType<typeof adopt>) => {
			r.adoption.adoptedAt = 1000;
		},
		(r: ReturnType<typeof adopt>) => {
			r.candidate.evidenceKind = "simulation";
			r.adoption.candidatePayloadSha256 = templateValidationPayloadHashV1(
				r.candidate,
			);
		},
	]) {
		const record = adopt();
		change(record);
		expect(read(record).state).not.toBe("ready");
	}
	expect(read({ ...adopt(), approved: true }).state).not.toBe("ready");
});

it("accepts a source-bound preflight candidate", () => {
	expect(
		standardTemplateReadinessV1({
			templateId: "claude",
			imageDigest: binding.imageDigest,
			binding,
			configurationRevision: "config-1",
			validation: { ...validation, sourceCommit: "a".repeat(40) },
			now: 500,
		}),
	).toMatchObject({ state: "ready" });
});

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
