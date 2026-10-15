import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BrowserCapabilityAvailableV1,
	RuntimeModelConfigurationV3Schema,
} from "@agent-infra/contracts/runtime";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { verifyPiInstallation } from "./pi-installation.js";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";
import type { StandardMcpClientOptions } from "./standard-mcp-client.js";

export interface PiRuntimeOptions {
	readonly browserCapability?:
		| BrowserCapabilityAvailableV1
		| (() => BrowserCapabilityAvailableV1 | undefined);
	path: string;
	configVersion: string;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	modelOptions: readonly {
		modelOptionId: string;
		model: string;
		reasoningLevels: readonly string[];
		endpoint: string;
		credential?: string;
		authentication: "api-key" | "bearer";
	}[];
	skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	readonly standardConnectionClient?: StandardMcpClientOptions;
	readonly authorizeToolAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
}

/** Build explicit native Skill arguments from the trusted mounted projection. */
export function piNativeSkillArguments(
	skillDirectory: RuntimeFilesystemSkillDirectoryV1 | undefined,
): readonly string[] {
	const paths = skillDirectory?.nativeSkillPaths?.() ?? [];
	if (
		paths.some(
			(path) =>
				typeof path !== "string" ||
				!isAbsolute(path) ||
				path !== resolve(path) ||
				path.includes("\0") ||
				path.includes("\\") ||
				!/(^|\/)\.agents\/skills\/[a-z0-9][a-z0-9._-]{0,62}\/SKILL\.md$/.test(
					path,
				),
		)
	)
		throw new Error("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
	if (new Set(paths).size !== paths.length)
		throw new Error("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
	if (paths.length === 0) return ["--no-skills"] as const;
	return [
		"--no-skills",
		...paths.flatMap((path) => ["--skill", path] as const),
	];
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
		modelOptions: options.modelOptions.map((option) => ({
			modelOptionId: option.modelOptionId,
			nativeModelId: `configured/${option.model}`,
			reasoningLevels: option.reasoningLevels,
		})),
		launch: async (directory, selection, admit, resolveModelCredential) => {
			const option = options.modelOptions.find(
				(option) => option.modelOptionId === selection.modelOptionId,
			);
			if (!option) throw new Error("RUNTIME_CONFIGURATION_INVALID");
			const nativeSkillArguments = piNativeSkillArguments(
				options.skillDirectory,
			);
			const nativeSkillEnabled = nativeSkillArguments.includes("--skill");
			const transport = await openRuntimeMessagesTransport({
				...option,
				effort: selection.reasoningLevel,
				admit,
				...(resolveModelCredential
					? { resolveCredential: resolveModelCredential }
					: {}),
				client: "pi",
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
					enableSkillCommands: nativeSkillEnabled,
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
						...nativeSkillArguments,
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
					},
					close: () => transport.close(),
					reusable: () => !transport.failure(),
				};
			} catch {
				await transport.close();
				throw new Error("RUNTIME_CONFIGURATION_INVALID");
			}
		},
	});
}
