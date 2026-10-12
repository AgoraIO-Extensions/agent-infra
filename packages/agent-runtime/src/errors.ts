export type RuntimeDriverFailureKind =
	| "unavailable"
	| "session_recovery_failed";

/** Internal-only reason retained for Runtime Grant rejection diagnostics. */
export type RuntimeAuthorizationDiagnosticReason =
	| "authorization_denied"
	| "grant_expired"
	| "grant_issued_before_authority"
	| "session_authority_mismatch"
	| "execution_authority_mismatch"
	| "execution_stopped"
	| "authorization_record_mismatch"
	| "renewal_authority_mismatch"
	| "control_record_mismatch"
	| "deployment_mismatch";

export interface RuntimeHostErrorDiagnostics {
	readonly diagnosticReason?: RuntimeAuthorizationDiagnosticReason;
	readonly diagnosticSource?: string;
}

function runtimeAuthorizationSource() {
	const frame = new Error().stack
		?.split("\n")
		.slice(2)
		.find((line) => !line.includes("errors.ts"));
	return frame?.trim().replace(`${process.cwd()}/`, "") ?? "unknown";
}

export class RuntimeHostError extends Error {
	readonly code: string;
	readonly httpStatus: number;
	readonly retryable: boolean;
	readonly driverFailureKind?: RuntimeDriverFailureKind;
	readonly diagnosticReason?: RuntimeAuthorizationDiagnosticReason;
	readonly diagnosticSource?: string;

	constructor(
		code: string,
		message: string,
		httpStatus: number,
		retryable = false,
		driverFailureKind?: RuntimeDriverFailureKind,
		diagnostics?: RuntimeHostErrorDiagnostics,
	) {
		super(message);
		this.name = "RuntimeHostError";
		this.code = code;
		this.httpStatus = httpStatus;
		this.retryable = retryable;
		this.driverFailureKind = driverFailureKind;
		if (code === "RUNTIME_GRANT_INVALID") {
			this.diagnosticReason =
				diagnostics?.diagnosticReason ?? "authorization_denied";
			this.diagnosticSource =
				diagnostics?.diagnosticSource ?? runtimeAuthorizationSource();
		}
	}
}
