import {
	createFilesystemRuntimeSkillDirectoryV1,
	type RuntimeFilesystemSkillDirectoryV1,
} from "@agent-infra/agent-runtime";
import {
	type RuntimeSkillHubBindingV1,
	RuntimeSkillHubBindingV1Schema,
	runtimeSkillHubBindingEnvironmentNameV1,
} from "@agent-infra/contracts/runtime";

export const runtimeSkillHubMountRootV1 = "/opt/agent-infra-skill-hub";
const maximumRuntimeSkillHubBindingBytesV1 = 30_000;

export function readRuntimeSkillHubBindingV1(
	environment: NodeJS.ProcessEnv,
): RuntimeSkillHubBindingV1 | undefined {
	const raw = environment[runtimeSkillHubBindingEnvironmentNameV1];
	if (raw === undefined) return undefined;
	try {
		if (
			new TextEncoder().encode(raw).byteLength >
			maximumRuntimeSkillHubBindingBytesV1
		)
			runtimeConfigurationInvalid();
		const binding = RuntimeSkillHubBindingV1Schema.parse(JSON.parse(raw));
		if (binding.agentId !== environment.AGENT_INFRA_RUNTIME_AGENT_ID)
			runtimeConfigurationInvalid();
		return binding;
	} catch {
		runtimeConfigurationInvalid();
	}
}

export function createRuntimeSkillHubDirectoryV1(
	binding: RuntimeSkillHubBindingV1,
): RuntimeFilesystemSkillDirectoryV1 {
	return createFilesystemRuntimeSkillDirectoryV1({
		root: runtimeSkillHubMountRootV1,
		agentId: binding.agentId,
		agentVersion: binding.agentVersion,
		generationId: binding.generationId,
		projections: binding.projections,
	});
}

function runtimeConfigurationInvalid(): never {
	throw new Error("RUNTIME_CONFIGURATION_INVALID");
}
