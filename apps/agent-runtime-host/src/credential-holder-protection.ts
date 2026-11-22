import { createRequire } from "node:module";

/**
 * Non-dumpable credential holder (#4199, ADR-0051). A non-dumpable process makes
 * the kernel refuse same-UID ptrace, process_vm_readv, /proc/<pid>/mem,
 * pidfd_getfd, and /proc/<pid>/{environ,fd} access. It protects only this
 * process, so it is admitted only for a Pod verified to belong to one Session.
 */

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

type Prctl = (
	option: number,
	arg2: number,
	arg3: number,
	arg4: number,
	arg5: number,
) => number;

let prctl: Prctl | undefined;

function loadPrctl(): Prctl | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		prctl ??= (() => {
			const require = createRequire(import.meta.url);
			const koffi = require("koffi") as typeof import("koffi");
			// Keep libc loaded: the dumpable state is read back before every read.
			return koffi
				.load("libc.so.6")
				.func("prctl", "int", [
					"int",
					"unsigned long",
					"unsigned long",
					"unsigned long",
					"unsigned long",
				]) as Prctl;
		})();
		return prctl;
	} catch {
		return undefined;
	}
}

/** `PR_GET_DUMPABLE` of this process, or undefined when it cannot be read. */
export function readProcessDumpableV1(): number | undefined {
	const call = loadPrctl();
	if (!call) return undefined;
	try {
		const value = call(PR_GET_DUMPABLE, 0, 0, 0, 0);
		return value >= 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Make this process non-dumpable and read it back. Call first in the process
 * that holds credentials, before reading protected material or creating any
 * child. Returns false instead of throwing: a Yama-protected deployment may still
 * be valid, and `assertStandardMcpProcessProtection` decides on every read.
 */
export function protectCredentialHolderProcessV1(): boolean {
	if (process.platform !== "linux" || process.getuid?.() === 0) return false;
	const call = loadPrctl();
	if (!call) return false;
	try {
		return (
			call(PR_SET_DUMPABLE, 0, 0, 0, 0) === 0 && readProcessDumpableV1() === 0
		);
	} catch {
		return false;
	}
}

/**
 * Worker-issued, Host-verified proof that this Pod belongs to one Session.
 * - `container-boundary`: the HMAC-attested `agentId:sessionId` scope.
 * - `session-executor`: the verified Session binding.
 * - `provisioning-init`: the initializer runs before any tool process exists in
 *   its PID namespace; it has no Session of its own to verify.
 */
export type CredentialHolderSessionScopeV1 =
	| { kind: "container-boundary"; scope: string }
	| {
			kind: "session-executor";
			agentId: string;
			conversationId: string;
			sessionGeneration: number;
	  }
	| { kind: "provisioning-init" };

let sessionScope: CredentialHolderSessionScopeV1 | undefined;

export function establishCredentialHolderSessionScopeV1(
	scope: CredentialHolderSessionScopeV1 | undefined,
) {
	sessionScope = scope;
}

export function credentialHolderSessionScopeV1() {
	return sessionScope;
}
