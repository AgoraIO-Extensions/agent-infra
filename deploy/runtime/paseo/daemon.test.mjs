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
