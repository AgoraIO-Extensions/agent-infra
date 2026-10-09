import {
	PersonalRelayKeyReplaceRequestV1Schema,
	PersonalRelayKeyRevokeRequestV1Schema,
	PersonalRelayKeyStateV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
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

function failureKind(status: number | undefined): PersonalRelayKeyFailureKind {
	if (status === 401) return "authentication";
	if (status === 403) return "authorization";
	if (status === 409) return "conflict";
	if (status !== undefined && status >= 500) return "unavailable";
	return "invalid";
}

function rejected(
	operation: PersonalRelayKeyError["operation"],
	result: { response?: Response; error?: unknown },
): never {
	const status = result.response?.status;
	if (status === undefined) transportFailure(operation);
	const parsed = PilotProtocolErrorV1Schema.safeParse(result.error);
	if (!parsed.success)
		throw new PersonalRelayKeyError(operation, "invalid", status, false);
	throw new PersonalRelayKeyError(
		operation,
		failureKind(status),
		status,
		parsed.data.retryable,
	);
}

function transportFailure(
	operation: PersonalRelayKeyError["operation"],
): never {
	throw new PersonalRelayKeyError(operation, "unavailable", undefined, true);
}

function accepted(
	operation: PersonalRelayKeyError["operation"],
	result: { data?: unknown; response?: Response; error?: unknown },
): PersonalRelayKeyStateV1 {
	if (result.response?.status === 200) {
		const parsed = PersonalRelayKeyStateV1Schema.safeParse(result.data);
		if (parsed.success) return parsed.data;
		throw new PersonalRelayKeyError(operation, "invalid", 200, false);
	}
	rejected(operation, result);
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
	}).catch(() => transportFailure("read"));
	return accepted("read", result);
}

export async function replacePersonalRelayKey(
	expectedVersion: number | null,
	keyValue: string,
	client?: Client,
	signal?: AbortSignal,
): Promise<PersonalRelayKeyStateV1> {
	const body = PersonalRelayKeyReplaceRequestV1Schema.safeParse({
		expectedVersion,
		keyValue,
	});
	if (!body.success)
		throw new PersonalRelayKeyError("replace", "invalid", undefined, false);
	const result: Awaited<
		RequestResult<
			ReplacePersonalRelayKeyV2Responses,
			ReplacePersonalRelayKeyV2Errors,
			false
		>
	> = await replacePersonalRelayKeyV2<false>({
		body: body.data,
		client,
		signal,
		responseStyle: "fields",
		throwOnError: false,
	}).catch(() => transportFailure("replace"));
	return accepted("replace", result);
}

export async function revokePersonalRelayKey(
	expectedVersion: number,
	client?: Client,
	signal?: AbortSignal,
): Promise<PersonalRelayKeyStateV1> {
	const body = PersonalRelayKeyRevokeRequestV1Schema.safeParse({
		expectedVersion,
	});
	if (!body.success)
		throw new PersonalRelayKeyError("revoke", "invalid", undefined, false);
	const result: Awaited<
		RequestResult<
			RevokePersonalRelayKeyV2Responses,
			RevokePersonalRelayKeyV2Errors,
			false
		>
	> = await revokePersonalRelayKeyV2<false>({
		body: body.data,
		client,
		signal,
		responseStyle: "fields",
		throwOnError: false,
	}).catch(() => transportFailure("revoke"));
	return accepted("revoke", result);
}
