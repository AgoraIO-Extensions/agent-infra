import {
	type DelegatedActionErrorV1,
	DelegatedActionRequestV1Schema,
	type DelegatedActionResultV1,
	validateDelegatedActionResultV1,
} from "@agent-infra/contracts/pilot";

const completedAt = "2026-08-28T10:00:01Z";

function resultBase(requestInput: unknown) {
	const request = DelegatedActionRequestV1Schema.parse(requestInput);
	return {
		request,
		result: {
			schemaVersion: 1,
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			traceId: request.traceId,
			actionId: request.action.actionId,
			actionVersion: request.action.actionVersion,
			completedAt,
		},
	} as const;
}

export function fakeDelegatedActionSuccessV1(
	requestInput: unknown,
	output: unknown = { accepted: true },
): DelegatedActionResultV1 {
	const { request, result } = resultBase(requestInput);
	return validateDelegatedActionResultV1(request, {
		...result,
		callId: `call-${request.requestId}`,
		status: "succeeded",
		output,
	});
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K & keyof T>
	: never;

type DelegatedFailureOptions = {
	callId?: string | null;
	completedAt?: string;
	error?: DistributiveOmit<DelegatedActionErrorV1, "schemaVersion" | "traceId">;
};

export function fakeDelegatedActionFailureV1(
	requestInput: unknown,
	options: DelegatedFailureOptions = {},
): DelegatedActionResultV1 {
	const { request, result } = resultBase(requestInput);
	const error = options.error ?? {
		code: "CONNECTION_UNAVAILABLE",
		message: "Connection is unavailable",
		retryable: true,
	};
	return validateDelegatedActionResultV1(request, {
		...result,
		callId: options.callId ?? null,
		completedAt: options.completedAt ?? result.completedAt,
		status: "failed",
		error: {
			...error,
			schemaVersion: 1,
			traceId: request.traceId,
		},
	});
}
