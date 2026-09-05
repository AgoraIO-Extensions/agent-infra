import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { runCommand } from "../deploy/release/run-command.mjs";

test("release subprocesses terminate with a stable timeout failure", () => {
	const startedAt = Date.now();
	assert.throws(
		() =>
			runCommand(
				process.execPath,
				["-e", "setInterval(() => undefined, 1000)"],
				{
					cwd: resolve(import.meta.dirname, ".."),
					name: "hung release probe",
					timeoutMs: 25,
				},
			),
		/hung release probe timed out/,
	);
	assert.ok(Date.now() - startedAt < 1000);
});

test("release subprocess failures expose only stable status and signal diagnostics", () => {
	const cwd = resolve(import.meta.dirname, "..");
	assert.throws(
		() =>
			runCommand(
				process.execPath,
				["-e", "process.kill(process.pid, 'SIGTERM')"],
				{
					cwd,
					name: "signalled release probe",
					timeoutMs: 1000,
				},
			),
		/signalled release probe terminated by SIGTERM/,
	);
	try {
		runCommand(
			process.execPath,
			["-e", "process.stderr.write('sensitive-value');process.exit(7)"],
			{ cwd, name: "failed release probe", timeoutMs: 1000 },
		);
		assert.fail("expected command failure");
	} catch (error) {
		assert.match(
			error.message,
			/failed release probe failed with exit status 7/,
		);
		assert.doesNotMatch(error.message, /sensitive-value/);
	}
});
