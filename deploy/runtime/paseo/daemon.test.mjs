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
			AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "host-only",
			PASEO_PASSWORD: "host-only",
		},
	});
	assert.deepEqual(config.providerOverrides.pi.env, {
		HOME: "/session/home",
		AGENT_INFRA_PI_MODEL_TOKEN: "scoped",
	});
	assert.deepEqual(config.auth, { password: "hashed" });
	assert.equal(config.mcpInjectIntoAgents, false);
	assert.equal(config.mcpEnabled, false);
	assert.equal(config.relayEnabled, false);
	assert.equal(config.resumeOnStartup, false);
	assert.deepEqual(config.providerOverrides.pi.paseoTools, { enabled: false });
	assert.equal(config.providerOverrides.codex.enabled, false);
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
