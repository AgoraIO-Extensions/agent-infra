import assert from "node:assert/strict";
import test from "node:test";
import { privateDaemonConfig } from "./config.mjs";

test("only the bound Pi harness receives its scoped environment", () => {
	const config = privateDaemonConfig({
		home: "/state",
		socketPath: "/run/private/socket",
		passwordHash: "hashed",
		provider: "pi",
		command: [
			"/usr/bin/setpriv",
			"--",
			"/usr/local/bin/node",
			"/app/node_modules/pi/cli.js",
		],
		env: {
			HOME: "/session/home",
			AGENT_INFRA_PI_MODEL_TOKEN: "scoped",
			AGENT_INFRA_PI_SKILL_READER: "http://127.0.0.1:4000/pi/skill-read",
			AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "host-only",
			PASEO_PASSWORD: "host-only",
		},
	});
	assert.deepEqual(config.providerOverrides.pi.env, {
		HOME: "/session/home",
		AGENT_INFRA_PI_MODEL_TOKEN: "scoped",
		AGENT_INFRA_PI_SKILL_READER: "http://127.0.0.1:4000/pi/skill-read",
	});
	assert.deepEqual(config.auth, { password: "hashed" });
	assert.equal(config.mcpInjectIntoAgents, false);
	assert.equal(config.mcpEnabled, false);
	assert.equal(config.relayEnabled, false);
	assert.equal(config.resumeOnStartup, false);
	assert.deepEqual(config.providerOverrides.pi.paseoTools, { enabled: false });
	assert.equal(config.providerOverrides.codex.enabled, false);
});

test("Codex receives only the Session proxy token and never another provider or Host credential", () => {
	const config = privateDaemonConfig({
		home: "/state", socketPath: "/run/private/socket", passwordHash: "hashed",
		provider: "codex", command: ["/opt/codex/bin/codex"],
		env: { CODEX_HOME: "/session/home", OPENAI_API_KEY: "local-proxy-token", AGENT_INFRA_PI_MODEL_TOKEN: "other-provider", AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "host-only" },
	});
	assert.deepEqual(config.providerOverrides.codex.env, { CODEX_HOME: "/session/home", OPENAI_API_KEY: "local-proxy-token" });
	assert.equal(config.providerOverrides.codex.enabled, true);
	assert.equal(config.providerOverrides.pi.enabled, false);
	assert.equal(config.providerOverrides.claude.enabled, false);
	assert.deepEqual(Object.keys(config.agentProviderSettings), ["codex"]);
});

test("Claude receives only its Session Messages proxy environment", () => {
	const config = privateDaemonConfig({
		home: "/state",
		socketPath: "/run/private/socket",
		passwordHash: "hashed",
		provider: "claude",
		model: "routed-claude",
		levels: ["high"],
		command: ["/app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js"],
		env: {
			CLAUDE_CONFIG_DIR: "/session/config",
			ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
			ANTHROPIC_AUTH_TOKEN: "local-proxy-token",
			AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "host-only",
		},
	});
	assert.deepEqual(config.providerOverrides.claude.env, {
		CLAUDE_CONFIG_DIR: "/session/config",
		ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
		ANTHROPIC_AUTH_TOKEN: "local-proxy-token",
	});
	assert.equal(config.providerOverrides.claude.enabled, true);
	assert.deepEqual(config.providerOverrides.claude.models, [{id:"routed-claude",label:"routed-claude",isDefault:true,thinkingOptions:[{id:"high",label:"high"}]}]);
	assert.equal(config.providerOverrides.pi.enabled, false);
	assert.deepEqual(Object.keys(config.agentProviderSettings), ["claude"]);
});

test("OpenCode runs as the only enabled provider through Generic ACP", () => {
	const command = ["/opt/opencode/bin/opencode", "acp", "--cwd", "/session/workspace"];
	const config = privateDaemonConfig({
		home: "/state",
		socketPath: "/run/private/socket",
		passwordHash: "hashed",
		provider: "agent-infra-opencode",
		command,
		env: { XDG_DATA_HOME: "/session/data", AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "host-only" },
	});
	const selected = config.providerOverrides["agent-infra-opencode"];
	assert.equal(selected.extends, "acp");
	assert.deepEqual(selected.command, command);
	assert.deepEqual(selected.env, { XDG_DATA_HOME: "/session/data" });
	assert.equal(config.providerOverrides.opencode.enabled, false);
	assert.equal(config.providerOverrides.pi.enabled, false);
	assert.equal(selected.paseoTools.enabled, false);
	assert.equal(selected.options.auto_accept, false);
	assert.deepEqual(selected.options.clientCapabilities, {
		terminal: false, fs: { readTextFile: false, writeTextFile: false },
	});
});
