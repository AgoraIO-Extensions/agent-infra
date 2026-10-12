export type RuntimeDriverFailureKind =
	| "unavailable"
	| "session_recovery_failed";

export class RuntimeHostError extends Error {
	readonly code: string;
	readonly httpStatus: number;
	readonly retryable: boolean;
	readonly driverFailureKind?: RuntimeDriverFailureKind;
	/**
	 * Internal, fixed reason for operators (#1888). It never carries request,
	 * Grant or claim values and is never part of the HTTP response.
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
 * The internal diagnostic of a Host error: its fixed reason, or else the code
 * location that threw it, so every denial site stays distinguishable (#1888).
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
	// Keep only the function and the file name with its position.
	const match = /^at (?:(\S+) )?\(?(?:.*[/\\])?([^/\\():]+:\d+:\d+)\)?$/.exec(
		frame,
	);
	return match ? `${match[1] ?? "<anonymous>"}@${match[2]}` : "unlocated";
}
