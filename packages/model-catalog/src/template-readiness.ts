import { createHash } from "node:crypto";
import { z } from "zod";
import { modelIdentifier } from "./catalog.js";
import {
	type StandardTemplateModelBindingV1,
	validateStandardTemplateModelBindingsV1,
} from "./projection.js";

/** Deployment-owned evidence; never accept this record from an applicant. */
const validationSchema = z.strictObject({
	schemaVersion: z.literal(1),
	templateId: modelIdentifier,
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

export function standardTemplateReadinessV1(input: {
	templateId: string;
	imageDigest: string;
	binding?: StandardTemplateModelBindingV1;
	configurationRevision?: string;
	validation: unknown;
	now: number;
}) {
	const unavailable = (
		state: "unverified" | "failed" | "disabled" | "stale",
	) => ({ state, revision: null });
	const parsed = validationSchema.safeParse(input.validation);
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
		evidence.validUntil <= input.now ||
		evidence.validUntil <= evidence.validatedAt
	)
		return unavailable("stale");
	if (evidence.status === "failed") return unavailable("failed");
	return {
		state: "ready" as const,
		revision: createHash("sha256")
			.update(JSON.stringify([binding, evidence]))
			.digest("hex"),
	};
}
