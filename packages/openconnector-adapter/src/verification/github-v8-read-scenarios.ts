import { githubV7ReadScenarios } from "./github-v7-read-scenarios.ts";

export const githubV8ReadScenarios = githubV7ReadScenarios.map((scenario) => ({
	...scenario,
	actionVersionId: scenario.actionVersionId.replace(
		/@v7$/,
		"@v8",
	) as `github.${string}@v8`,
}));
