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
	const forbidden =
		/^--(?:inspect|debug|heap|report|experimental-report|diagnostic-dir|tls-keylog|prof|cpu-prof|trace-event|redirect-warnings|import|require|loader|experimental-loader|no-disable-sigusr1|watch)/;
	if (
		!["linux", "darwin"].includes(process.platform) ||
		!process.execArgv.includes("--disable-sigusr1") ||
		process.execArgv.some((argument) => {
			const normalized = argument.replaceAll("_", "-");
			return (
				/^-r(?:$|[^-])/.test(normalized) ||
				forbidden.test(normalized) ||
				(normalized.startsWith("--disable-sigusr1") &&
					normalized !== "--disable-sigusr1")
			);
		}) ||
		Object.keys(process.env).some(
			(name) =>
				name === "DYLD_FRAMEWORK_PATH" ||
				/^(?:LD_|DYLD_)/.test(name) ||
				[
					"NODE_OPTIONS",
					"NODE_DEBUG",
					"NODE_DEBUG_NATIVE",
					"NODE_V8_COVERAGE",
					"NODE_PATH",
				].includes(name),
		) ||
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
