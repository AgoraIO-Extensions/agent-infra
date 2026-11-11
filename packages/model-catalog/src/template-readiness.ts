import { createHash } from "node:crypto";
import { z } from "zod";
import { modelIdentifier } from "./catalog.js";
import {
	type StandardTemplateModelBindingV1,
	validateStandardTemplateModelBindingsV1,
} from "./projection.js";

/** Deployment-owned evidence; never accept this record from an applicant. */
const templateValidationCandidateV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	templateId: modelIdentifier,
	/** Optional on legacy evidence; formal adoption requires the current source. */
	sourceCommit: z
		.string()
		.regex(/^[a-f0-9]{40}$/)
		.optional(),
	imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	driver: z.enum(["codex", "claude", "acp", "pi"]),
	configurationRevision: modelIdentifier,
	status: z.enum(["passed", "failed", "disabled"]),
	evidenceKind: z.enum(["real-runtime-model", "simulation"]),
	executionId: modelIdentifier,
	modelId: modelIdentifier,
	validatedAt: z.number().int().nonnegative(),
	validUntil: z.number().int().positive(),
});

export const templateValidationContextV1Schema = z.strictObject({
	sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
	clusterUid: modelIdentifier,
	namespace: z.string().regex(/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/),
	namespaceUid: modelIdentifier,
	installationId: modelIdentifier,
});
export type TemplateValidationContextV1 = z.infer<
	typeof templateValidationContextV1Schema
>;

const fileHash = z.string().regex(/^[a-f0-9]{64}$/);
const adoptedValidationSchema = z.strictObject({
	schemaVersion: z.literal(2),
	kind: z.literal("adopted-template-validation"),
	candidate: templateValidationCandidateV1Schema,
	adoption: z.strictObject({
		adoptedAt: z.number().int().nonnegative(),
		candidatePayloadSha256: fileHash,
		provenance: z.strictObject({
			candidateFileSha256: fileHash,
			preflightFileSha256: fileHash,
		}),
		target: templateValidationContextV1Schema,
	}),
});
export type AdoptedTemplateValidationV2 = z.infer<
	typeof adoptedValidationSchema
>;

/** The payload digest is reproducible after JSON parsing; file digests are provenance only. */
export function templateValidationPayloadHashV1(value: unknown): string {
	const v = templateValidationCandidateV1Schema.parse(value);
	return createHash("sha256")
		.update(
			JSON.stringify({
				schemaVersion: v.schemaVersion,
				templateId: v.templateId,
				...(v.sourceCommit === undefined
					? {}
					: { sourceCommit: v.sourceCommit }),
				imageDigest: v.imageDigest,
				driver: v.driver,
				configurationRevision: v.configurationRevision,
				status: v.status,
				evidenceKind: v.evidenceKind,
				executionId: v.executionId,
				modelId: v.modelId,
				validatedAt: v.validatedAt,
				validUntil: v.validUntil,
			}),
		)
		.digest("hex");
}

export function parseAdoptedTemplateValidationV2(
	value: unknown,
	context: TemplateValidationContextV1,
	now: number,
): AdoptedTemplateValidationV2 {
	const record = adoptedValidationSchema.parse(value);
	const target = templateValidationContextV1Schema.parse(context);
	const { candidate, adoption } = record;
	if (
		!Number.isSafeInteger(now) ||
		now < 0 ||
		JSON.stringify(adoption.target) !== JSON.stringify(target) ||
		candidate.sourceCommit !== target.sourceCommit ||
		adoption.candidatePayloadSha256 !==
			templateValidationPayloadHashV1(candidate) ||
		adoption.adoptedAt > now ||
		adoption.adoptedAt < candidate.validatedAt ||
		adoption.adoptedAt >= candidate.validUntil ||
		candidate.validUntil <= candidate.validatedAt ||
		candidate.validUntil - candidate.validatedAt > 60 * 60 * 1000
	)
		throw new TypeError("TEMPLATE_ADOPTION_INVALID");
	return record;
}

/** Called only by the formal publisher after real preflight, target and freshness gates. */
export function adoptTemplateValidationV2(input: {
	candidate: unknown;
	context: TemplateValidationContextV1;
	adoptedAt: number;
	candidateFileSha256: string;
	preflightFileSha256: string;
}): AdoptedTemplateValidationV2 {
	const candidate = templateValidationCandidateV1Schema.parse(input.candidate);
	if (
		candidate.status !== "passed" ||
		candidate.evidenceKind !== "real-runtime-model"
	)
		throw new TypeError("TEMPLATE_ADOPTION_INVALID");
	return parseAdoptedTemplateValidationV2(
		{
			schemaVersion: 2,
			kind: "adopted-template-validation",
			candidate,
			adoption: {
				adoptedAt: input.adoptedAt,
				candidatePayloadSha256: templateValidationPayloadHashV1(candidate),
				provenance: {
					candidateFileSha256: input.candidateFileSha256,
					preflightFileSha256: input.preflightFileSha256,
				},
				target: input.context,
			},
		},
		input.context,
		input.adoptedAt,
	);
}

export function standardTemplateReadinessV1(input: {
	templateId: string;
	imageDigest: string;
	binding?: StandardTemplateModelBindingV1;
	configurationRevision?: string;
	validationContext?: TemplateValidationContextV1;
	validation: unknown;
	now: number;
}) {
	const unavailable = (
		state: "unverified" | "failed" | "disabled" | "stale",
	) => ({ state, revision: null });
	const adopted =
		(input.validation as { schemaVersion?: unknown } | null)?.schemaVersion ===
		2;
	let record: AdoptedTemplateValidationV2 | undefined;
	if (adopted) {
		try {
			if (!input.validationContext) return unavailable("unverified");
			record = parseAdoptedTemplateValidationV2(
				input.validation,
				input.validationContext,
				input.now,
			);
		} catch {
			return unavailable("unverified");
		}
	}
	const parsed = templateValidationCandidateV1Schema.safeParse(
		record?.candidate ?? input.validation,
	);
	if (!parsed.success || !input.binding || !input.configurationRevision)
		return unavailable("unverified");
	let binding: StandardTemplateModelBindingV1 | undefined;
	try {
		binding = validateStandardTemplateModelBindingsV1([input.binding])[0];
	} catch {
		return unavailable("unverified");
	}
	const evidence = parsed.data;
	if (
		!binding ||
		binding.templateId !== input.templateId ||
		binding.imageDigest !== input.imageDigest ||
		evidence.templateId !== input.templateId ||
		evidence.imageDigest !== input.imageDigest ||
		evidence.driver !== binding.driver ||
		evidence.configurationRevision !== input.configurationRevision
	)
		return unavailable("stale");
	if (evidence.status === "disabled") return unavailable("disabled");
	if (evidence.evidenceKind !== "real-runtime-model")
		return unavailable("unverified");
	if (
		evidence.validatedAt > input.now ||
		(!adopted && evidence.validUntil <= input.now) ||
		evidence.validUntil <= evidence.validatedAt
	)
		return unavailable("stale");
	if (evidence.status === "failed") return unavailable("failed");
	return {
		state: "ready" as const,
		revision: createHash("sha256")
			.update(JSON.stringify([binding, record ?? evidence]))
			.digest("hex"),
	};
}
