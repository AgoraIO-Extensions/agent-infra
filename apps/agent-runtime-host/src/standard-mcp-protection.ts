import { readFileSync } from "node:fs";

import { RuntimeHostError } from "@agent-infra/agent-runtime";
import { assertRuntimeProcessProtection } from "./process-protection.js";

/** Check the real credential holder. Deployment env cannot attest protection. */
export function assertStandardMcpProcessProtection() {
	const fail = (): never => {
		throw new RuntimeHostError(
			"CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
			"Standard Connection client protection is unavailable",
			503,
			false,
		);
	};
	assertRuntimeProcessProtection();
	if (
		process.platform !== "linux" ||
		!process.getuid?.() ||
		!process.geteuid?.()
	)
		fail();
	try {
		const status = readFileSync("/proc/self/status", "utf8");
		const scope = readFileSync(
			"/proc/sys/kernel/yama/ptrace_scope",
			"utf8",
		).trim();
		if (!/^[23]$/.test(scope) || !/^NoNewPrivs:\s+1$/m.test(status)) fail();
		for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb"])
			if (!new RegExp(`^${name}:\\s+0+$`, "m").test(status)) fail();
		// This checks attach-mode protection only. The native launch's real
		// Landlock domain separately excludes Host material and proc FD paths.
	} catch {
		fail();
	}
}
