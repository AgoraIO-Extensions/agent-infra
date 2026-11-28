import { openPublishedDeploymentSkills } from "./published-deployment-skills.js";

export {
	publishedDeploymentReadActions as openCodeDeploymentReadActions,
	publishedDeploymentSkillInstructions as openCodeDeploymentSkillInstructions,
} from "./published-deployment-skills.js";

export function openOpenCodeDeploymentSkills(
	input: Omit<
		Parameters<typeof openPublishedDeploymentSkills>[0],
		"bundledNames"
	>,
) {
	// OpenCode 1.19.0 ships this Skill even when a disk entry shadows it in Skill.all().
	return openPublishedDeploymentSkills({
		...input,
		bundledNames: ["customize-opencode"],
	});
}
