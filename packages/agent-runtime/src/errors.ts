export type RuntimeDriverFailureKind =
	| "unavailable"
	| "session_recovery_failed"
	/**
	 * #3314：附件读取在任何原生副作用之前被平台明确拒绝，Driver 也未持有该操作的记录。
	 * 只能由 Driver 在其原生副作用之前的物化点声明；Host 据此持久化不可重试的 rejected。
	 */
	| "file_input_rejected";

export class RuntimeHostError extends Error {
	readonly code: string;
	readonly httpStatus: number;
	readonly retryable: boolean;
	readonly driverFailureKind?: RuntimeDriverFailureKind;
	/**
	 * 面向运维的内部固定原因（#1888）。不携带请求、Grant、claim 内容，
	 * 不进入 HTTP 响应。
	 */
	readonly diagnostic?: string;

	constructor(
		code: string,
		message: string,
		httpStatus: number,
		retryable = false,
		driverFailureKind?: RuntimeDriverFailureKind,
		diagnostic?: string,
	) {
		super(message);
		this.name = "RuntimeHostError";
		this.code = code;
		this.httpStatus = httpStatus;
		this.retryable = retryable;
		this.driverFailureKind = driverFailureKind;
		this.diagnostic = diagnostic;
	}
}

/**
 * nativeSessionRequired / nativeRequired 调用点标识符（固定枚举，#3017）。
 */
export type NativeSessionCallSite =
	| "readEventsV4"
	| "acknowledgeEventsV4"
	| "readStatus"
	| "modelDirectory"
	| "replay"
	| "streamEvents"
	| "supplement"
	| "stop"
	| "cancelGeneration"
	| "dispatch"
	| "streamEventsV3"
	| "acknowledgeEventsV3"
	| "nativeCapability"
	| "nativeSkillReadContext"
	| "executeBrowserHandoffV3"
	| "executeBrowserSideEffectV3"
	| "executeNativeCapabilityV5"
	| "assertOpen"
	| "recoverEvidence";

/**
 * 会话/操作的粗粒度状态类别（不含 ID、路径或内容，#3017）。
 *
 * - prepared_no_native：操作处于 prepared 状态，原生会话尚未绑定
 * - unknown_no_native：操作已恢复为 unknown/missing，原生会话永不绑定
 * - no_operations：会话无任何操作
 * - recovery_blocked：会话 recovery.status 为 blocked
 * - running_unbound：操作运行中但 nativeSessionRef 已丢失（dispatch 路径）
 * - host_closed：Host 已关闭（assertOpen 路径）
 * - unbound：调用点无法确定具体状态
 */
export type NativeSessionStateCategory =
	| "prepared_no_native"
	| "unknown_no_native"
	| "no_operations"
	| "recovery_blocked"
	| "running_unbound"
	| "host_closed"
	| "unbound";

/**
 * 有界诊断字符串：`callSite:stateCategory`（#3017）。
 * 不携带 ID、Grant、claim、路径或会话内容；不进入 HTTP 响应。
 */
export type NativeSessionUnavailableDiagnostic =
	`${NativeSessionCallSite}:${NativeSessionStateCategory}`;

/**
 * 提取 RuntimeHostError 的诊断字符串：优先使用错误自带的 diagnostic，
 * 否则从调用栈推断调用位置（#1888）。
 */
export function runtimeHostErrorDiagnostic(error: RuntimeHostError) {
	if (error.diagnostic) return error.diagnostic;
	const frame = (error.stack ?? "")
		.split("\n")
		.slice(1)
		.map((line) => line.trim())
		.find(
			(line) =>
				line.startsWith("at ") &&
				!line.includes("runtimeAuthorizationDenied") &&
				!line.includes("new RuntimeHostError"),
		);
	if (!frame) return "unlocated";
	// 只保留函数名和带行列号的文件名。
	const match = /^at (?:(\S+) )?\(?(?:.*[/\\])?([^/\\():]+:\d+:\d+)\)?$/.exec(
		frame,
	);
	return match ? `${match[1] ?? "<anonymous>"}@${match[2]}` : "unlocated";
}
