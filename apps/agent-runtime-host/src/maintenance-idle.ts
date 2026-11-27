import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const idleMs = Number(process.argv[2]);
if (!Number.isSafeInteger(idleMs) || idleMs < 0)
	throw new Error("Invalid maintenance idle interval");
const run = promisify(execFile);
let lastAttached = performance.now();
do {
	await delay(idleMs ? Math.min(5_000, idleMs) : 60_000);
	try {
		const { stdout } = await run(
			"tmux",
			["-L", "maintenance", "list-clients", "-F", "#{client_pid}"],
			{ timeout: 2000 },
		);
		if (stdout.trim()) lastAttached = performance.now();
	} catch {
		/* A new Pod has no tmux server until its first attach. */
	}
} while (!idleMs || performance.now() - lastAttached < idleMs);
