export type RuntimeDriverFailureKind = "unavailable";

export class RuntimeHostError extends Error {
	readonly code: string;
	readonly httpStatus: number;
	readonly retryable: boolean;
	readonly driverFailureKind?: RuntimeDriverFailureKind;

	constructor(
		code: string,
		message: string,
		httpStatus: number,
		retryable = false,
		driverFailureKind?: RuntimeDriverFailureKind,
	) {
		super(message);
		this.name = "RuntimeHostError";
		this.code = code;
		this.httpStatus = httpStatus;
		this.retryable = retryable;
		this.driverFailureKind = driverFailureKind;
	}
}
