import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const idleMs = Number(process.argv[2]);
if (!Number.isSafeInteger(idleMs) || idleMs < 0)
	throw new Error("Invalid maintenance idle interval");
const run = promisify(execFile);
let idleSince = performance.now();
let lastDetach = "";
for (;;) {
	await delay(idleMs ? Math.min(5_000, idleMs) : 60_000);
	if (!idleMs) continue;
	let attached = false;
	let detach = "";
	try {
		const { stdout } = await run(
			"tmux",
			[
				"-L",
				"maintenance",
				"list-sessions",
				"-F",
				"#{session_attached} #{pid}:#{@maintenance-detaches}",
			],
			{ timeout: 2000 },
		);
		const sessions = stdout.trim().split("\n");
		attached = sessions.some((session) => Number(session.split(" ")[0]) > 0);
		// The server-wide hook also counts clients that opened and closed between two polls.
		detach = sessions[0]?.split(" ")[1] ?? "";
	} catch {
		/* A new Pod has no tmux server until its first attach. */
	}
	const now = performance.now();
	if (attached || detach !== lastDetach) idleSince = now;
	if (now - idleSince >= idleMs) break;
	lastDetach = detach;
}
