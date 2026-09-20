import { execFileSync } from "node:child_process";
import { url as inspectorUrl } from "node:inspector";

import { RuntimeHostError } from "@agent-infra/agent-runtime";

/** Check the actual credential-holding process before accepting private client input. */
export function assertRuntimeProcessProtection() {
	const fail = (): never => {
		throw new RuntimeHostError(
			"RUNTIME_PROCESS_PROTECTION_INVALID",
			"Runtime process protection is unavailable",
			503,
		);
	};
	const allowedExecArgv = [
		["--disable-sigusr1"],
		["--disable-sigusr1", "--watch", "--import", "tsx"],
	] as const;
	const hasAllowedExecArgv = allowedExecArgv.some(
		(expected) =>
			expected.length === process.execArgv.length &&
			expected.every((argument, index) => process.execArgv[index] === argument),
	);
	if (
		!["linux", "darwin"].includes(process.platform) ||
		!hasAllowedExecArgv ||
		[
			"NODE_OPTIONS",
			"NODE_DEBUG",
			"NODE_DEBUG_NATIVE",
			"NODE_V8_COVERAGE",
		].some((name) => Boolean(process.env[name])) ||
		inspectorUrl() !== undefined ||
		process.report?.reportOnFatalError ||
		process.report?.reportOnSignal ||
		process.report?.reportOnUncaughtException
	)
		fail();
	try {
		// The trusted launcher sets both limits; hard=0 prevents raising soft later.
		const limits = execFileSync(
			"/bin/sh",
			["-c", "ulimit -S -c\nulimit -H -c"],
			{
				encoding: "utf8",
				env: { PATH: "/usr/bin:/bin" },
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1000,
			},
		)
			.trim()
			.split(/\s+/);
		if (limits.length !== 2 || limits.some((limit) => limit !== "0")) fail();
	} catch {
		fail();
	}
}
