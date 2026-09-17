import { githubV7LowRiskWriteScenarios } from "./github-v7-low-risk-write-scenarios.ts";

export const githubV8LowRiskWriteScenarios = githubV7LowRiskWriteScenarios.map(
	(scenario) => ({
		...scenario,
		actionVersionId: scenario.actionVersionId.replace(
			/@v7$/,
			"@v8",
		) as `github.${string}@v8`,
	}),
);
