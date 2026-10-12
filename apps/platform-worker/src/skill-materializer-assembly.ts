import type { WorkloadSkillMaterializerV1 } from "./skill-materialization.js";

export type DeploymentSkillMaterializerFactoryV1 = (input: {
	readonly databaseUrl: string;
	readonly signal: AbortSignal;
}) => WorkloadSkillMaterializerV1 | Promise<WorkloadSkillMaterializerV1>;

/** Select the deployment-owned object-storage/Store bridge for Worker assembly. */
export async function resolveDeploymentSkillMaterializerV1(input: {
	readonly databaseUrl: string;
	readonly signal: AbortSignal;
	readonly configured?: WorkloadSkillMaterializerV1;
	readonly factory?: DeploymentSkillMaterializerFactoryV1;
}): Promise<WorkloadSkillMaterializerV1 | undefined> {
	if (input.factory !== undefined && typeof input.factory !== "function")
		throw new Error("SKILL_MATERIALIZER_CONFIGURATION_INVALID");
	const materializer = input.factory
		? await input.factory({
				databaseUrl: input.databaseUrl,
				signal: input.signal,
			})
		: input.configured;
	if (
		materializer !== undefined &&
		typeof materializer.materialize !== "function"
	)
		throw new Error("SKILL_MATERIALIZER_CONFIGURATION_INVALID");
	return materializer;
}
