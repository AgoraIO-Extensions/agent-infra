import {
	createSkillWorkloadProjectionV1,
	type SkillGrantV1,
	type SkillVersionRefV1,
	SkillWorkloadProjectionV1Schema,
	type SkillWorkloadProjectionV1,
} from "@agent-infra/contracts";
import type {
	SkillPackageMaterializationInputV1,
	SkillPackageMaterializerV1,
} from "@agent-infra/object-storage";
import type { SkillPackagePublicationObjectV1 } from "@agent-infra/platform-core";

export type WorkloadSkillMaterializationInputV1 = Readonly<{
	agentId: string;
	configurationRevision: number;
	workloadRevision: number;
	fence: number;
	signal?: AbortSignal;
}>;

export type WorkloadSkillMaterializationResultV1 = Readonly<{
	generationId: string;
	skills: readonly SkillWorkloadProjectionV1[];
}>;

/** Existing deployment assembly supplies the DB/object-storage-backed implementation. */
export interface WorkloadSkillMaterializerV1 {
	materialize(
		input: WorkloadSkillMaterializationInputV1,
	): Promise<WorkloadSkillMaterializationResultV1>;
}

export type WorkloadSkillMaterializationBindingV1 = Readonly<{
	readonly name: string;
	readonly agentVersion: string;
	readonly skillVersion: SkillVersionRefV1;
	readonly packageObject: SkillPackagePublicationObjectV1;
	readonly grant: SkillGrantV1;
}>;

/**
 * Deployment-owned bridge from the immutable physical adapter to Worker Desired.
 * The resolver supplies fixed DB/object references; it never receives caller paths.
 */
export function createObjectStorageWorkloadSkillMaterializerV1(options: {
	readonly materializer: Pick<
		SkillPackageMaterializerV1,
		"materialize" | "readCurrentDetails"
	>;
	readonly resolveBindings: (
		input: WorkloadSkillMaterializationInputV1,
	) => Promise<readonly WorkloadSkillMaterializationBindingV1[]>;
}): WorkloadSkillMaterializerV1 {
	return {
		async materialize(input) {
			const bindings = await options.resolveBindings(input);
			if (bindings.length > 10) throw new Error("Too many Skills");
			if (new Set(bindings.map((binding) => binding.agentVersion)).size > 1)
				throw new Error("Skill bindings span multiple Agent versions");
			const requested: SkillPackageMaterializationInputV1[] = bindings.map(
				(binding) => ({
					name: binding.name,
					version: binding.skillVersion.version,
					packageObject: binding.packageObject,
					packageDigest: binding.skillVersion.packageDigest,
					manifestDigest: binding.skillVersion.manifestDigest,
				}),
			);
			const result = await options.materializer.materialize({
				packages: requested,
			});
			const details = await options.materializer.readCurrentDetails();
			if (!details || details.result.generationId !== result.generationId)
				throw new Error("Skill materialization generation unavailable");
			const bindingByName = new Map(
				bindings.map((binding) => [binding.name, binding]),
			);
			const skills = details.packages.map((detail) => {
				const binding = bindingByName.get(detail.input.name);
				if (!binding) throw new Error("Skill materialization binding mismatch");
				return createSkillWorkloadProjectionV1({
					agentId: input.agentId,
					agentVersion: binding.agentVersion,
					skillVersion: binding.skillVersion,
					manifest: detail.manifest,
					manifestDigest: detail.manifestDigest,
					grant: binding.grant,
				});
			});
			return validateWorkloadSkillMaterializationV1(input, {
				generationId: result.generationId,
				skills,
			});
		},
	};
}

export function validateWorkloadSkillMaterializationV1(
	input: WorkloadSkillMaterializationInputV1,
	result: WorkloadSkillMaterializationResultV1,
): WorkloadSkillMaterializationResultV1 {
	if (
		!input ||
		!Number.isSafeInteger(input.configurationRevision) ||
		input.configurationRevision < 1 ||
		!Number.isSafeInteger(input.workloadRevision) ||
		input.workloadRevision < 1 ||
		!Number.isSafeInteger(input.fence) ||
		input.fence < 1 ||
		typeof result?.generationId !== "string" ||
		!/^[a-f0-9]{64}$/.test(result.generationId) ||
		!Array.isArray(result.skills) ||
		result.skills.length > 32
	)
		throw new Error("Invalid Skill materialization receipt");
	const skills = result.skills.map((skill) =>
		SkillWorkloadProjectionV1Schema.parse(skill),
	);
	if (
		skills.some((skill) => skill.agentId !== input.agentId) ||
		new Set(skills.map((skill) => skill.targetPath)).size !== skills.length
	)
		throw new Error("Skill materialization identity mismatch");
	return Object.freeze({
		generationId: result.generationId,
		skills: Object.freeze(skills),
	});
}
