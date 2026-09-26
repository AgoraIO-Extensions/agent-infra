import {
	type AccessConnectReady,
	type AccessOptionsResponse,
	type AccessPolicyDraft,
	type AccessRequest,
	type AccessRequestSubmit,
	type AccessRequestsResponse,
	type AdminAccessAuthorizationsResponse,
	type AdministratorsResponse,
	type Error as ApiError,
	type ApprovalAuthorizationRevoke,
	type ApprovalDecisionRequest,
	type ApprovalDelegationDraft,
	type ApprovalDelegationsResponse,
	type ApprovalNotificationsResponse,
	type ApprovalPolicyCatalog,
	type ApprovalPolicyPublishRequest,
	type ApprovalPolicyRevokeRequest,
	type ApprovalPolicyRevokeResult,
	type ApprovalPolicyStages,
	type ApprovalQueueResponse,
	type ApprovalRerouteRequest,
	type ApprovalRoutingBlockedResponse,
	type AuthorizationConsentRequest,
	type AuthorizationPreviewRequest,
	type AuthorizationPreviewResponse,
	accessPolicyDraftSchema,
	accessRequestSubmitSchema,
	approvalPolicyPublishSchema,
	approvalPolicyRevokeSchema,
	archiveConnectionNotifications,
	authorizationConsentRequestSchema,
	authorizationPreviewRequestSchema,
	type CapabilityProfileDraft,
	type ConnectionCreated,
	type ConnectionsResponse,
	type ConnectionWorkItemsResponse,
	cancelConnectionAccessRequest,
	capabilityProfileDraftSchema,
	client,
	confirmAuthorization,
	connectProviderCredential,
	createApprovalCapabilityProfile,
	createApprovalDelegation,
	createApprovalDisclaimer,
	createAuthorizationPreview,
	createConnectionAccessPolicy,
	createReapprovalCampaign,
	createSharedScope,
	type DisclaimerDraft,
	decideConnectionAccessRequest,
	disclaimerDraftSchema,
	disconnectConnection,
	disconnectSharedConnection,
	getApprovalPolicyStages,
	getConnectionAccessRequest,
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
	listAdminAccessAuthorizations,
	listAdministrators,
	listApprovalDelegations,
	listApprovalPolicyCatalog,
	listApprovalRoutingBlocked,
	listConnectionAccessOptions,
	listConnectionAccessRequests,
	listConnectionApprovalQueue,
	listConnectionNotifications,
	listConnectionOutboxFailures,
	listConnectionWorkItems,
	listProviderUpgradeCampaigns,
	listTokens,
	login,
	loginRequestSchema,
	logout,
	notificationBatchSchema,
	type OAuthTransaction,
	type OutboxFailuresResponse,
	oauthTransactionRequestSchema,
	type ProviderCredentialRequest,
	type ProviderReconnectRequest,
	type ProviderUpgradeCampaignsResponse,
	prepareConnectionAccess,
	providerCredentialRequestSchema,
	providerReconnectRequestSchema,
	publishApprovalCapabilityProfile,
	publishApprovalDisclaimer,
	publishConnectionAccessPolicy,
	type ReapprovalCampaignDraft,
	readConnectionNotifications,
	reapprovalCampaignDraftSchema,
	reauthorizeProviderConnection,
	renameSharedScope,
	rerouteApprovalRequest,
	retryConnectionOutboxFailure,
	revokeAdminAccessAuthorization,
	revokeAdministrator,
	revokeApprovalDelegation,
	revokeConnectionAccessPolicy,
	revokeGrant,
	revokeSharedScopePrincipal,
	revokeToken,
	type Session,
	type SharedConnectionsResponse,
	type SharedScopeCreated,
	searchApprovalEmployeeCandidates,
	sharedScopeNameSchema,
	startGithubOAuth,
	submitConnectionAccessRenewal,
	submitConnectionAccessRequest,
	type TokenList,
	upgradeProviderConnection,
} from "@agent-infra/connection-contracts";

client.setConfig({ baseUrl: "/", credentials: "same-origin" });

export type PatConsumerProfile = {
	callbackUrl: string;
	consumerId: string;
	consumerName: string;
	status: "ACTIVE" | "DISABLED";
};

export type ConsumerDeclarationOptions = {
	consumer: { id: string; name: string };
	providers: Array<{
		actions: Array<{
			description: string;
			effect: "READ" | "WRITE";
			id: string;
			name: string;
			requiredScopes: string[];
		}>;
		providerId: string;
		providerReleaseId: string;
	}>;
};

async function patConsumerRequest<T>(path: string, init?: RequestInit) {
	const response = await fetch(path, {
		...init,
		credentials: "same-origin",
		headers: {
			...(init?.body ? { "content-type": "application/json" } : {}),
			...(init?.method && init.method !== "GET" ? commandHeaders() : {}),
			...init?.headers,
		},
	});
	if (!response.ok) throw new Error("Agent 接入操作失败");
	return (response.status === 204 ? undefined : await response.json()) as T;
}

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
	prepareConnectionAccess: (requestId: string) =>
		unwrap<AccessConnectReady>(
			prepareConnectionAccess({
				headers: commandHeaders(),
				path: { requestId },
			}),
		),
	createReapprovalCampaign: (body: ReapprovalCampaignDraft) =>
		unwrap(
			createReapprovalCampaign({
				body: parseClientInput(
					reapprovalCampaignDraftSchema,
					body,
					"重审活动无效",
				),
				headers: commandHeaders(),
			}),
		),
	listAdminAccessAuthorizations: () =>
		unwrap<AdminAccessAuthorizationsResponse>(listAdminAccessAuthorizations()),
	revokeAdminAccessAuthorization: (input: {
		authorizationId: string;
		body: ApprovalAuthorizationRevoke;
	}) =>
		unwrap(
			revokeAdminAccessAuthorization({
				body: input.body,
				headers: commandHeaders(),
				path: { authorizationId: input.authorizationId },
			}),
		),
	listApprovalRoutingBlocked: () =>
		unwrap<ApprovalRoutingBlockedResponse>(listApprovalRoutingBlocked()),
	rerouteApprovalRequest: (input: {
		requestId: string;
		body: ApprovalRerouteRequest;
	}) =>
		unwrap(
			rerouteApprovalRequest({
				body: input.body,
				headers: commandHeaders(),
				path: { requestId: input.requestId },
			}),
		),
	getConnectionAccessRequest: (requestId: string) =>
		unwrap<AccessRequest>(getConnectionAccessRequest({ path: { requestId } })),
	listConnectionNotifications: () =>
		unwrap<ApprovalNotificationsResponse>(listConnectionNotifications()),
	listConnectionWorkItems: () =>
		unwrap<ConnectionWorkItemsResponse>(listConnectionWorkItems()),
	updateApprovalNotification: (input: {
		notificationId: string;
		body: { action: "READ" | "ARCHIVE" };
	}) =>
		unwrap<void>(
			(input.body.action === "READ"
				? readConnectionNotifications
				: archiveConnectionNotifications)({
				body: parseClientInput(
					notificationBatchSchema,
					{ notificationIds: [input.notificationId] },
					"通知标识无效",
				),
				headers: commandHeaders(),
			}),
		),
	getConnectionAccessOptions: () =>
		unwrap<AccessOptionsResponse>(listConnectionAccessOptions()),
	listConnectionAccessRequests: () =>
		unwrap<AccessRequestsResponse>(listConnectionAccessRequests()),
	cancelConnectionAccessRequest: (requestId: string) =>
		unwrap<void>(
			cancelConnectionAccessRequest({
				headers: commandHeaders(),
				path: { requestId },
			}),
		),
	submitConnectionAccessRequest: (body: AccessRequestSubmit) =>
		unwrap(submitConnectionAccessRequest({ body, headers: commandHeaders() })),
	submitConnectionAccessRenewal: (input: {
		authorizationId: string;
		body: AccessRequestSubmit;
	}) =>
		unwrap(
			submitConnectionAccessRenewal({
				body: parseClientInput(
					accessRequestSubmitSchema,
					input.body,
					"续期申请无效",
				),
				headers: commandHeaders(),
				path: { authorizationId: input.authorizationId },
			}),
		),
	listConnectionApprovalQueue: () =>
		unwrap<ApprovalQueueResponse>(listConnectionApprovalQueue()),
	decideConnectionAccessRequest: (input: {
		requestId: string;
		body: ApprovalDecisionRequest;
	}) =>
		unwrap(
			decideConnectionAccessRequest({
				body: input.body,
				headers: commandHeaders(),
				path: { requestId: input.requestId },
			}),
		),
	listApprovalPolicyCatalog: () =>
		unwrap<ApprovalPolicyCatalog>(listApprovalPolicyCatalog()),
	listApprovalDelegations: () =>
		unwrap<ApprovalDelegationsResponse>(listApprovalDelegations()),
	listOutboxFailures: () =>
		unwrap<OutboxFailuresResponse>(listConnectionOutboxFailures()),
	retryOutboxFailure: (eventId: string, expectedAttempts: number) =>
		unwrap(
			retryConnectionOutboxFailure({
				body: { expectedAttempts },
				headers: commandHeaders(),
				path: { eventId },
			}),
		),
	createApprovalDelegation: (body: ApprovalDelegationDraft) =>
		unwrap(createApprovalDelegation({ body, headers: commandHeaders() })),
	revokeApprovalDelegation: (delegationId: string, expectedRevision: string) =>
		unwrap(
			revokeApprovalDelegation({
				body: { expectedRevision },
				headers: commandHeaders(),
				path: { delegationId },
			}),
		),
	getApprovalPolicyStages: (policyId: string) =>
		unwrap<ApprovalPolicyStages>(
			getApprovalPolicyStages({ path: { policyId } }),
		),
	searchApprovalEmployees: (query: string) =>
		unwrap(searchApprovalEmployeeCandidates({ query: { query } })),
	createApprovalCapabilityProfile: (body: CapabilityProfileDraft) =>
		unwrap(
			createApprovalCapabilityProfile({
				body: parseClientInput(
					capabilityProfileDraftSchema,
					body,
					"能力包无效",
				),
				headers: commandHeaders(),
			}),
		),
	publishApprovalCapabilityProfile: (profileId: string) =>
		unwrap<void>(
			publishApprovalCapabilityProfile({
				headers: commandHeaders(),
				path: { profileId },
			}),
		),
	createApprovalDisclaimer: (body: DisclaimerDraft) =>
		unwrap(
			createApprovalDisclaimer({
				body: parseClientInput(disclaimerDraftSchema, body, "免责声明无效"),
				headers: commandHeaders(),
			}),
		),
	publishApprovalDisclaimer: (disclaimerId: string) =>
		unwrap<void>(
			publishApprovalDisclaimer({
				headers: commandHeaders(),
				path: { disclaimerId },
			}),
		),
	createConnectionAccessPolicy: (body: AccessPolicyDraft) =>
		unwrap(
			createConnectionAccessPolicy({
				body: parseClientInput(accessPolicyDraftSchema, body, "审批策略无效"),
				headers: commandHeaders(),
			}),
		),
	publishConnectionAccessPolicy: (input: {
		policyId: string;
		body: ApprovalPolicyPublishRequest;
	}) =>
		unwrap<void>(
			publishConnectionAccessPolicy({
				body: parseClientInput(
					approvalPolicyPublishSchema,
					input.body,
					"策略发布参数无效",
				),
				headers: commandHeaders(),
				path: { policyId: input.policyId },
			}),
		),
	revokeConnectionAccessPolicy: (input: {
		policyId: string;
		body: ApprovalPolicyRevokeRequest;
	}) =>
		unwrap<ApprovalPolicyRevokeResult>(
			revokeConnectionAccessPolicy({
				body: parseClientInput(
					approvalPolicyRevokeSchema,
					input.body,
					"策略撤销参数无效",
				),
				headers: commandHeaders(),
				path: { policyId: input.policyId },
			}),
		),
	listPatConsumers: () =>
		patConsumerRequest<{ consumers: PatConsumerProfile[] }>(
			"/api/v1/connection/admin/pat-consumers",
		),
	registerPatConsumer: (input: {
		callbackUrl: string;
		consumerId: string;
		consumerName: string;
	}) =>
		patConsumerRequest<{
			issued: PatConsumerProfile & { secret: string };
		}>("/api/v1/connection/admin/pat-consumers", {
			body: JSON.stringify(input),
			method: "POST",
		}),
	disablePatConsumer: (consumerId: string) =>
		patConsumerRequest<void>(
			`/api/v1/connection/admin/pat-consumers/${encodeURIComponent(consumerId)}`,
			{ method: "DELETE" },
		),
	getConsumerDeclarationOptions: (consumerId: string) =>
		patConsumerRequest<ConsumerDeclarationOptions>(
			`/api/v1/connection/admin/consumers/${encodeURIComponent(consumerId)}/declarations`,
		),
	publishConsumerDeclaration: (
		consumerId: string,
		input: { actionVersionIds: string[]; providerReleaseId: string },
	) =>
		patConsumerRequest<{ declarationId: string }>(
			`/api/v1/connection/admin/consumers/${encodeURIComponent(consumerId)}/declarations`,
			{ body: JSON.stringify(input), method: "POST" },
		),
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
	issueToken: (body: { consumerId?: string; name: string }) =>
		unwrap<IssuedTokenResponse>(
			issueToken({
				body: parseClientInput(
					issueTokenRequestSchema,
					body,
					"令牌名称需为 1 到 100 个字符",
				),
				headers: commandHeaders(),
			}),
		),
	revokeToken: (tokenId: string) =>
		unwrap<void>(revokeToken({ headers: commandHeaders(), path: { tokenId } })),
	getConnections: () => unwrap<ConnectionsResponse>(getConnections()),
	startGithubOAuth: (sharedScopeId?: string, accessRequestId?: string) =>
		unwrap<OAuthTransaction>(
			startGithubOAuth({
				body: parseClientInput(
					oauthTransactionRequestSchema,
					sharedScopeId
						? { sharedScopeId }
						: accessRequestId
							? { accessRequestId }
							: {},
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
	reauthorizeProviderConnection: (input: {
		connectionId: string;
		body: ProviderReconnectRequest;
	}) =>
		unwrap<ConnectionCreated | OAuthTransaction>(
			reauthorizeProviderConnection({
				body: parseClientInput(
					providerReconnectRequestSchema,
					input.body,
					"重连凭证无效",
				),
				headers: commandHeaders(),
				path: { connectionId: input.connectionId },
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
	upgradeProviderConnection: (connectionId: string) =>
		unwrap<ConnectionCreated>(
			upgradeProviderConnection({
				headers: commandHeaders(),
				path: { connectionId },
			}),
		),
	listAdministrators: () =>
		unwrap<AdministratorsResponse>(listAdministrators()),
	listProviderUpgradeCampaigns: () =>
		unwrap<ProviderUpgradeCampaignsResponse>(listProviderUpgradeCampaigns()),
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
