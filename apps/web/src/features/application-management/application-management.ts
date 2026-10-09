import {
	ApplicationMetadataV1Schema,
	ApplicationRegistrationResponseV1Schema,
	ApplicationApiCredentialResponseV1Schema,
	pilotBrowserHttpOpenApiPathsV2,
} from "@agent-infra/contracts/pilot";
import type { Client, RequestResult } from "../../pilot/generated-v2/client/index.js";
import {
	disableOwnApplicationV2,
	getOwnApplicationV2,
	issueOrRotateApplicationApiCredentialV2,
	registerApplicationV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	ApplicationMetadataV1,
	IssueOrRotateApplicationApiCredentialV2Data,
	IssueOrRotateApplicationApiCredentialV2Errors,
	IssueOrRotateApplicationApiCredentialV2Responses,
	RegisterApplicationV2Errors,
	RegisterApplicationV2Responses,
	GetOwnApplicationV2Errors,
	GetOwnApplicationV2Responses,
	DisableOwnApplicationV2Errors,
	DisableOwnApplicationV2Responses,
} from "../../pilot/generated-v2/types.gen.js";
import { collectionReadFailure, type CollectionReadUnavailable } from "../collection-read-failure.js";

export type ApplicationManagementState =
	| { kind: "ready"; application: ApplicationMetadataV1 }
	| { kind: "empty" }
	| CollectionReadUnavailable;

const metadataSchema =
	pilotBrowserHttpOpenApiPathsV2["/api/v2/applications/{applicationId}"].get.responses["200"].content[
		"application/json"
	].schema;

function requestError(input: { retryable?: boolean; code?: string } = {}) {
	return Object.assign(new Error("应用管理请求暂时不可用"), {
		code: input.code,
		retryable: input.retryable !== false,
	});
}

function unavailable(status: number | undefined): CollectionReadUnavailable {
	return collectionReadFailure(status);
}

export async function loadOwnApplication(
	applicationId: string,
	client?: Client,
): Promise<ApplicationManagementState> {
	if (!applicationId) return { kind: "empty" };
	const result: Awaited<RequestResult<GetOwnApplicationV2Responses, GetOwnApplicationV2Errors, false>> =
		await getOwnApplicationV2({
			client,
			path: { applicationId },
			responseStyle: "fields",
			throwOnError: false,
		});
	if (result.response?.status === 404) return { kind: "empty" };
	if (result.response?.status !== 200) return unavailable(result.response?.status);
	if (!result.data || !metadataSchema.safeParse(result.data).success) {
		return { kind: "unavailable", retryable: false, reason: "invalid-response" };
	}
	return { kind: "ready", application: result.data };
}

export async function registerOwnApplication(
	name: string,
	idempotencyKey: string,
	client?: Client,
): Promise<ApplicationMetadataV1> {
	const result: Awaited<RequestResult<RegisterApplicationV2Responses, RegisterApplicationV2Errors, false>> =
		await registerApplicationV2({
			client,
			body: { name },
			headers: { "Idempotency-Key": idempotencyKey },
			responseStyle: "fields",
			throwOnError: false,
		});
	if (!result.data || !ApplicationRegistrationResponseV1Schema.safeParse(result.data).success) {
		throw requestError({ code: result.error?.code, retryable: result.error?.retryable });
	}
	return result.data.metadata;
}

export async function disableOwnApplication(
	applicationId: string,
	idempotencyKey: string,
	client?: Client,
): Promise<ApplicationMetadataV1> {
	const result: Awaited<RequestResult<DisableOwnApplicationV2Responses, DisableOwnApplicationV2Errors, false>> =
		await disableOwnApplicationV2({
			client,
			path: { applicationId },
			body: { status: "disabled" },
			headers: { "Idempotency-Key": idempotencyKey },
			responseStyle: "fields",
			throwOnError: false,
		});
	if (!result.data || !ApplicationMetadataV1Schema.safeParse(result.data).success) {
		throw requestError({ code: result.error?.code, retryable: result.error?.retryable });
	}
	return result.data;
}

export type ApplicationCredentialRequest = IssueOrRotateApplicationApiCredentialV2Data["body"];
export type ApplicationCredentialResponse =
	IssueOrRotateApplicationApiCredentialV2Responses[keyof IssueOrRotateApplicationApiCredentialV2Responses];

export async function issueOrRotateApplicationCredential(
	applicationId: string,
	body: ApplicationCredentialRequest,
	idempotencyKey: string,
	client?: Client,
): Promise<ApplicationCredentialResponse> {
	const result: Awaited<RequestResult<IssueOrRotateApplicationApiCredentialV2Responses, IssueOrRotateApplicationApiCredentialV2Errors, false>> =
		await issueOrRotateApplicationApiCredentialV2({
			client,
			path: { applicationId },
			body,
			headers: { "Idempotency-Key": idempotencyKey },
			responseStyle: "fields",
			throwOnError: false,
		});
	if (!result.data || !ApplicationApiCredentialResponseV1Schema.safeParse(result.data).success) {
		throw requestError({ code: result.error?.code, retryable: result.error?.retryable });
	}
	return result.data;
}
