// The daemon receives startup data only over its Host-owned pipe. The original
// provider launch was prepared by the Host's bootstrap for this Conversation.
export const openCodeProvider = "agent-infra-opencode";

const piEnvironment = new Set([
	"PATH",
	"HOME",
	"TMPDIR",
	"PI_CODING_AGENT_DIR",
	"AGENT_INFRA_PI_WORKSPACE",
	"AGENT_INFRA_PI_MODEL_TOKEN",
	"AGENT_INFRA_PI_BROWSER_MCP_URL",
	"AGENT_INFRA_PI_BROWSER_MCP_TOKEN",
]);

const codexEnvironment = new Set(["PATH", "HOME", "TMPDIR", "CODEX_HOME", "OPENAI_API_KEY"]);
const claudeEnvironment = new Set([
	"PATH", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
	"ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
]);

const openCodeEnvironment = new Set([
	"PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
	"XDG_STATE_HOME", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_PROJECT_CONFIG",
	"OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_PRUNE",
]);

export function privateDaemonConfig({
	home,
	socketPath,
	passwordHash,
	provider,
	command,
	model,
	levels,
	env,
}) {
	const openCode = provider === openCodeProvider;
	if ((!openCode && provider !== "pi" && provider !== "codex" && provider !== "claude") || !passwordHash)
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	if (openCode && !(Array.isArray(command) && command.length === 4 &&
		command[0] === "/opt/opencode/bin/opencode" && command[1] === "acp" &&
		command[2] === "--cwd" && typeof command[3] === "string" && command[3].startsWith("/")))
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	const allowedEnvironment = openCode ? openCodeEnvironment : provider === "codex" ? codexEnvironment : provider === "claude" ? claudeEnvironment : piEnvironment;
	const settings = {
		command: { mode: "replace", argv: command },
		env: Object.fromEntries(
			Object.entries(env).filter(([key]) => allowedEnvironment.has(key)),
		),
	};
	return {
		listen: socketPath,
		paseoHome: home,
		agentStoragePath: home + "/agents",
		staticDir: home + "/static",
		daemonVersion: "0.17.4",
		corsAllowedOrigins: [],
		auth: { password: passwordHash },
		agentClients: {},
		mcpDebug: false,
		relayEnabled: false,
		relayEnabledMutable: false,
		pluginsEnabled: false,
		webUi: { enabled: false, distDir: null },
		usageEnabled: false,
		browserToolsEnabled: false,
		enableTerminalAgentHooks: false,
		mcpEnabled: false,
		mcpInjectIntoAgents: false,
		resumeOnStartup: false,
		providerOverrides: {
			...Object.fromEntries(
				["codex", "claude", "opencode", "copilot", "omp", "pi"].map((id) => [
					id,
					{ enabled: false },
				]),
			),
			[provider]: {
				...(provider === "claude" ? { models: [{ id: model, label: model, isDefault: true, thinkingOptions: levels.map((id) => ({ id, label: id })) }] } : {}),
				...(openCode ? {
					extends: "acp",
					label: "OpenCode",
					options: {
						clientCapabilities: { terminal: false, fs: { readTextFile: false, writeTextFile: false } },
						auto_accept: false,
						supportsMcpServers: false,
					},
				} : {}),
				command,
				env: settings.env,
				enabled: true,
				paseoTools: { enabled: false },
			},
		},
		agentProviderSettings: { [provider]: settings },
	};
}
