import {
	createSkillWorkloadProjectionV1,
	type SkillGrantV1,
	type SkillHubAppliedReceiptV1,
	type SkillVersionRefV1,
	type SkillWorkloadProjectionV1,
	SkillWorkloadProjectionV1Schema,
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
	readonly agentId: string;
	readonly name: string;
	readonly agentVersion: string;
	readonly skillVersion: SkillVersionRefV1;
	readonly packageObject: SkillPackagePublicationObjectV1;
	readonly grant: SkillGrantV1;
	readonly syncRevision: number;
}>;

/**
 * Deployment-owned bridge from the immutable physical adapter to Worker Desired.
 * The resolver supplies fixed DB/object references; it never receives caller paths.
 */
export function createObjectStorageWorkloadSkillMaterializerV1(options: {
	readonly materializerFor: (
		input: WorkloadSkillMaterializationInputV1,
	) => Pick<SkillPackageMaterializerV1, "materialize" | "readCurrentDetails">;
	readonly resolveBindings: (
		input: WorkloadSkillMaterializationInputV1,
	) => Promise<readonly WorkloadSkillMaterializationBindingV1[]>;
	/** Existing Store-owned Applied receipt writer; never caller-controlled. */
	readonly writeAppliedReceipt?: (
		receipt: SkillHubAppliedReceiptV1,
	) => Promise<void>;
}): WorkloadSkillMaterializerV1 {
	return {
		async materialize(input) {
			const materializer = options.materializerFor(input);
			const current = await materializer.readCurrentDetails();
			const bindings = await options.resolveBindings(input);
			if (bindings.length > 10) throw new Error("Too many Skills");
			if (bindings.some((binding) => binding.agentId !== input.agentId))
				throw new Error("Skill binding Agent mismatch");
			if (new Set(bindings.map((binding) => binding.agentVersion)).size > 1)
				throw new Error("Skill bindings span multiple Agent versions");
			if (
				new Set(bindings.map((binding) => binding.name)).size !==
					bindings.length ||
				bindings.some(
					(binding) =>
						binding.packageObject.version !==
							binding.skillVersion.packageObjectVersion ||
						binding.packageObject.sha256 !==
							binding.skillVersion.packageDigest ||
						binding.packageObject.mediaType !== "application/zip",
				)
			)
				throw new Error("Skill binding object mismatch");
			const requested: SkillPackageMaterializationInputV1[] = bindings.map(
				(binding) => ({
					name: binding.name,
					version: binding.skillVersion.version,
					packageObject: binding.packageObject,
					packageDigest: binding.skillVersion.packageDigest,
					manifestDigest: binding.skillVersion.manifestDigest,
				}),
			);
			const result = await materializer.materialize({
				packages: requested,
				expectedGenerationId: current?.result.generationId ?? null,
			});
			const details = await materializer.readCurrentDetails();
			if (
				!details ||
				details.result.generationId !== result.generationId ||
				details.packages.length !== bindings.length
			)
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
			if (
				bindings.some((binding) => {
					const detail = details.packages.find(
						(candidate) => candidate.input.name === binding.name,
					);
					return (
						!detail ||
						detail.input.packageDigest !== binding.skillVersion.packageDigest ||
						detail.manifestDigest !== binding.skillVersion.manifestDigest
					);
				})
			)
				throw new Error("Skill materialization binding mismatch");
			if (bindings.length > 0 && !options.writeAppliedReceipt)
				throw new Error("Skill Applied receipt writer unavailable");
			if (options.writeAppliedReceipt) {
				for (const binding of bindings) {
					await options.writeAppliedReceipt({
						schemaVersion: 1,
						agentId: input.agentId,
						agentVersion: binding.agentVersion,
						skillName: binding.name,
						configurationRevision: input.configurationRevision,
						syncRevision: binding.syncRevision,
						skillVersionId: binding.skillVersion.skillVersionId,
						generationId: result.generationId,
						packageDigest: binding.skillVersion.packageDigest,
						manifestDigest: binding.skillVersion.manifestDigest,
						targetPath: `.agents/skills/${binding.name}`,
						readOnly: true,
					});
				}
			}
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
