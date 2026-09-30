import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	getPersonalRelayKeyV2,
	replacePersonalRelayKeyV2,
	revokePersonalRelayKeyV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	GetPersonalRelayKeyV2Errors,
	GetPersonalRelayKeyV2Responses,
	PersonalRelayKeyStateV1,
	ReplacePersonalRelayKeyV2Errors,
	ReplacePersonalRelayKeyV2Responses,
	RevokePersonalRelayKeyV2Errors,
	RevokePersonalRelayKeyV2Responses,
} from "../../pilot/generated-v2/types.gen.js";

export type PersonalRelayKeyFailureKind =
	| "authentication"
	| "authorization"
	| "conflict"
	| "unavailable"
	| "invalid";

export class PersonalRelayKeyError extends Error {
	readonly kind: PersonalRelayKeyFailureKind;
	readonly operation: "read" | "replace" | "revoke";
	readonly status: number | undefined;
	readonly retryable: boolean;

	constructor(
		operation: PersonalRelayKeyError["operation"],
		kind: PersonalRelayKeyFailureKind,
		status: number | undefined,
		retryable: boolean,
	) {
		super("Personal Relay Key request failed");
		this.name = "PersonalRelayKeyError";
		this.operation = operation;
		this.kind = kind;
		this.status = status;
		this.retryable = retryable;
	}
}

function failureKind(
	status: number | undefined,
	error: unknown,
): { kind: PersonalRelayKeyFailureKind; retryable: boolean } {
	if (status === 401) return { kind: "authentication", retryable: false };
	if (status === 403) return { kind: "authorization", retryable: false };
	if (status === 409) return { kind: "conflict", retryable: true };
	if (status === 503) return { kind: "unavailable", retryable: true };
	if (status !== undefined && status >= 500)
		return { kind: "unavailable", retryable: true };
	if (
		typeof error === "object" &&
		error !== null &&
		"retryable" in error &&
		(error as { retryable?: unknown }).retryable === true
	)
		return { kind: "unavailable", retryable: true };
	return { kind: "invalid", retryable: false };
}

function rejected(
	operation: PersonalRelayKeyError["operation"],
	result: { response?: Response; error?: unknown },
): never {
	const status = result.response?.status;
	const failure = failureKind(status, result.error);
	throw new PersonalRelayKeyError(
		operation,
		failure.kind,
		status,
		failure.retryable,
	);
}

export async function loadPersonalRelayKey(
	client?: Client,
	signal?: AbortSignal,
): Promise<PersonalRelayKeyStateV1> {
	const result: Awaited<
		RequestResult<
			GetPersonalRelayKeyV2Responses,
			GetPersonalRelayKeyV2Errors,
			false
		>
	> = await getPersonalRelayKeyV2<false>({
		client,
		signal,
		responseStyle: "fields",
		throwOnError: false,
	});
	if (result.data && result.response?.status === 200) return result.data;
	rejected("read", result);
}

export async function replacePersonalRelayKey(
	expectedVersion: number | null,
	keyValue: string,
	client?: Client,
	signal?: AbortSignal,
): Promise<PersonalRelayKeyStateV1> {
	const result: Awaited<
		RequestResult<
			ReplacePersonalRelayKeyV2Responses,
			ReplacePersonalRelayKeyV2Errors,
			false
		>
	> = await replacePersonalRelayKeyV2<false>({
		body: { expectedVersion, keyValue, schemaVersion: 1 },
		client,
		signal,
		responseStyle: "fields",
		throwOnError: false,
	});
	if (result.data && result.response?.status === 200) return result.data;
	rejected("replace", result);
}

export async function revokePersonalRelayKey(
	expectedVersion: number,
	client?: Client,
	signal?: AbortSignal,
): Promise<PersonalRelayKeyStateV1> {
	const result: Awaited<
		RequestResult<
			RevokePersonalRelayKeyV2Responses,
			RevokePersonalRelayKeyV2Errors,
			false
		>
	> = await revokePersonalRelayKeyV2<false>({
		body: { expectedVersion, schemaVersion: 1 },
		client,
		signal,
		responseStyle: "fields",
		throwOnError: false,
	});
	if (result.data && result.response?.status === 200) return result.data;
	rejected("revoke", result);
}
