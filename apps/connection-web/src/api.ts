import {
	type AdministratorsResponse,
	type Error as ApiError,
	type AuthorizationConsentRequest,
	type AuthorizationPreviewRequest,
	type AuthorizationPreviewResponse,
	authorizationConsentRequestSchema,
	authorizationPreviewRequestSchema,
	type ConnectionCreated,
	type ConnectionsResponse,
	client,
	confirmAuthorization,
	connectProviderCredential,
	createAuthorizationPreview,
	createSharedScope,
	disconnectConnection,
	disconnectSharedConnection,
	getConnections,
	getSession,
	getSharedConnections,
	grantAdministrator,
	grantSharedScopePrincipal,
	type IssuedTokenResponse,
	idempotencyKeySchema,
	issueToken,
	issueTokenRequestSchema,
	type LoginRequest,
	listAdministrators,
	listTokens,
	login,
	loginRequestSchema,
	logout,
	type OAuthTransaction,
	oauthTransactionRequestSchema,
	type ProviderCredentialRequest,
	providerCredentialRequestSchema,
	renameSharedScope,
	revokeAdministrator,
	revokeGrant,
	revokeSharedScopePrincipal,
	revokeToken,
	type Session,
	type SharedConnectionsResponse,
	type SharedScopeCreated,
	sharedScopeNameSchema,
	startGithubOAuth,
	type TokenList,
} from "@agent-infra/connection-contracts";

client.setConfig({ baseUrl: "/", credentials: "same-origin" });

export class ConnectionApiError extends Error {
	constructor(readonly detail: ApiError["error"]) {
		super(errorMessage(detail.messageKey));
	}
}

function commandHeaders(idempotencyKey: string = crypto.randomUUID()) {
	return {
		"Idempotency-Key": parseClientInput(
			idempotencyKeySchema,
			idempotencyKey,
			"请求标识无效，请刷新后重试",
		),
	};
}

function parseClientInput<T>(
	schema: {
		safeParse: (
			value: unknown,
		) => { data: T; success: true } | { error: unknown; success: false };
	},
	value: unknown,
	message: string,
) {
	const result = schema.safeParse(value);
	if (!result.success) throw new Error(message);
	return result.data;
}

const errorMessages: Record<string, string> = {
	"connection.error.authentication_failed": "账号或密码错误",
	"connection.error.authentication_required": "请重新登录 Connection",
	"connection.error.idempotency_conflict":
		"该请求标识已用于其他操作，请刷新后重试",
	"connection.error.invalid_request": "请求参数无效",
	"connection.error.invalid_token_name": "Token 名称需为 1 到 100 个字符",
	"connection.error.provider_authentication_failed":
		"外部平台凭证无效，或平台暂时无法访问",
	"connection.error.provider_unavailable": "外部平台暂时无法访问，请稍后重试",
	"connection.error.request_failed": "请求无法完成",
	"connection.error.resource_not_found": "无法访问该资源",
	"connection.error.result_uncertain": "请求结果暂时无法确认，请勿重复操作",
	"connection.error.server_error": "Connection 服务暂时不可用",
};

function errorMessage(messageKey: string) {
	return errorMessages[messageKey] ?? "请求无法完成";
}

async function unwrap<T>(
	request: PromiseLike<{ data?: T; error?: unknown }>,
): Promise<T> {
	const result = await request;
	if (result.error)
		throw new ConnectionApiError(toApiError(result.error).error);
	return result.data as T;
}

function toApiError(error: unknown): ApiError {
	if (
		typeof error === "object" &&
		error !== null &&
		"error" in error &&
		typeof error.error === "object" &&
		error.error !== null &&
		"code" in error.error &&
		"messageKey" in error.error &&
		"retryable" in error.error &&
		"traceId" in error.error &&
		typeof error.error.code === "string" &&
		typeof error.error.messageKey === "string" &&
		typeof error.error.retryable === "boolean" &&
		typeof error.error.traceId === "string"
	) {
		return error as ApiError;
	}
	return {
		error: {
			code: "NETWORK_ERROR",
			messageKey: "connection.error.server_error",
			retryable: true,
			traceId: "client",
		},
	};
}

export const connectionApi = {
	getSession: () => unwrap<Session>(getSession()),
	login: (body: LoginRequest) =>
		unwrap<Session>(
			login({
				body: parseClientInput(
					loginRequestSchema,
					body,
					"请填写有效的公司账号和密码",
				),
				headers: commandHeaders(),
			}),
		),
	logout: () => unwrap<void>(logout({ headers: commandHeaders() })),
	listTokens: () => unwrap<TokenList>(listTokens()),
	issueToken: (name: string) =>
		unwrap<IssuedTokenResponse>(
			issueToken({
				body: parseClientInput(
					issueTokenRequestSchema,
					{ name },
					"令牌名称需为 1 到 100 个字符",
				),
				headers: commandHeaders(),
			}),
		),
	revokeToken: (tokenId: string) =>
		unwrap<void>(revokeToken({ headers: commandHeaders(), path: { tokenId } })),
	getConnections: () => unwrap<ConnectionsResponse>(getConnections()),
	startGithubOAuth: (sharedScopeId?: string) =>
		unwrap<OAuthTransaction>(
			startGithubOAuth({
				body: parseClientInput(
					oauthTransactionRequestSchema,
					sharedScopeId ? { sharedScopeId } : {},
					"共享组信息无效，请刷新后重试",
				),
				headers: commandHeaders(),
			}),
		),
	connectProviderCredential: (body: ProviderCredentialRequest) =>
		unwrap<ConnectionCreated>(
			connectProviderCredential({
				body: parseClientInput(
					providerCredentialRequestSchema,
					body,
					"请填写有效的外部平台凭证",
				),
				headers: commandHeaders(),
			}),
		),
	createAuthorizationPreview: (body: AuthorizationPreviewRequest) =>
		unwrap<AuthorizationPreviewResponse>(
			createAuthorizationPreview({
				body: parseClientInput(
					authorizationPreviewRequestSchema,
					body,
					"授权信息无效，请刷新后重试",
				),
				headers: commandHeaders(),
			}),
		),
	confirmAuthorization: (
		body: AuthorizationConsentRequest & { idempotencyKey: string },
	) => {
		const { idempotencyKey, ...request } = body;
		return unwrap(
			confirmAuthorization({
				body: parseClientInput(
					authorizationConsentRequestSchema,
					request,
					"授权确认已失效，请重新预览",
				),
				headers: commandHeaders(idempotencyKey),
			}),
		);
	},
	revokeGrant: (grantId: string) =>
		unwrap<void>(revokeGrant({ headers: commandHeaders(), path: { grantId } })),
	disconnectConnection: (connectionId: string) =>
		unwrap<void>(
			disconnectConnection({
				headers: commandHeaders(),
				path: { connectionId },
			}),
		),
	listAdministrators: () =>
		unwrap<AdministratorsResponse>(listAdministrators()),
	grantAdministrator: (principalId: string) =>
		unwrap<void>(
			grantAdministrator({
				headers: commandHeaders(),
				path: { principalId },
			}),
		),
	revokeAdministrator: (principalId: string) =>
		unwrap<void>(
			revokeAdministrator({
				headers: commandHeaders(),
				path: { principalId },
			}),
		),
	getSharedConnections: () =>
		unwrap<SharedConnectionsResponse>(getSharedConnections()),
	createSharedScope: (displayName: string) =>
		unwrap<SharedScopeCreated>(
			createSharedScope({
				body: parseClientInput(
					sharedScopeNameSchema,
					{ displayName },
					"共享组名称需为 1 到 120 个字符",
				),
				headers: commandHeaders(),
			}),
		),
	renameSharedScope: (sharedScopeId: string, displayName: string) =>
		unwrap<void>(
			renameSharedScope({
				body: parseClientInput(
					sharedScopeNameSchema,
					{ displayName },
					"共享组名称需为 1 到 120 个字符",
				),
				headers: commandHeaders(),
				path: { sharedScopeId },
			}),
		),
	grantSharedScopePrincipal: (sharedScopeId: string, principalId: string) =>
		unwrap<void>(
			grantSharedScopePrincipal({
				headers: commandHeaders(),
				path: { principalId, sharedScopeId },
			}),
		),
	revokeSharedScopePrincipal: (sharedScopeId: string, principalId: string) =>
		unwrap<void>(
			revokeSharedScopePrincipal({
				headers: commandHeaders(),
				path: { principalId, sharedScopeId },
			}),
		),
	disconnectSharedConnection: (connectionId: string) =>
		unwrap<void>(
			disconnectSharedConnection({
				headers: commandHeaders(),
				path: { connectionId },
			}),
		),
};
