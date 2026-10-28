import { snapshotObject } from "./conversation-execution-values.js";

/** Server-created durable reference. It carries no dataset content or credential material. */
export interface EvaluationTaskBindingV1 {
	readonly schemaVersion: 1;
	readonly experimentId: string;
	readonly sampleId: string;
	readonly variantId: string;
	readonly datasetId: string;
	readonly versionId: string;
	readonly grantId: string;
	readonly grantRevision: number;
	readonly policyId: string;
	readonly policyRevision: number;
	readonly configurationRevision: number;
	readonly modelOptionId: string | null;
	readonly reasoningLevel: string | null;
	readonly toolEnvironment: string;
	readonly expiresAt: string;
}
export function parseEvaluationTaskBindingV1(
	input: unknown,
): EvaluationTaskBindingV1 {
	const value = snapshotObject(input, [
		"schemaVersion",
		"experimentId",
		"sampleId",
		"variantId",
		"datasetId",
		"versionId",
		"grantId",
		"grantRevision",
		"policyId",
		"policyRevision",
		"configurationRevision",
		"modelOptionId",
		"reasoningLevel",
		"toolEnvironment",
		"expiresAt",
	]);
	if (value.schemaVersion !== 1)
		throw new TypeError("Eval Task binding is invalid");
	for (const key of [
		"experimentId",
		"sampleId",
		"variantId",
		"datasetId",
		"versionId",
		"grantId",
		"policyId",
		"toolEnvironment",
	]) {
		const s = value[key];
		if (
			typeof s !== "string" ||
			!s ||
			s.length > 256 ||
			!s.isWellFormed() ||
			[...s].some(
				(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
			)
		)
			throw new TypeError("Eval Task binding is invalid");
	}
	for (const key of [
		"grantRevision",
		"policyRevision",
		"configurationRevision",
	]) {
		const count = value[key];
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)
			throw new TypeError("Eval Task binding is invalid");
	}
	for (const key of ["modelOptionId", "reasoningLevel"]) {
		const s = value[key];
		if (
			s !== null &&
			(typeof s !== "string" ||
				!s ||
				s.length > 256 ||
				!s.isWellFormed() ||
				[...s].some(
					(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
				))
		)
			throw new TypeError("Eval Task binding is invalid");
	}
	if (
		(value.modelOptionId === null) !== (value.reasoningLevel === null) ||
		typeof value.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(value.expiresAt)) ||
		new Date(value.expiresAt).toISOString() !== value.expiresAt
	)
		throw new TypeError("Eval Task binding is invalid");
	return value as unknown as EvaluationTaskBindingV1;
}
