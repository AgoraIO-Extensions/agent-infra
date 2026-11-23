import { readFileSync, statSync } from "node:fs";

import { RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	credentialHolderSessionScopeV1,
	isSessionLevelScopeV1,
	readProcessDumpableV1,
} from "./credential-holder-protection.js";
import { assertRuntimeProcessProtection } from "./process-protection.js";

const INITIAL_UID_MAP = "0 0 4294967295";

function unavailable(): never {
	throw new RuntimeHostError(
		"CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
		"Standard Connection client protection is unavailable",
		503,
		false,
	);
}

function yamaProtects() {
	try {
		const scope = readFileSync(
			"/proc/sys/kernel/yama/ptrace_scope",
			"utf8",
		).trim();
		return /^[23]$/.test(scope);
	} catch {
		// Kernels without Yama have no such file; only the other choice remains.
		return false;
	}
}

/** Same-Session non-dumpable choice (#4199). Any unverifiable premise fails. */
function nonDumpableProtects(status: string) {
	const ids = (name: string) =>
		new RegExp(`^${name}:\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*$`, "m")
			.exec(status)
			?.slice(1);
	const unchanged = (values: string[] | undefined) =>
		values?.length === 4 && values.every((value) => value === values[0]);
	if (
		// An Agent-level scope cannot admit this choice (Spec §13.5.4).
		// `provisioning-init` keeps its prior admission; its Spec basis is a
		// separate documentation change.
		!(
			credentialHolderSessionScopeV1()?.kind === "provisioning-init" ||
			isSessionLevelScopeV1(credentialHolderSessionScopeV1())
		) ||
		readProcessDumpableV1() !== 0 ||
		// Re-reading a changed credential would restore dumpable.
		readFileSync("/proc/sys/fs/suid_dumpable", "utf8").trim() === "1" ||
		!unchanged(ids("Uid")) ||
		!unchanged(ids("Gid")) ||
		readFileSync("/proc/self/uid_map", "utf8").trim().split(/\s+/).join(" ") !==
			INITIAL_UID_MAP ||
		// A dumpable process's /proc/self/fd belongs to its user; non-dumpable is root.
		statSync("/proc/self/fd").uid !== 0
	)
		return false;
	return true;
}

/** Returns which memory-access protection holds; throws when neither does. */
function assertProtection(): "yama" | "non-dumpable" {
	assertRuntimeProcessProtection();
	if (
		process.platform !== "linux" ||
		!process.getuid?.() ||
		!process.geteuid?.()
	)
		unavailable();
	try {
		const status = readFileSync("/proc/self/status", "utf8");
		if (!/^NoNewPrivs:\s+1$/m.test(status)) unavailable();
		for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb"])
			if (!new RegExp(`^${name}:\\s+0+$`, "m").test(status)) unavailable();
		// Yama limits ATTACH mode only. The native launch's real Landlock domain
		// separately excludes Host material and proc FD paths.
		if (yamaProtects()) return "yama";
		if (nonDumpableProtects(status)) return "non-dumpable";
	} catch {
		// Fall through: unreadable or malformed kernel state is never protection.
	}
	return unavailable();
}

/** Check the real credential holder. Deployment env cannot attest protection. */
export function assertStandardMcpProcessProtection() {
	assertProtection();
}

/**
 * Before reading material for an original Execution: when protection is the
 * non-dumpable choice, the Execution must belong to the Pod's verified Session.
 */
export function assertStandardMcpOriginalSessionV1(original: {
	agentId: string;
	conversationId: string;
	sessionGeneration: number;
}) {
	if (assertProtection() === "yama") return;
	const scope = credentialHolderSessionScopeV1();
	if (
		scope?.kind === "container-boundary" || scope?.kind === "session-scope"
			? scope.scope !== `${original.agentId}:${original.conversationId}`
			: scope?.kind !== "session-executor" ||
				scope.agentId !== original.agentId ||
				scope.conversationId !== original.conversationId ||
				scope.sessionGeneration !== original.sessionGeneration
	)
		unavailable();
}
