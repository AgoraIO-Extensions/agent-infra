import { chmod, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type BrowserCapabilityAvailableV1,
	RuntimeModelConfigurationV3Schema,
} from "@agent-infra/contracts/runtime";
import { GenericAcpRuntimeDriver } from "./acp-runtime-driver.js";
import {
	validateModelAccess,
	validateModelEndpoint,
} from "./codex-app-server-bridge.js";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
} from "./driver.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { verifyOpenCodeInstallation } from "./opencode-installation.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";
import type { StandardMcpClientOptions } from "./standard-mcp-client.js";
import {
	workspaceDirectoryAllowed,
	workspaceGlobAllowed,
	workspacePathAllowed,
} from "./workspace-path.js";

const nativeSkillPromptMaximumLength = 16 * 1024;
const nativeSkillName = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const nativeSkillCommandToken = /^(?:\/|\.\.(?:[\\/]|$))/;
const nativeSkillExternalTarget = /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/\S*/;

function validateOpenCodeNativeSkillParameters(parameters: string) {
	if (
		[...parameters].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return (
				code <= 0x1f ||
				(code >= 0x7f && code <= 0x9f) ||
				code === 0x2028 ||
				code === 0x2029
			);
		})
	)
		throw new Error("RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED");
	const firstToken = parameters.trim().split(/\s+/)[0] ?? "";
	if (
		nativeSkillCommandToken.test(firstToken) ||
		nativeSkillExternalTarget.test(parameters)
	)
		throw new Error("RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED");
}

/**
 * Map one verified Applied Skill identity to OpenCode's slash command prompt.
 * The Runtime Host has already authenticated the directory, version, digest and
 * grant; this seam intentionally accepts only that identity and bounded opaque
 * parameters, never a caller-selected path, URL or credential.
 */
export function openCodeNativeSkillPrompt(name: string, parameters: string) {
	if (
		!nativeSkillName.test(name) ||
		typeof parameters !== "string" ||
		!parameters.isWellFormed() ||
		name.length + parameters.length + (parameters.length > 0 ? 2 : 1) >
			nativeSkillPromptMaximumLength
	)
		throw new Error("RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED");
	validateOpenCodeNativeSkillParameters(parameters);
	return `/${name}${parameters.length > 0 ? ` ${parameters}` : ""}`;
}

export interface OpenCodeRuntimeOptions {
	readonly browserCapability?:
		| BrowserCapabilityAvailableV1
		| (() => BrowserCapabilityAvailableV1 | undefined);
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
		credential?: string;
		authentication: "api-key" | "bearer";
	}[];
	readonly authorizeModelAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
	readonly standardConnectionClient?: StandardMcpClientOptions;
	/** Deployment-owned Applied Skill root; never selected by a wire request. */
	readonly skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	readonly authorizeToolAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
}

/**
 * #3217：OpenCode 的 glob 与 grep（ACP kind 为 search）。`path` 只能在本 Conversation
 * 工作区内；glob 的 `pattern` 与 grep 的 `include` 不能是绝对路径或含 `..`。grep 的
 * `pattern` 是正则表达式，只在含路径分隔符时按 glob 规则检查。
 */
export async function openCodeSearchAllowed(workspace: string, input: unknown) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const value = input as Record<string, unknown>;
	if (typeof value.pattern !== "string" || value.pattern.includes("\0"))
		return false;
	if (/[\\/]/.test(value.pattern) && !workspaceGlobAllowed(value.pattern))
		return false;
	if (
		value.include !== undefined &&
		(typeof value.include !== "string" || !workspaceGlobAllowed(value.include))
	)
		return false;
	return (
		value.path === undefined ||
		(typeof value.path === "string" &&
			(await workspaceDirectoryAllowed(
				[workspace],
				resolve(workspace, value.path),
			)))
	);
}

export function resolveOpenCodeSkillHome(
	directory: string,
	skillDirectory?: RuntimeFilesystemSkillDirectoryV1,
) {
	return skillDirectory?.nativeRoot ?? join(directory, "home");
}

export function validateOpenCodeRuntimeOptions(
	options: OpenCodeRuntimeOptions,
) {
	for (const option of options.modelOptions) {
		if (option.credential === undefined) {
			if (!options.authorizeModelAction)
				throw new Error("RUNTIME_CONFIGURATION_INVALID");
			validateModelEndpoint(option.endpoint);
		} else {
			validateModelAccess({
				endpoint: option.endpoint,
				credential: option.credential,
			});
		}
	}
}

/** Static OpenCode bootstrap for the single Generic ACP driver. */
export async function openOpenCodeRuntime(options: OpenCodeRuntimeOptions) {
	validateOpenCodeRuntimeOptions(options);
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
		nativeSkillPrompt: openCodeNativeSkillPrompt,
		reuseNativeSession: !options.standardConnectionClient,
		modelOptions: options.modelOptions.map((option) => ({
			modelOptionId: option.modelOptionId,
			nativeModelId: `anthropic/${option.model}`,
			reasoningLevels: option.reasoningLevels,
		})),
		launch: async (directory, selection, admit, resolveModelCredential) => {
			const option = options.modelOptions.find(
				(option) => option.modelOptionId === selection.modelOptionId,
			);
			if (!option) throw new Error("RUNTIME_CONFIGURATION_INVALID");
			const transport = await openRuntimeMessagesTransport({
				...option,
				effort: selection.reasoningLevel,
				admit,
				...(resolveModelCredential
					? { resolveCredential: resolveModelCredential }
					: {}),
				client: "opencode",
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
				// Configuration is supplied below. A read-only native config directory
				// prevents OpenCode from installing plugin dependencies on every launch.
				const nativeConfig = join(directory, "config", "opencode");
				await mkdir(nativeConfig, { recursive: true, mode: 0o500 });
				if ((await realpath(nativeConfig)) !== nativeConfig)
					throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
				await chmod(nativeConfig, 0o500);
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
					// #3217：列举与搜索类工具经 ACP 权限请求按本 Conversation 路径授权；
					// bash 待 OS 级边界就绪后开放（#3218）。
					permission: {
						"*": "deny",
						read: "ask",
						edit: "ask",
						glob: "ask",
						grep: "ask",
					},
					autoupdate: false,
					share: "disabled",
					agent: { title: { disable: true }, summary: { disable: true } },
					formatter: false,
					lsp: false,
				};
				return {
					command: options.executable,
					args: ["acp", "--cwd", join(directory, "workspace")],
					nativeCommandMode: "opencode",
					env: {
						PATH: "/usr/bin:/bin",
						HOME: resolveOpenCodeSkillHome(directory, options.skillDirectory),
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
						if (tool.kind === "search")
							return openCodeSearchAllowed(
								join(directory, "workspace"),
								tool.rawInput,
							);
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
					beginTurn: transport.beginTurn,
					reusable: () => transport.failure() === undefined,
					close: () => transport.close(),
				};
			} catch {
				await transport.close();
				throw new Error("RUNTIME_CONFIGURATION_INVALID");
			}
		},
	});
}
