import { RuntimeSkillHubBindingV1Schema } from "@agent-infra/contracts/runtime";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

/** Fixed Worker-owned mount root consumed by the Runtime Host Skill seam. */
export const skillHubWorkloadMountRootV1 = "/opt/agent-infra-skill-hub";
export const skillHubRuntimeDataSubPathV1 = "runtime-data";

export function skillHubVolumeMountV1(
	value: Pick<AgentWorkloadDesiredV1, "skillGenerationId">,
): {
	readonly name: string;
	readonly mountPath: string;
	readonly subPath: string;
	readonly readOnly: true;
} | null {
	const generationId = value.skillGenerationId;
	if (generationId === undefined) return null;
	if (!/^[a-f0-9]{64}$/.test(generationId))
		throw new WorkloadKubernetesError("policy");
	return {
		name: "data",
		mountPath: `${skillHubWorkloadMountRootV1}/.agents`,
		subPath: `generations/${generationId}/.agents`,
		readOnly: true,
	};
}

export function skillHubRuntimeBindingV1(value: AgentWorkloadDesiredV1) {
	if (
		value.skillGenerationId === undefined &&
		value.skills === undefined &&
		value.skillAppliedBindings === undefined
	)
		return undefined;
	if (value.skillGenerationId === undefined || value.skills === undefined)
		throw new WorkloadKubernetesError("policy");
	if (value.skills.length === 0) {
		if (value.skillAppliedBindings !== undefined)
			throw new WorkloadKubernetesError("policy");
		return undefined;
	}
	try {
		const first = value.skills[0];
		if (
			!first ||
			value.skillAppliedBindings === undefined ||
			typeof value.skillAppliedBindings !== "string"
		)
			throw new Error();
		const appliedBindings = JSON.parse(value.skillAppliedBindings);
		const binding = RuntimeSkillHubBindingV1Schema.parse({
			schemaVersion: 1,
			agentId: value.agentId,
			agentVersion: first.agentVersion,
			configurationRevision: value.configRevision,
			generationId: value.skillGenerationId,
			projections: value.skills,
			appliedBindings,
		});
		return binding;
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}
