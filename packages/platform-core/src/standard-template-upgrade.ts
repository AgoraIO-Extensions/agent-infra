import { createHash } from "node:crypto";
import {
	AgentConfigurationError,
	type AgentConfigurationResultV1,
	parseStandardTemplateReleaseTargetV1,
	type ReleaseStandardTemplateCommandV1,
	type StandardTemplateReleaseTargetV1,
} from "./agent-configuration.js";

const idPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxTargets = 256;

export interface StandardTemplateUpgradeCommandV2 {
	readonly schemaVersion: 2;
	readonly releaseId: string;
	readonly templateId: string;
	readonly expectedImageDigest: string;
	readonly targetImageDigest: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface StandardTemplateUpgradeTargetResultV2 {
	readonly agentId: string;
	readonly status: "applied" | "failed";
	readonly configurationRevision: number | null;
	readonly errorCode: string | null;
	readonly compatibility?: StandardTemplateUpgradeCompatibilityResultV1;
}

export type StandardTemplateUpgradeCompatibilityStatusV1 =
	| "compatible"
	| "incompatible"
	| "unknown";

export type StandardTemplateUpgradeCompatibilityReasonV1 =
	| "projection_missing"
	| "projection_malformed"
	| "target_metadata_missing"
	| "agent_mismatch"
	| "template_mismatch"
	| "digest_mismatch"
	| "runtime_schema_mismatch"
	| "configuration_revision_mismatch"
	| "verified";

export interface StandardTemplateUpgradeCompatibilityResultV1 {
	readonly status: StandardTemplateUpgradeCompatibilityStatusV1;
	readonly agentId: string;
	/** The revision against which the compatibility fact was evaluated. */
	readonly configurationRevision: number;
	readonly targetImageDigest: string;
	readonly reasonCode: StandardTemplateUpgradeCompatibilityReasonV1;
}

export interface StandardTemplateUpgradeTargetMetadataV1 {
	readonly templateId: string;
	readonly targetImageDigest: string;
	/** Runtime schema expected by the published target. Missing is unknown. */
	readonly runtimeSchemaVersion: 1 | 4 | null;
}

export interface StandardTemplateUpgradeRuntimeFactsV1 {
	readonly agentId: string;
	readonly configurationRevision: number;
	readonly modelProjection: unknown | null;
}

function compatibilityResult(
	result: StandardTemplateUpgradeCompatibilityResultV1,
): StandardTemplateUpgradeCompatibilityResultV1 {
	return Object.freeze({ ...result });
}

/**
 * Classifies only already persisted Runtime facts. This is deliberately a
 * pure, fail-closed seam: it never creates or mutates Workload state.
 */
export function classifyStandardTemplateUpgradeCompatibilityV1(input: {
	readonly target: StandardTemplateReleaseTargetV1;
	readonly targetMetadata: StandardTemplateUpgradeTargetMetadataV1 | null;
	readonly runtimeFacts: StandardTemplateUpgradeRuntimeFactsV1 | null;
	readonly resultingConfigurationRevision?: number | null;
}): StandardTemplateUpgradeCompatibilityResultV1 {
	const revision =
		input.resultingConfigurationRevision ??
		input.runtimeFacts?.configurationRevision ??
		input.target.expectedConfigurationRevision;
	const base = {
		agentId: input.target.agentId,
		configurationRevision: revision,
		targetImageDigest: input.target.targetImageDigest,
	};
	if (!input.targetMetadata)
		return compatibilityResult({
			...base,
			status: "unknown",
			reasonCode: "target_metadata_missing",
		});
	if (
		input.targetMetadata.templateId !== input.target.templateId ||
		input.targetMetadata.targetImageDigest !== input.target.targetImageDigest
	)
		return compatibilityResult({
			...base,
			status: "incompatible",
			reasonCode: "template_mismatch",
		});
	const facts = input.runtimeFacts;
	if (!facts)
		return compatibilityResult({
			...base,
			status: "unknown",
			reasonCode: "projection_missing",
		});
	if (facts.agentId !== input.target.agentId)
		return compatibilityResult({
			...base,
			status: "unknown",
			reasonCode: "agent_mismatch",
		});
	const projection = facts.modelProjection;
	if (
		!projection ||
		typeof projection !== "object" ||
		Array.isArray(projection)
	)
		return compatibilityResult({
			...base,
			status: "unknown",
			reasonCode: "projection_missing",
		});
	const value = projection as Record<string, unknown>;
	const schemaVersion = value.schemaVersion;
	if (schemaVersion !== 1 && schemaVersion !== 4)
		return compatibilityResult({
			...base,
			status: "unknown",
			reasonCode: "projection_malformed",
		});
	if (
		input.targetMetadata.runtimeSchemaVersion === null ||
		schemaVersion !== input.targetMetadata.runtimeSchemaVersion
	)
		return compatibilityResult({
			...base,
			status:
				input.targetMetadata.runtimeSchemaVersion === null
					? "unknown"
					: "incompatible",
			reasonCode: "runtime_schema_mismatch",
		});
	if (value.agentId !== input.target.agentId)
		return compatibilityResult({
			...base,
			status: "unknown",
			reasonCode: "agent_mismatch",
		});
	if (
		value.configurationRevision !== input.resultingConfigurationRevision &&
		input.resultingConfigurationRevision !== null &&
		input.resultingConfigurationRevision !== undefined
	)
		return compatibilityResult({
			...base,
			status: "incompatible",
			reasonCode: "configuration_revision_mismatch",
		});
	const binding = value.standardTemplateBinding;
	if (!binding || typeof binding !== "object" || Array.isArray(binding))
		return compatibilityResult({
			...base,
			status: "unknown",
			reasonCode: "projection_malformed",
		});
	const bindingValue = binding as Record<string, unknown>;
	if (bindingValue.templateId !== input.target.templateId)
		return compatibilityResult({
			...base,
			status: "incompatible",
			reasonCode: "template_mismatch",
		});
	if (bindingValue.imageDigest !== input.target.targetImageDigest)
		return compatibilityResult({
			...base,
			status: "incompatible",
			reasonCode: "digest_mismatch",
		});
	return compatibilityResult({
		...base,
		status: "compatible",
		reasonCode: "verified",
	});
}

export interface StandardTemplateUpgradeResultV2 {
	readonly schemaVersion: 2;
	readonly releaseId: string;
	readonly templateId: string;
	readonly status: "completed" | "partial";
	readonly targets: readonly StandardTemplateUpgradeTargetResultV2[];
}

export interface StandardTemplateUpgradeTargetResolverV1 {
	discover(input: {
		readonly releaseId: string;
		readonly templateId: string;
		readonly expectedImageDigest: string;
		readonly targetImageDigest: string;
	}): Promise<readonly StandardTemplateReleaseTargetV1[]>;
}

export interface StandardTemplateUpgradeApplierV1 {
	apply(
		command: ReleaseStandardTemplateCommandV1,
	): Promise<AgentConfigurationResultV1>;
}

export interface StandardTemplateUpgradeCompatibilityResolverV1 {
	evaluate(input: {
		readonly target: StandardTemplateReleaseTargetV1;
		readonly configurationRevision: number | null;
	}): Promise<StandardTemplateUpgradeCompatibilityResultV1>;
}

function invalid(): never {
	throw new AgentConfigurationError("invalid_command");
}

function normalizeCommand(
	input: StandardTemplateUpgradeCommandV2,
): StandardTemplateUpgradeCommandV2 {
	if (
		typeof input !== "object" ||
		input === null ||
		Object.keys(input).length !== 8 ||
		input.schemaVersion !== 2 ||
		!idPattern.test(input.releaseId) ||
		!idPattern.test(input.templateId) ||
		!digestPattern.test(input.expectedImageDigest) ||
		!digestPattern.test(input.targetImageDigest) ||
		input.expectedImageDigest === input.targetImageDigest ||
		!idPattern.test(input.idempotencyKey) ||
		typeof input.requestId !== "string" ||
		input.requestId.length === 0 ||
		input.requestId.length > 1024 ||
		typeof input.traceId !== "string" ||
		input.traceId.length === 0 ||
		input.traceId.length > 1024
	)
		invalid();
	return {
		schemaVersion: 2,
		releaseId: input.releaseId,
		templateId: input.templateId,
		expectedImageDigest: input.expectedImageDigest,
		targetImageDigest: input.targetImageDigest,
		idempotencyKey: input.idempotencyKey,
		requestId: input.requestId,
		traceId: input.traceId,
	};
}

function targetKey(base: string, agentId: string): string {
	const suffix = createHash("sha256")
		.update(agentId)
		.digest("hex")
		.slice(0, 16);
	return `${base.slice(0, 110)}.${suffix}`;
}

function failureCode(error: unknown): string {
	if (error instanceof AgentConfigurationError) return error.code;
	return "dependency_unavailable";
}

function targetResult(
	result: StandardTemplateUpgradeTargetResultV2,
): StandardTemplateUpgradeTargetResultV2 {
	return Object.freeze({ ...result });
}

/**
 * Applies a deployment-owned template upgrade one Agent at a time.
 *
 * Discovery and each apply are deliberately separate: the existing V1 use case
 * remains responsible for the Agent transaction's CAS, audit, and idempotency.
 * A failed Agent is reported in place so a caller can retry the same fan-out
 * without treating a partial result as a successful release.
 */
export async function fanOutStandardTemplateUpgradeV2(
	input: StandardTemplateUpgradeCommandV2,
	resolver: StandardTemplateUpgradeTargetResolverV1,
	applier: (
		target: StandardTemplateReleaseTargetV1,
	) => StandardTemplateUpgradeApplierV1,
	compatibility?: StandardTemplateUpgradeCompatibilityResolverV1,
): Promise<StandardTemplateUpgradeResultV2> {
	const command = normalizeCommand(input);
	let discovered: readonly StandardTemplateReleaseTargetV1[];
	try {
		discovered = await resolver.discover(command);
	} catch {
		throw new AgentConfigurationError("dependency_unavailable");
	}
	if (!Array.isArray(discovered) || discovered.length > maxTargets)
		throw new AgentConfigurationError("dependency_unavailable");

	const seen = new Set<string>();
	for (const candidate of discovered) {
		let target: StandardTemplateReleaseTargetV1;
		try {
			target = parseStandardTemplateReleaseTargetV1(candidate);
		} catch {
			throw new AgentConfigurationError("dependency_unavailable");
		}
		if (
			seen.has(target.agentId) ||
			target.releaseId !== command.releaseId ||
			target.templateId !== command.templateId ||
			target.expectedImageDigest !== command.expectedImageDigest ||
			target.targetImageDigest !== command.targetImageDigest
		)
			throw new AgentConfigurationError("stale_revision");
		seen.add(target.agentId);
	}

	const targets: StandardTemplateUpgradeTargetResultV2[] = [];
	for (const candidate of discovered) {
		const target = parseStandardTemplateReleaseTargetV1(candidate);
		try {
			const result = await applier(target).apply({
				schemaVersion: 1,
				target,
				idempotencyKey: targetKey(command.idempotencyKey, target.agentId),
				requestId: targetKey(command.requestId, target.agentId),
				traceId: targetKey(command.traceId, target.agentId),
			});
			const appliedRevision = result.revision;
			let compatibilityResult:
				| StandardTemplateUpgradeCompatibilityResultV1
				| undefined;
			if (compatibility) {
				try {
					compatibilityResult = await compatibility.evaluate({
						target,
						configurationRevision: appliedRevision,
					});
				} catch {
					compatibilityResult = compatibilityResultForUnknown(
						target,
						appliedRevision,
					);
				}
			} else
				compatibilityResult = compatibilityResultForUnknown(
					target,
					appliedRevision,
				);
			targets.push(
				targetResult({
					agentId: target.agentId,
					status: "applied",
					configurationRevision: appliedRevision,
					errorCode: null,
					...(compatibilityResult
						? { compatibility: compatibilityResult }
						: {}),
				}),
			);
		} catch (error) {
			let compatibilityResult:
				| StandardTemplateUpgradeCompatibilityResultV1
				| undefined;
			if (compatibility) {
				try {
					compatibilityResult = await compatibility.evaluate({
						target,
						configurationRevision: null,
					});
				} catch {
					compatibilityResult = compatibilityResultForUnknown(target);
				}
			} else compatibilityResult = compatibilityResultForUnknown(target);
			targets.push(
				targetResult({
					agentId: target.agentId,
					status: "failed",
					configurationRevision: null,
					errorCode: failureCode(error),
					...(compatibilityResult
						? { compatibility: compatibilityResult }
						: {}),
				}),
			);
		}
	}

	return Object.freeze({
		schemaVersion: 2,
		releaseId: command.releaseId,
		templateId: command.templateId,
		status: targets.every(({ status }) => status === "applied")
			? ("completed" as const)
			: ("partial" as const),
		targets: Object.freeze(targets),
	});
}

function compatibilityResultForUnknown(
	target: StandardTemplateReleaseTargetV1,
	configurationRevision: number | null = null,
): StandardTemplateUpgradeCompatibilityResultV1 {
	return compatibilityResult({
		status: "unknown",
		agentId: target.agentId,
		configurationRevision:
			configurationRevision ?? target.expectedConfigurationRevision,
		targetImageDigest: target.targetImageDigest,
		reasonCode: "target_metadata_missing",
	});
}
