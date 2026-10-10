import { pilotBrowserHttpOpenApiPathsV2 } from "@agent-infra/contracts/pilot";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	issuePersonalApiCredentialV2,
	listPersonalApiCredentialsV2,
	narrowPersonalApiCredentialV2,
	revokePersonalApiCredentialV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	IssuePersonalApiCredentialV2Errors,
	IssuePersonalApiCredentialV2Responses,
	ListPersonalApiCredentialsV2Errors,
	ListPersonalApiCredentialsV2Responses,
	NarrowPersonalApiCredentialV2Errors,
	NarrowPersonalApiCredentialV2Responses,
	PersonalApiCredentialIssueRequestV1,
	PersonalApiCredentialMetadataV1,
	RevokePersonalApiCredentialV2Errors,
	RevokePersonalApiCredentialV2Responses,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type CollectionReadUnavailable,
	collectionReadFailure,
} from "../collection-read-failure.js";

export const personalApiCredentialScopes = [
	"agent:read",
	"agent:use",
	"agent:manage",
	"agent:create",
] as const;

export type PersonalApiCredentialScope =
	(typeof personalApiCredentialScopes)[number];

export const personalApiCredentialScopeLabels: Record<
	PersonalApiCredentialScope,
	string
> = {
	"agent:read": "读取 Agent",
	"agent:use": "使用 Agent",
	"agent:manage": "管理 Agent",
	"agent:create": "创建 Agent",
};

export type ApiCredentialsState =
	| { kind: "ready"; credentials: PersonalApiCredentialMetadataV1[] }
	| CollectionReadUnavailable;

const pageSchema =
	pilotBrowserHttpOpenApiPathsV2["/api/v2/me/api-credentials"].get.responses[
		"200"
	].content["application/json"].schema;
const maximumPages = 100;

function requestError(input: { retryable?: boolean; code?: string } = {}) {
	return Object.assign(new Error("API 凭证请求暂时不可用"), {
		code: input.code,
		retryable: input.retryable !== false,
	});
}

function unavailable(status: number | undefined): CollectionReadUnavailable {
	return collectionReadFailure(status);
}

export function isRetryableApiCredentialsError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(!("retryable" in error) || error.retryable === true)
	);
}

/** Read only server-projected metadata. Credential material is never persisted here. */
export async function loadPersonalApiCredentials(
	client?: Client,
	signal?: AbortSignal,
): Promise<ApiCredentialsState> {
	const credentials: PersonalApiCredentialMetadataV1[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	let pages = 0;
	while (true) {
		signal?.throwIfAborted();
		if (++pages > maximumPages) throw requestError();
		const result: Awaited<
			RequestResult<
				ListPersonalApiCredentialsV2Responses,
				ListPersonalApiCredentialsV2Errors,
				false
			>
		> = await listPersonalApiCredentialsV2<false>({
			client,
			query: cursor ? { cursor } : undefined,
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		signal?.throwIfAborted();
		if (result.response?.status !== 200)
			return unavailable(result.response?.status);
		if (!result.data || !pageSchema.safeParse(result.data).success) {
			return {
				kind: "unavailable",
				retryable: false,
				reason: "invalid-response",
			};
		}
		credentials.push(...result.data.items);
		const nextCursor = result.data.nextCursor;
		if (nextCursor === null) return { kind: "ready", credentials };
		if (cursors.has(nextCursor)) throw requestError();
		cursors.add(nextCursor);
		cursor = nextCursor;
	}
}

export async function issuePersonalApiCredential(
	body: PersonalApiCredentialIssueRequestV1,
	idempotencyKey: string,
	client?: Client,
): Promise<
	IssuePersonalApiCredentialV2Responses[keyof IssuePersonalApiCredentialV2Responses]
> {
	const result: Awaited<
		RequestResult<
			IssuePersonalApiCredentialV2Responses,
			IssuePersonalApiCredentialV2Errors,
			false
		>
	> = await issuePersonalApiCredentialV2<false>({
		body,
		client,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) {
		throw requestError({
			code: result.error?.code,
			retryable: result.error?.retryable,
		});
	}
	return result.data;
}

export async function revokePersonalApiCredential(
	credentialId: string,
	idempotencyKey: string,
	client?: Client,
): Promise<
	RevokePersonalApiCredentialV2Responses[keyof RevokePersonalApiCredentialV2Responses]
> {
	const result: Awaited<
		RequestResult<
			RevokePersonalApiCredentialV2Responses,
			RevokePersonalApiCredentialV2Errors,
			false
		>
	> = await revokePersonalApiCredentialV2<false>({
		client,
		path: { credentialId },
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) {
		throw requestError({
			code: result.error?.code,
			retryable: result.error?.retryable,
		});
	}
	return result.data;
}

export async function narrowPersonalApiCredential(
	credentialId: string,
	body: { scopes?: PersonalApiCredentialScope[]; expiresAt?: string },
	idempotencyKey: string,
	client?: Client,
): Promise<
	NarrowPersonalApiCredentialV2Responses[keyof NarrowPersonalApiCredentialV2Responses]
> {
	const result: Awaited<
		RequestResult<
			NarrowPersonalApiCredentialV2Responses,
			NarrowPersonalApiCredentialV2Errors,
			false
		>
	> = await narrowPersonalApiCredentialV2<false>({
		body,
		client,
		path: { credentialId },
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) {
		throw requestError({
			code: result.error?.code,
			retryable: result.error?.retryable,
		});
	}
	return result.data;
}
