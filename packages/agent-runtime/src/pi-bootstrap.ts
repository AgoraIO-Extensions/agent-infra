import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeModelConfigurationV3Schema } from "@agent-infra/contracts/runtime";
import { DurableJsonFile } from "./durable-json.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { verifyPiInstallation } from "./pi-installation.js";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";

export interface PiRuntimeOptions {
	path: string;
	configVersion: string;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	modelOptions: readonly {
		modelOptionId: string;
		model: string;
		reasoningLevels: readonly string[];
		endpoint: string;
		credential: string;
		authentication: "api-key" | "bearer";
	}[];
}

export async function openPiRuntime(options: PiRuntimeOptions) {
	try {
		RuntimeModelConfigurationV3Schema.parse({
			configVersion: options.configVersion,
			defaultModelOptionId: options.defaultModelOptionId,
			defaultReasoningLevel: options.defaultReasoningLevel,
			schemaVersion: 3,
			modelOptions: options.modelOptions.map(
				({ credential: _credential, ...option }) => ({
					...option,
					protocol: "anthropic-messages-v1",
					credentialEnvironmentVariable:
						"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_VALIDATED",
				}),
			),
		});
		if (
			options.modelOptions.some((option) =>
				option.reasoningLevels.some(
					(level) => !["low", "medium", "high", "xhigh", "max"].includes(level),
				),
			)
		)
			throw new Error();
	} catch {
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	}
	const installed = await verifyPiInstallation();
	return PiRuntimeDriver.open({
		...options,
		modelLifecycleAtTransport: true,
		modelOptions: options.modelOptions.map((option) => ({
			modelOptionId: option.modelOptionId,
			nativeModelId: `configured/${option.model}`,
			modelFactId: option.model,
			reasoningLevels: option.reasoningLevels,
		})),
		launch: async (
			directory,
			selection,
			admit,
			modelRequestIntent,
			modelRequestStarted,
			modelUsage,
			toolRequestStarted,
			modelRequestFinished,
		) => {
			const option = options.modelOptions.find(
				(option) => option.modelOptionId === selection.modelOptionId,
			);
			if (!option) throw new Error("RUNTIME_CONFIGURATION_INVALID");
			let currentModelUsage = modelUsage;
			let currentToolRequestStarted = toolRequestStarted;
			const transport = await openRuntimeMessagesTransport({
				...option,
				effort: selection.reasoningLevel,
				admit,
				client: "pi",
				beforeSend: modelRequestIntent,
				started: modelRequestStarted,
				receipt: async (state, _endTurn, usage) => {
					if (state !== "sent") await modelRequestFinished?.(state, usage);
					if (state === "completed" && usage) await currentModelUsage?.(usage);
				},
				toolRequestStarted: async (tool) =>
					currentToolRequestStarted?.({
						...tool,
						toolCallId: createHash("sha256")
							.update(tool.toolCallId)
							.digest("hex"),
					}),
			});
			try {
				for (const name of [
					"home",
					"config",
					"workspace",
					"workspace/.memory",
					"tmp",
				]) {
					const path = join(directory, name);
					await mkdir(path, { recursive: true, mode: 0o700 });
					if ((await realpath(path)) !== path) throw new Error();
				}
				const config = join(directory, "config");
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
					defaultModel: option.model,
					defaultThinkingLevel: selection.reasoningLevel,
					compaction: { enabled: false },
					retry: { enabled: false },
					packages: [],
					enableSkillCommands: false,
				});
				await write("models.json", {
					providers: {
						configured: {
							api: "anthropic-messages",
							baseUrl: transport.modelAccess.endpoint,
							apiKey: "$AGENT_INFRA_PI_MODEL_TOKEN",
							models: [
								{
									id: option.model,
									name: "Configured model",
									input: ["text"],
									reasoning: true,
									contextWindow: 200000,
									maxTokens: 16384,
									thinkingLevelMap: Object.fromEntries(
										[
											"off",
											"minimal",
											"low",
											"medium",
											"high",
											"xhigh",
											"max",
										].map((level) => [
											level,
											option.reasoningLevels.includes(level) ? level : null,
										]),
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
				return {
					command: installed.executable,
					args: [
						installed.cli,
						"--no-approve",
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"--no-themes",
						"--no-context-files",
						"--tools",
						"read,write,edit",
						"--extension",
						fileURLToPath(new URL("../dist/pi-policy.mjs", import.meta.url)),
					],
					env: {
						PATH: "/usr/local/bin:/usr/bin:/bin",
						HOME: join(directory, "home"),
						TMPDIR: join(directory, "tmp"),
						PI_CODING_AGENT_DIR: config,
						AGENT_INFRA_PI_WORKSPACE: join(directory, "workspace"),
						AGENT_INFRA_PI_MODEL_TOKEN: transport.modelAccess.credential,
						AGENT_INFRA_PI_TOOL_PERMIT_URL: transport.toolPermit.endpoint,
						AGENT_INFRA_PI_TOOL_PERMIT_TOKEN: transport.toolPermit.credential,
					},
					close: () => transport.close(),
					reusable: () => !transport.failure(),
					onTurn: (callbacks) => {
						currentModelUsage = callbacks.modelUsage;
						currentToolRequestStarted = callbacks.toolRequestStarted;
					},
				};
			} catch {
				await transport.close();
				throw new Error("RUNTIME_CONFIGURATION_INVALID");
			}
		},
	});
}
