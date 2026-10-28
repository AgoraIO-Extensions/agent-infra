import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

/** Fixed Worker-owned mount root consumed by the Runtime Host Skill seam. */
export const skillHubWorkloadMountRootV1 = "/opt/agent-infra-skill-hub";
export const skillHubRuntimeDataSubPathV1 = "runtime-data";

export function skillHubVolumeMountV1(value: AgentWorkloadDesiredV1): {
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
		mountPath: skillHubWorkloadMountRootV1,
		subPath: `generations/${generationId}/.agents`,
		readOnly: true,
	};
}
