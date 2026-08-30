export class RuntimeHostError extends Error {
	readonly code: string;
	readonly httpStatus: number;
	readonly retryable: boolean;

	constructor(
		code: string,
		message: string,
		httpStatus: number,
		retryable = false,
	) {
		super(message);
		this.name = "RuntimeHostError";
		this.code = code;
		this.httpStatus = httpStatus;
		this.retryable = retryable;
	}
}
