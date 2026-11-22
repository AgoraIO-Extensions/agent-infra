import { RuntimeHostError } from "@agent-infra/agent-runtime";

/**
 * #3054: fixed internal codes that a startup failure log may name as its
 * `reason`. Only an exact match is reported; anything else is `unclassified`,
 * so no message, path or material reaches the log. Diagnostics only: the
 * failure, its exit code and fail-closed handling are unchanged.
 */
export const codexExecutorStartupReasonsV1: ReadonlySet<string> = new Set([
	"CODEX_EXECUTOR_LAUNCH_NOT_ISOLATED",
	"CODEX_EXECUTOR_START_IDENTITY_INVALID",
	"CODEX_EXECUTOR_IDENTITY_PROCESS_UNPROTECTED",
	"CODEX_EXECUTOR_DESCENDANTS_UNAVAILABLE",
	"CODEX_EXECUTOR_PROCESS_IDENTITY_INVALID",
	"CODEX_EXECUTOR_TRANSPORT_UNAVAILABLE",
	"CODEX_SESSION_EXECUTOR_INVALID",
]);

/** Host startup may also raise the executor client, drain and Codex Driver codes. */
export const runtimeHostStartupReasonsV1: ReadonlySet<string> = new Set([
	...codexExecutorStartupReasonsV1,
	"CODEX_EXECUTOR_CONTROL_REJECTED",
	"CODEX_EXECUTOR_DRAIN_JOURNAL_INVALID",
	"CODEX_EXECUTOR_STARTUP_FAILED",
	"CODEX_EXECUTOR_STILL_DRAINING",
	"CODEX_CONNECTION_CLIENT_UNAVAILABLE",
	"CODEX_NATIVE_CALLBACK_UNAVAILABLE",
]);

function startupFailureReason(error: unknown, allowed: ReadonlySet<string>) {
	const code =
		error instanceof RuntimeHostError
			? error.code
			: error instanceof Error
				? error.message
				: undefined;
	return code !== undefined && allowed.has(code) ? code : "unclassified";
}

export function runtimeHostStartupFailureReasonV1(error: unknown) {
	return startupFailureReason(error, runtimeHostStartupReasonsV1);
}

/** The runner's one startup failure line; `reason` is fixed, never the message. */
export function codexExecutorStartupFailureLineV1(error: unknown) {
	return JSON.stringify({
		service: "codex-session-executor",
		code: "CODEX_EXECUTOR_STARTUP_FAILED",
		reason: startupFailureReason(error, codexExecutorStartupReasonsV1),
	});
}
