import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	grantAgentApplicationManagerV1,
	grantAgentApplicationUseV1,
	grantAgentUserApiManageV1,
	grantAgentUserApiUseV1,
	revokeAgentApplicationManagerV1,
	revokeAgentApplicationUseV1,
	revokeAgentUserApiManageV1,
	revokeAgentUserApiUseV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	AgentApplicationManagerResponseV1,
	AgentUserManageGrantRequestV1,
	AgentUserManageGrantResponseV1,
	AgentUserManageRevokeRequestV1,
	AgentUserManageRevokeResponseV1,
	AgentUserUseGrantRequestV1,
	AgentUserUseGrantResponseV1,
	AgentUserUseRevokeRequestV1,
	AgentUserUseRevokeResponseV1,
	GrantAgentApplicationManagerV1Responses,
	GrantAgentApplicationUseV1Responses,
	GrantAgentUserApiManageV1Responses,
	GrantAgentUserApiUseV1Responses,
	RevokeAgentApplicationManagerV1Responses,
	RevokeAgentApplicationUseV1Responses,
	RevokeAgentUserApiManageV1Responses,
	RevokeAgentUserApiUseV1Responses,
} from "../../pilot/generated-v2/types.gen.js";

export class AgentAuthorizationRequestError extends Error {
	readonly status: number | undefined;
	readonly retryable: boolean;

	constructor(status: number | undefined, retryable: boolean) {
		super("Agent authorization request was not confirmed");
		this.name = "AgentAuthorizationRequestError";
		this.status = status;
		this.retryable = retryable;
	}
}

type RequestResponse<T> = {
	data?: T;
	response?: { status?: number };
};

function requestError(result: RequestResponse<unknown>) {
	const status = result.response?.status;
	return new AgentAuthorizationRequestError(
		status,
		status === undefined || status >= 500,
	);
}

function requireData<T>(result: RequestResponse<T>) {
	if (result.response?.status !== 200 || !result.data)
		throw requestError(result);
	return result.data;
}

type ApplicationRequestResult<T> = Awaited<RequestResult<T, unknown, false>>;

const operationKey = () => crypto.randomUUID();

export function grantApplicationManager(
	agentId: string,
	applicationId: string,
	client?: Client,
): Promise<AgentApplicationManagerResponseV1> {
	return grantAgentApplicationManagerV1<false>({
		client,
		body: { schemaVersion: 1 },
		headers: { "Idempotency-Key": operationKey() },
		path: { agentId, applicationId },
		responseStyle: "fields",
		throwOnError: false,
	}).then(
		(
			result: ApplicationRequestResult<GrantAgentApplicationManagerV1Responses>,
		) => requireData(result),
	);
}

export function revokeApplicationManager(
	agentId: string,
	applicationId: string,
	client?: Client,
): Promise<AgentApplicationManagerResponseV1> {
	return revokeAgentApplicationManagerV1<false>({
		client,
		body: { schemaVersion: 1 },
		headers: { "Idempotency-Key": operationKey() },
		path: { agentId, applicationId },
		responseStyle: "fields",
		throwOnError: false,
	}).then(
		(
			result: ApplicationRequestResult<RevokeAgentApplicationManagerV1Responses>,
		) => requireData(result),
	);
}

export function grantApplicationUse(
	agentId: string,
	applicationId: string,
	client?: Client,
): Promise<AgentApplicationManagerResponseV1> {
	return grantAgentApplicationUseV1<false>({
		client,
		body: { schemaVersion: 1 },
		headers: { "Idempotency-Key": operationKey() },
		path: { agentId, applicationId },
		responseStyle: "fields",
		throwOnError: false,
	}).then(
		(result: ApplicationRequestResult<GrantAgentApplicationUseV1Responses>) =>
			requireData(result),
	);
}

export function revokeApplicationUse(
	agentId: string,
	applicationId: string,
	client?: Client,
): Promise<AgentApplicationManagerResponseV1> {
	return revokeAgentApplicationUseV1<false>({
		client,
		body: { schemaVersion: 1 },
		headers: { "Idempotency-Key": operationKey() },
		path: { agentId, applicationId },
		responseStyle: "fields",
		throwOnError: false,
	}).then(
		(result: ApplicationRequestResult<RevokeAgentApplicationUseV1Responses>) =>
			requireData(result),
	);
}

export function revokeUserApiUse(
	agentId: string,
	userId: string,
	expectedRevision: number,
	client?: Client,
): Promise<AgentUserUseRevokeResponseV1> {
	return revokeAgentUserApiUseV1<false>({
		client,
		body: {
			expectedRevision,
			schemaVersion: 1,
		} satisfies AgentUserUseRevokeRequestV1,
		headers: { "Idempotency-Key": operationKey() },
		path: { agentId, userId },
		responseStyle: "fields",
		throwOnError: false,
	}).then(
		(result: ApplicationRequestResult<RevokeAgentUserApiUseV1Responses>) =>
			requireData(result),
	);
}

export function grantUserApiUse(
	agentId: string,
	userId: string,
	expectedRevision: number,
	client?: Client,
): Promise<AgentUserUseGrantResponseV1> {
	return grantAgentUserApiUseV1<false>({
		client,
		body: {
			expectedRevision,
			schemaVersion: 1,
		} satisfies AgentUserUseGrantRequestV1,
		headers: { "Idempotency-Key": operationKey() },
		path: { agentId, userId },
		responseStyle: "fields",
		throwOnError: false,
	}).then((result: ApplicationRequestResult<GrantAgentUserApiUseV1Responses>) =>
		requireData(result),
	);
}

/** Owner 给用户授予某个 Agent 的 API 管理权（#2759），服务端校验 Owner 身份与管理修订。 */
export function grantUserApiManage(
	agentId: string,
	userId: string,
	expectedRevision: number,
	client?: Client,
): Promise<AgentUserManageGrantResponseV1> {
	return grantAgentUserApiManageV1<false>({
		client,
		body: {
			expectedRevision,
			schemaVersion: 1,
		} satisfies AgentUserManageGrantRequestV1,
		headers: { "Idempotency-Key": operationKey() },
		path: { agentId, userId },
		responseStyle: "fields",
		throwOnError: false,
	}).then(
		(result: ApplicationRequestResult<GrantAgentUserApiManageV1Responses>) =>
			requireData(result),
	);
}

export function revokeUserApiManage(
	agentId: string,
	userId: string,
	expectedRevision: number,
	client?: Client,
): Promise<AgentUserManageRevokeResponseV1> {
	return revokeAgentUserApiManageV1<false>({
		client,
		body: {
			expectedRevision,
			schemaVersion: 1,
		} satisfies AgentUserManageRevokeRequestV1,
		headers: { "Idempotency-Key": operationKey() },
		path: { agentId, userId },
		responseStyle: "fields",
		throwOnError: false,
	}).then(
		(result: ApplicationRequestResult<RevokeAgentUserApiManageV1Responses>) =>
			requireData(result),
	);
}
