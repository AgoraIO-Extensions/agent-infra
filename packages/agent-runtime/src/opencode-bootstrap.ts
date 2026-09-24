import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeModelConfigurationV3Schema } from "@agent-infra/contracts/runtime";
import { GenericAcpRuntimeDriver } from "./acp-runtime-driver.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { verifyOpenCodeInstallation } from "./opencode-installation.js";
import { workspacePathAllowed } from "./workspace-path.js";

export interface OpenCodeRuntimeOptions {
	path: string;
	executable: string;
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

/** Static OpenCode bootstrap for the single Generic ACP driver. */
export async function openOpenCodeRuntime(options: OpenCodeRuntimeOptions) {
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
	} catch {
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	}
	await verifyOpenCodeInstallation(options.executable);
	return GenericAcpRuntimeDriver.open({
		...options,
		modelOptions: options.modelOptions.map((option) => ({
			modelOptionId: option.modelOptionId,
			nativeModelId: `anthropic/${option.model}`,
			modelFactId: option.model,
			reasoningLevels: option.reasoningLevels,
		})),
		launch: async (
			directory,
			selection,
			admit,
			modelRequestStarted,
			_modelUsage,
			_toolRequestStarted,
		) => {
			const option = options.modelOptions.find(
				(option) => option.modelOptionId === selection.modelOptionId,
			);
			if (!option) throw new Error("RUNTIME_CONFIGURATION_INVALID");
			let currentModelUsage = _modelUsage;
			const transport = await openRuntimeMessagesTransport({
				...option,
				effort: selection.reasoningLevel,
				admit,
				client: "opencode",
				started: modelRequestStarted,
				receipt: async (state, _endTurn, usage) => {
					if (state === "completed" && usage) await currentModelUsage?.(usage);
				},
			});
			try {
				for (const name of [
					"home",
					"config",
					"data",
					"cache",
					"state",
					"workspace",
					"tmp",
					"workspace/.memory",
				]) {
					const path = join(directory, name);
					await mkdir(path, { recursive: true, mode: 0o700 });
					if ((await realpath(path)) !== path)
						throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
				}
				if (
					!(await workspacePathAllowed(
						join(directory, "workspace"),
						join(directory, "workspace/.memory"),
						join(directory, "workspace/.memory/MEMORY.md"),
					))
				)
					throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
				const nativeModel = `anthropic/${option.model}`;
				const config = {
					model: nativeModel,
					small_model: nativeModel,
					enabled_providers: ["anthropic"],
					provider: {
						anthropic: {
							whitelist: [option.model],
							options: {
								baseURL: `${transport.modelAccess.endpoint}/v1`,
								apiKey: transport.modelAccess.credential,
							},
							models: {
								[option.model]: {
									name: "Configured model",
									reasoning: true,
									variants: Object.fromEntries(
										option.reasoningLevels.map((effort) => [
											effort,
											{ thinking: { type: "adaptive" }, effort },
										]),
									),
								},
							},
						},
					},
					instructions: [join(directory, "workspace/.memory/MEMORY.md")],
					permission: { "*": "deny", read: "ask", edit: "ask" },
					autoupdate: false,
					share: "disabled",
					agent: { title: { disable: true }, summary: { disable: true } },
					formatter: false,
					lsp: false,
				};
				return {
					command: options.executable,
					args: ["acp", "--cwd", join(directory, "workspace")],
					env: {
						PATH: "/usr/bin:/bin",
						HOME: join(directory, "home"),
						XDG_CONFIG_HOME: join(directory, "config"),
						XDG_DATA_HOME: join(directory, "data"),
						XDG_CACHE_HOME: join(directory, "cache"),
						XDG_STATE_HOME: join(directory, "state"),
						TMPDIR: join(directory, "tmp"),
						OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
						OPENCODE_DISABLE_PROJECT_CONFIG: "true",
						OPENCODE_DISABLE_AUTOUPDATE: "true",
						OPENCODE_DISABLE_MODELS_FETCH: "true",
						OPENCODE_DISABLE_PRUNE: "true",
					},
					authorize: async (tool) => {
						if (
							!["read", "edit"].includes(tool.kind ?? "") ||
							!tool.rawInput ||
							typeof tool.rawInput !== "object" ||
							!("filePath" in tool.rawInput) ||
							typeof tool.rawInput.filePath !== "string"
						)
							return false;
						return workspacePathAllowed(
							join(directory, "workspace"),
							join(directory, "workspace", ".memory"),
							tool.rawInput.filePath,
						);
					},
					close: () => transport.close(),
					onTurn: (callbacks) => {
						currentModelUsage = callbacks.modelUsage;
					},
				};
			} catch {
				await transport.close();
				throw new Error("RUNTIME_CONFIGURATION_INVALID");
			}
		},
	});
}
