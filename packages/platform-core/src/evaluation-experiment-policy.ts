import { snapshotAgentManagementDenseArray } from "./agent-management-input.js";
import { snapshotObject } from "./conversation-execution-values.js";
import { EvaluationDataErrorV1 } from "./evaluation-data.js";
import {
	type EvaluationScorerV1,
	parseEvaluationScorerV1,
} from "./evaluation-scoring.js";
export interface EvaluationExperimentPolicyV1 {
	readonly schemaVersion: 1;
	readonly policyId: string;
	readonly revision: number;
	readonly validUntil: string;
	readonly maximumTasks: number;
	readonly maximumInputBytes: number;
	readonly variants: readonly {
		variantId: string;
		agentId: string;
		configurationRevision: number;
		modelOptionId: string | null;
		reasoningLevel: string | null;
		toolEnvironment: string;
	}[];
	readonly scorers: readonly EvaluationScorerV1[];
}
const invalid = (): never => {
	throw new EvaluationDataErrorV1("invalid");
};
const text = (value: unknown): string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 256 &&
	value.isWellFormed() &&
	[...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
		? value
		: invalid();
const count = (value: unknown, max: number): number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= max
		? value
		: invalid();
export function parseEvaluationExperimentPolicyV1(
	input: unknown,
): EvaluationExperimentPolicyV1 {
	const v = snapshotObject(input, [
		"schemaVersion",
		"policyId",
		"revision",
		"validUntil",
		"maximumTasks",
		"maximumInputBytes",
		"variants",
		"scorers",
	]);
	if (
		v.schemaVersion !== 1 ||
		typeof v.validUntil !== "string" ||
		!Number.isFinite(Date.parse(v.validUntil)) ||
		new Date(v.validUntil).toISOString() !== v.validUntil
	)
		return invalid();
	const variants = snapshotAgentManagementDenseArray(v.variants, 100).map(
		(input) => {
			const x = snapshotObject(input, [
				"variantId",
				"agentId",
				"configurationRevision",
				"modelOptionId",
				"reasoningLevel",
				"toolEnvironment",
			]);
			const modelOptionId =
				x.modelOptionId === null ? null : text(x.modelOptionId);
			const reasoningLevel =
				x.reasoningLevel === null ? null : text(x.reasoningLevel);
			if (modelOptionId === null && reasoningLevel !== null) return invalid();
			return {
				variantId: text(x.variantId),
				agentId: text(x.agentId),
				configurationRevision: count(
					x.configurationRevision,
					Number.MAX_SAFE_INTEGER,
				),
				modelOptionId,
				reasoningLevel,
				toolEnvironment: text(x.toolEnvironment),
			};
		},
	);
	const scorers = snapshotAgentManagementDenseArray(v.scorers, 100).map(
		parseEvaluationScorerV1,
	);
	if (
		!variants.length ||
		!scorers.length ||
		new Set(variants.map((v) => v.variantId)).size !== variants.length ||
		new Set(scorers.map((s) => JSON.stringify([s.scorerId, s.version])))
			.size !== scorers.length
	)
		return invalid();
	return {
		schemaVersion: 1,
		policyId: text(v.policyId),
		revision: count(v.revision, Number.MAX_SAFE_INTEGER),
		validUntil: v.validUntil,
		maximumTasks: count(v.maximumTasks, 1000),
		maximumInputBytes: count(v.maximumInputBytes, 1024 * 1024),
		variants,
		scorers,
	};
}
