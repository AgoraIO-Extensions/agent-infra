import { githubV7ReadScenarios } from "./github-v7-read-scenarios.ts";

export const githubV9ReadScenarios = githubV7ReadScenarios.map((scenario) => ({
	...scenario,
	actionVersionId: scenario.actionVersionId.replace(
		/@v7$/,
		"@v9",
	) as `github.${string}@v9`,
}));
