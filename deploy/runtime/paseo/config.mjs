// The daemon receives startup data only over its Host-owned pipe. The original
// provider launch was prepared by the Host's bootstrap for this Conversation.
const commonEnvironment = [
	"PATH",
	"HOME",
	"TMPDIR",
];

export function privateDaemonConfig({
	home,
	socketPath,
	passwordHash,
	provider,
	command,
	env,
}) {
	if ((provider !== "pi" && provider !== "codex") || !passwordHash)
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	const providerEnvironment = new Set([
		...commonEnvironment,
		...(provider === "pi"
			? ["PI_CODING_AGENT_DIR", "AGENT_INFRA_PI_WORKSPACE", "AGENT_INFRA_PI_MODEL_TOKEN"]
			: ["CODEX_HOME", "OPENAI_API_KEY"]),
	]);
	const settings = {
		command: { mode: "replace", argv: command },
		env: Object.fromEntries(
			Object.entries(env).filter(([key]) => providerEnvironment.has(key)),
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
				["codex", "claude", "pi", "opencode", "copilot", "omp"].map((id) => [
					id,
					{ enabled: false },
				]),
			),
			[provider]: {
				command,
				env: settings.env,
				enabled: true,
				...(provider === "pi" ? { paseoTools: { enabled: false } } : {}),
			},
		},
		agentProviderSettings: { [provider]: settings },
	};
}
