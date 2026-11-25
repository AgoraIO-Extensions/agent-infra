import { join } from "node:path";
import { DurableJsonFile } from "./durable-json.js";

export async function writePiConfiguration(
	config: string,
	model: string,
	levels: readonly string[],
	effort: string,
	endpoint: string,
	nativeSkillEnabled: boolean,
) {
	const write = async (name: string, value: Record<string, unknown>) => {
		const file = await DurableJsonFile.open(
			join(config, name),
			{} as Record<string, unknown>,
		);
		await file.update((state) => {
			for (const key of Object.keys(state)) delete state[key];
			Object.assign(state, value);
		});
	};
	await write("settings.json", {
		defaultProvider: "configured",
		defaultModel: model,
		defaultThinkingLevel: effort,
		compaction: { enabled: false },
		retry: { enabled: false },
		packages: [],
		enableSkillCommands: nativeSkillEnabled,
	});
	await write("models.json", {
		providers: {
			configured: {
				api: "anthropic-messages",
				baseUrl: endpoint,
				apiKey: "$AGENT_INFRA_PI_MODEL_TOKEN",
				models: [
					{
						id: model,
						name: "Configured model",
						input: ["text"],
						reasoning: true,
						contextWindow: 200000,
						maxTokens: 16384,
						thinkingLevelMap: Object.fromEntries(
							["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
								(level) => [level, levels.includes(level) ? level : null],
							),
						),
						compat: {
							forceAdaptiveThinking: true,
							supportsMidConvoEffort: false,
							supportsEagerToolInputStreaming: false,
						},
					},
				],
			},
		},
	});
}
