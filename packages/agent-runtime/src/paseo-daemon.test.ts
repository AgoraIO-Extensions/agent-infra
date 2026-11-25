import { expect, test } from "vitest";
import { launchPaseoDaemon } from "./paseo-daemon.js";

test("rejects a workspace outside the assigned Conversation before launching the daemon", async () => {
	await expect(
		launchPaseoDaemon({
			directory: "/var/lib/agent-runtime/sessions/owned",
			cwd: "/var/lib/agent-runtime/sessions/other/workspace",
			provider: "pi",
			launch: { command: "/usr/local/bin/node", args: [], env: {} },
		}),
	).rejects.toThrow("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
});
