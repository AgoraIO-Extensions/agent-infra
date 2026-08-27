import {
	type ActionDefinition,
	ConnectionApplicationService,
	ConnectionError,
	type ConnectionOAuthService,
	type ConnectionRepository,
	type CredentialForExecution,
	type GitHubExecutor,
	type GitHubOAuthProvider,
	type InvocationContext,
	OAuthProtocolError,
	type StoredCall,
} from "@agent-infra/connection-core";
import { describe, expect, it } from "vitest";

import { createConnectionApp } from "./app";
import { createConnectionOAuthApp } from "./oauth-routes";
import { createProductionConnectionApp } from "./production-app";

const actions: ActionDefinition[] = [
	{
		description: "Read repository",
		effect: "READ",
		id: "github.getRepository@v1",
		inputSchema: { required: ["repository"] },
		name: "github.getRepository",
		requiredScopes: [],
	},
	{
		description: "Create pull request",
		effect: "WRITE",
		id: "github.createPullRequest@v1",
		inputSchema: {
			required: ["repository", "head", "base", "title", "idempotencyKey"],
		},
		name: "github.createPullRequest",
		requiredScopes: [],
	},
];

const direct: InvocationContext = {
	connectionId: "connection-alice",
	consumerId: "consumer-codex",
	credentialVersionId: "credential-alice-v1",
	grantId: "grant-alice-codex",
	instanceId: "instance-codex",
	principalId: "alice",
	providerId: "github",
	providerReleaseId: "github-release-v1",
};

const delegated: InvocationContext = {
	...direct,
	actorKey: "agent-platform-agent",
	consumerId: "consumer-platform",
	grantId: "grant-alice-platform",
	instanceId: "instance-platform",
};

class TestRepository implements ConnectionRepository {
	readonly calls: StoredCall[] = [];
	private readonly actionSet: ActionDefinition[];
	storedOAuthCredential?: { accessToken: string; principalId: string };
	private sequence = 0;
	private oauthTransactions = new Map<
		string,
		{ codeVerifier: string; principalId: string; redirectUri: string }
	>();

	constructor(actionSet: ActionDefinition[] = actions) {
		this.actionSet = actionSet;
	}

	async ensurePrincipal() {}
	async authorizeConnectionAdministration() {
		return false;
	}
	async isConnectionAdministrator() {
		return false;
	}
	async grantConnectionAdministrator() {}
	async grantSharedScopePrincipal() {}
	async listConnectionAdministratorCandidates() {
		return [];
	}
	async listConnectionAdministrators() {
		return [];
	}
	async revokeConnectionAdministrator() {}
	async revokeSharedScopePrincipal() {}
	async renameSharedScope() {}
	async sharedGithubAdministration() {
		return { principals: [], scopes: [] };
	}
	async createSharedScope() {
		return { sharedScopeId: "shared-scope-test" };
	}
	async storeSharedGithubOAuthCredential() {
		return { connectionId: "connection-shared-test" };
	}

	async createCall(input: {
		action: StoredCall["action"];
		argsHash: string;
		idempotencyKey?: string;
		input: Record<string, unknown>;
		invocation: InvocationContext;
	}) {
		const existing = input.idempotencyKey
			? await this.findIdempotentCall({
					action: input.action,
					idempotencyKey: input.idempotencyKey,
					invocation: input.invocation,
				})
			: undefined;
		if (existing) return { call: existing, created: false };
		this.sequence += 1;
		const call: StoredCall = {
			action: input.action,
			argsHash: input.argsHash,
			callId: `call-${this.sequence}`,
			connectionId: input.invocation.connectionId,
			createdAt: "2026-08-18T00:00:00.000Z",
			grantId: input.invocation.grantId,
			idempotencyKey: input.idempotencyKey,
			invocation: input.invocation,
			status: "AUTHORIZED",
		};
		this.calls.push(call);
		return { call, created: true };
	}

	async claimReconciliationJob() {
		return undefined;
	}
	async confirmCurrentConsumerAuthorization() {
		return { grantId: "grant-authorized" };
	}
	async createCurrentConsumerAuthorizationPreview(): Promise<never> {
		throw new Error(
			"Authorization preview is not used by this test repository",
		);
	}
	async publishConsumerDeclaration() {
		return { declarationId: "declaration-test" };
	}
	async completeReconciliationJob() {}

	async disconnectConnection() {}
	async disconnectSharedConnection() {}
	async createOAuthTransaction(input: {
		codeVerifier: string;
		principalId: string;
		redirectUri: string;
		state: string;
	}) {
		this.oauthTransactions.set(input.state, input);
	}
	async consumeOAuthTransaction(state: string) {
		const transaction = this.oauthTransactions.get(state);
		if (!transaction) {
			throw new ConnectionError(
				"INVALID_REQUEST",
				"OAuth state is invalid, expired, or already consumed",
			);
		}
		this.oauthTransactions.delete(state);
		return transaction;
	}
	async storeGithubOAuthCredential(input: {
		accessToken: string;
		displayName: string;
		externalAccount: string;
		principalId: string;
	}) {
		this.storedOAuthCredential = {
			accessToken: input.accessToken,
			principalId: input.principalId,
		};
		return { connectionId: "connection-oauth" };
	}
	async storeProviderCredential(input: {
		accessToken: string;
		principalId: string;
	}) {
		this.storedOAuthCredential = {
			accessToken: input.accessToken,
			principalId: input.principalId,
		};
		return { connectionId: "connection-provider" };
	}

	async findIdempotentCall(input: {
		action: StoredCall["action"];
		idempotencyKey: string;
		invocation: InvocationContext;
	}) {
		return this.calls.find(
			(call) =>
				call.action === input.action &&
				call.idempotencyKey === input.idempotencyKey &&
				call.invocation.principalId === input.invocation.principalId &&
				call.invocation.consumerId === input.invocation.consumerId &&
				call.invocation.actorKey === input.invocation.actorKey,
		);
	}

	async getCredential(
		_invocation: InvocationContext,
	): Promise<CredentialForExecution> {
		return { accessToken: "test-secret" };
	}

	async getOverview() {
		return {
			actions: this.actionSet,
			calls: this.calls,
			connections: [
				{
					actionVersionIds: this.actionSet.map((action) => action.id),
					displayName: "Alice GitHub",
					externalAccount: "alice-demo",
					id: "connection-alice",
					ownerType: "PERSONAL" as const,
					providerId: "github",
					requiresReconnect: false,
					status: "ACTIVE" as const,
				},
			],
			consumers: [],
			grants: [],
			principal: { displayName: "Alice Chen", id: "alice" },
		};
	}

	async listAuthorizedActions() {
		return this.actionSet;
	}
	async listAuthorizedConnections() {
		return (await this.getOverview()).connections;
	}

	async resolveDelegatedWorkload(_workload?: string, _actorKey?: string) {
		return delegated;
	}
	async resolveDelegatedWorkloads(_workload?: string, _actorKey?: string) {
		return [delegated];
	}

	async resolveDirectSession() {
		return direct;
	}
	async resolveDirectIdentity() {
		return direct;
	}
	async resolveDirectIdentities() {
		return [direct];
	}

	async setCallResult(input: {
		callId: string;
		result?: Record<string, unknown>;
		status: StoredCall["status"];
	}) {
		const call = this.calls.find((entry) => entry.callId === input.callId);
		if (call) {
			call.result = input.result;
			call.status = input.status;
		}
	}

	async startDispatch() {}
	async rescheduleReconciliationJob() {}

	async revokeGrant() {}
	async verifyInvocation() {}
}

function createTestApp(
	options: { actions?: ActionDefinition[]; oauth?: GitHubOAuthProvider } = {},
) {
	const executor: GitHubExecutor = {
		execute: async ({ action, input }) =>
			action === "github.getRepository"
				? { defaultBranch: "main", repository: input.repository }
				: { pullRequestUrl: "https://github.test/acme/widgets/pull/1" },
	};
	return createConnectionApp({
		accessTokens: {
			verifyAccessToken: async () => ({
				consumerId: "consumer-codex",
				instanceId: "instance-codex",
				principalId: "alice",
			}),
		},
		delegatedIdentity: {
			verifyDelegatedAssertion: async () => ({ workload: "workload-alice" }),
		},
		githubOAuthRedirectUri: "https://connection.test/oauth/github/callback",
		managementIdentity: {
			principalFromAuthorization: async () => "alice",
		},
		service: new ConnectionApplicationService(
			new TestRepository(options.actions),
			executor,
			options.oauth,
		),
	});
}

describe("Connection API", () => {
	it("exposes a Chinese browser-session JSON API for Connection Web", async () => {
		const sessionToken = `conn_session_${"S".repeat(43)}`;
		let logoutToken: string | undefined;
		const account = {
			displayName: "连接用户",
			email: "connection-user@example.invalid",
			principalId: "principal-user",
		};
		const publicAccount = {
			displayName: account.displayName,
			email: account.email,
		};
		const service = {
			getBrowserAccount: async (value: string | undefined) => {
				if (value !== sessionToken) {
					throw new OAuthProtocolError("invalid_token", "denied", 401);
				}
				return account;
			},
			loginBrowserSession: async () => ({
				account,
				expiresAt: new Date(Date.now() + 60_000),
				sessionToken,
			}),
			logoutBrowserSession: async (value: string | undefined) => {
				logoutToken = value;
			},
		} as unknown as ConnectionOAuthService;
		const app = createConnectionOAuthApp({
			issuer: "https://connection.example/",
			resource: "https://connection.example/mcp",
			service,
		});

		const unauthorized = await app.request("/api/v1/connection/session");
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toMatchObject({
			error: {
				code: "AUTHENTICATION_REQUIRED",
				messageKey: "connection.error.authentication_required",
				retryable: false,
				traceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			},
		});

		const login = await app.request("/api/v1/connection/session", {
			body: JSON.stringify({
				password: "ldap-password",
				username: "ldap-user",
			}),
			headers: {
				"content-type": "application/json",
				"idempotency-key": "test-browser-login",
				origin: "https://connection.example",
			},
			method: "POST",
		});
		expect(login.status).toBe(200);
		expect(await login.json()).toEqual({
			account: publicAccount,
			isAdministrator: false,
		});
		expect(login.headers.get("set-cookie")).toContain("Path=/");
		const cookie =
			(login.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";

		const current = await app.request("/api/v1/connection/session", {
			headers: { cookie },
		});
		expect(current.status).toBe(200);
		expect(await current.json()).toEqual({
			account: publicAccount,
			isAdministrator: false,
		});

		const logout = await app.request("/api/v1/connection/session", {
			headers: {
				cookie,
				"idempotency-key": "test-browser-logout",
				origin: "https://connection.example",
			},
			method: "DELETE",
		});
		expect(logout.status).toBe(204);
		expect(logoutToken).toBe(sessionToken);
	});

	it("maps direct Browser command replay failures to the stable 409 envelope", async () => {
		const app = createConnectionOAuthApp({
			browserCommands: {
				execute: async () => {
					throw new ConnectionError(
						"RESULT_UNCERTAIN",
						"secret response is not replayable",
					);
				},
			},
			issuer: "https://connection.example/",
			resource: "https://connection.example/mcp",
			service: {} as ConnectionOAuthService,
		});
		const response = await app.request("/api/v1/connection/session", {
			body: JSON.stringify({ password: "password", username: "user" }),
			headers: {
				"content-type": "application/json",
				"idempotency-key": "test-secret-replay",
				origin: "https://connection.example",
			},
			method: "POST",
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: {
				code: "RESULT_UNCERTAIN",
				messageKey: "connection.error.result_uncertain",
				retryable: false,
			},
		});
	});

	it("logs in once and issues a portable PAT from the authenticated console", async () => {
		const token = `conn_pat_${"A".repeat(43)}`;
		const sessionToken = `conn_session_${"B".repeat(43)}`;
		let login: { password: string; username: string } | undefined;
		let issuance:
			| { name: string; sessionToken: string | undefined }
			| undefined;
		let revokedTokenId: string | undefined;
		const tokens: Array<{
			createdAt: Date;
			expiresAt: Date;
			lastUsedAt: Date | null;
			name: string;
			status: "ACTIVE";
			tokenId: string;
		}> = [];
		const service = {
			getBrowserAccount: async (value: string | undefined) => {
				if (value !== sessionToken)
					throw new OAuthProtocolError("invalid_token", "denied", 401);
				return {
					displayName: "Connection User",
					email: "connection-user@example.invalid",
					principalId: "principal-user",
				};
			},
			issuePersonalAccessToken: async (input: {
				name: string;
				sessionToken: string | undefined;
			}) => {
				issuance = input;
				tokens.push({
					createdAt: new Date("2026-08-21T00:00:00.000Z"),
					expiresAt: new Date("2026-11-18T00:00:00.000Z"),
					lastUsedAt: null,
					name: input.name,
					status: "ACTIVE",
					tokenId: "pat-11111111-1111-4111-8111-111111111111",
				});
				return {
					expiresAt: new Date("2026-11-18T00:00:00.000Z"),
					name: input.name,
					token,
				};
			},
			listPersonalAccessTokens: async () => tokens,
			loginBrowserSession: async (input: {
				password: string;
				username: string;
			}) => {
				login = input;
				return {
					account: {
						displayName: "Connection User",
						email: "connection-user@example.invalid",
						principalId: "principal-user",
					},
					expiresAt: new Date(Date.now() + 60_000),
					sessionToken,
				};
			},
			revokePersonalAccessToken: async (input: {
				sessionToken: string | undefined;
				tokenId: string;
			}) => {
				revokedTokenId = input.tokenId;
			},
		} as unknown as ConnectionOAuthService;
		const app = createConnectionOAuthApp({
			dynamicClientRegistration: { clientName: "Codex" },
			issuer: "https://connection.example/",
			resource: "https://connection.example/mcp",
			service,
		});

		const loggedIn = await app.request("/api/v1/connection/session", {
			body: JSON.stringify({
				password: "ldap-password-must-not-be-returned",
				username: "ldap-user",
			}),
			headers: {
				"content-type": "application/json",
				"idempotency-key": "test-pat-login",
				origin: "https://connection.example",
			},
			method: "POST",
		});
		expect(loggedIn.status).toBe(200);
		const cookie =
			(loggedIn.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
		const apiTokens = await app.request("/api/v1/connection/tokens", {
			headers: { cookie },
		});
		expect(apiTokens.status).toBe(200);
		expect(await apiTokens.json()).toEqual({ tokens: [] });
		const apiIssued = await app.request("/api/v1/connection/tokens", {
			body: JSON.stringify({ name: "Connection Web" }),
			headers: {
				"content-type": "application/json",
				cookie,
				"idempotency-key": "test-pat-issue",
				origin: "https://connection.example",
			},
			method: "POST",
		});
		expect(apiIssued.status).toBe(201);
		expect(await apiIssued.json()).toMatchObject({
			issued: { name: "Connection Web", token },
		});
		const listedAfterIssue = await app.request("/api/v1/connection/tokens", {
			headers: { cookie },
		});
		expect(JSON.stringify(await listedAfterIssue.json())).not.toContain(token);
		const apiRevoked = await app.request(
			"/api/v1/connection/tokens/pat-11111111-1111-4111-8111-111111111111",
			{
				headers: {
					cookie,
					"idempotency-key": "test-pat-revoke",
					origin: "https://connection.example",
				},
				method: "DELETE",
			},
		);
		expect(apiRevoked.status).toBe(204);
		expect(revokedTokenId).toBe("pat-11111111-1111-4111-8111-111111111111");
		expect(login).toEqual({
			password: "ldap-password-must-not-be-returned",
			username: "ldap-user",
		});
		expect(issuance).toEqual({
			name: "Connection Web",
			sessionToken,
		});

		const loopbackApp = createConnectionOAuthApp({
			issuer: "http://127.0.0.1:3002/",
			resource: "http://127.0.0.1:3002/mcp",
			service,
		});
		const loopbackLogin = await loopbackApp.request(
			"/api/v1/connection/session",
			{
				body: JSON.stringify({ password: "password", username: "user" }),
				headers: {
					"content-type": "application/json",
					"idempotency-key": "test-loopback-login",
					origin: "http://127.0.0.1:3002",
				},
				method: "POST",
			},
		);
		expect(loopbackLogin.headers.get("set-cookie")).not.toContain("Secure");
		const opaqueOriginLogin = await loopbackApp.request(
			"/api/v1/connection/session",
			{
				body: JSON.stringify({ password: "password", username: "user" }),
				headers: {
					"content-type": "application/json",
					host: "127.0.0.1:3002",
					"idempotency-key": "test-opaque-login",
					origin: "null",
					"sec-fetch-site": "same-origin",
				},
				method: "POST",
			},
		);
		expect(opaqueOriginLogin.status).toBe(200);
		const opaqueCookie =
			(opaqueOriginLogin.headers.get("set-cookie") ?? "").split(";", 1)[0] ??
			"";
		const opaqueOriginIssue = await loopbackApp.request(
			"/api/v1/connection/tokens",
			{
				body: JSON.stringify({ name: "Safari laptop" }),
				headers: {
					"content-type": "application/json",
					cookie: opaqueCookie,
					host: "127.0.0.1:3002",
					"idempotency-key": "test-opaque-issue",
					origin: "null",
					"sec-fetch-site": "same-origin",
				},
				method: "POST",
			},
		);
		expect(opaqueOriginIssue.status).toBe(201);

		for (const headers of [
			{ host: "127.0.0.1:3002", origin: "null" },
			{
				host: "127.0.0.1:3002",
				origin: "null",
				"sec-fetch-site": "cross-site",
			},
			{
				host: "attacker.invalid",
				origin: "null",
				"sec-fetch-site": "same-origin",
			},
			{ host: "127.0.0.1:3002", "sec-fetch-site": "same-origin" },
		] as Array<Record<string, string>>) {
			const rejected = await loopbackApp.request("/api/v1/connection/session", {
				body: JSON.stringify({ password: "password", username: "user" }),
				headers: {
					"content-type": "application/json",
					...headers,
				},
				method: "POST",
			});
			expect(rejected.status).toBe(400);
		}

		for (const request of [
			{
				body: JSON.stringify({ name: "Rejected" }),
				method: "POST",
				path: "/api/v1/connection/tokens",
			},
			{
				body: undefined,
				method: "DELETE",
				path: "/api/v1/connection/tokens/pat-other",
			},
			{
				body: undefined,
				method: "DELETE",
				path: "/api/v1/connection/session",
			},
		]) {
			for (const origin of [undefined, "https://attacker.invalid"]) {
				const headers: Record<string, string> = {
					"content-type": "application/json",
					cookie: opaqueCookie,
				};
				if (origin) headers.origin = origin;
				const rejected = await loopbackApp.request(request.path, {
					body: request.body,
					headers,
					method: request.method,
				});
				expect(rejected.status).toBe(400);
			}
		}
		expect(() =>
			createConnectionOAuthApp({
				issuer: "http://connection.example/",
				resource: "http://connection.example/mcp",
				service,
			}),
		).toThrow(/HTTPS or exact loopback/);
	});

	it("manages GitHub Connections and Consumer grants from the authenticated console", async () => {
		const sessionToken = `conn_session_${"C".repeat(43)}`;
		const calls: Array<{ name: string; value: unknown }> = [];
		const oauth = {
			getBrowserAccount: async (value: string | undefined) => {
				if (value !== sessionToken)
					throw new OAuthProtocolError("invalid_token", "denied", 401);
				return {
					displayName: "Connection User",
					email: "connection-user@example.invalid",
					principalId: "principal-user",
				};
			},
			loginBrowserSession: async () => ({
				account: {
					displayName: "Connection User",
					email: "connection-user@example.invalid",
					principalId: "principal-user",
				},
				expiresAt: new Date(Date.now() + 60_000),
				sessionToken,
			}),
		} as unknown as ConnectionOAuthService;
		const management = {
			isConnectionAdministrator: async () => false,
			confirmCurrentConsumerAuthorization: async (value: unknown) => {
				if (
					typeof value === "object" &&
					value !== null &&
					"confirmationToken" in value &&
					value.confirmationToken === "expired-preview-token"
				) {
					throw new ConnectionError(
						"INVALID_REQUEST",
						"Authorization preview has expired",
					);
				}
				calls.push({ name: "confirm", value });
				return { grantId: "grant-new" };
			},
			createCurrentConsumerAuthorizationPreview: async (value: unknown) => {
				if (
					typeof value === "object" &&
					value !== null &&
					"connectionId" in value &&
					value.connectionId === "connection-old"
				) {
					throw new OAuthProtocolError(
						"invalid_request",
						"Reconnect GitHub before authorizing this client",
					);
				}
				calls.push({ name: "preview", value });
				return {
					actions: [actions[0]],
					confirmationToken: "opaque-preview-token",
					consumer: { id: "consumer-portable-pat", name: "Portable PAT" },
					currentConnection: {
						displayName: "Old GitHub",
						externalAccount: "octocat-old",
						id: "connection-old",
					},
					effectSummary: ["READ"],
					expiresAt: "2026-08-24T12:05:00.000Z",
					previewId: "preview-1",
					requiredScopes: [],
					targetConnection: {
						displayName: "GitHub",
						externalAccount: "octocat",
						id: "connection-github",
					},
				};
			},
			completeGithubOAuth: async (code: string, state: string) => {
				calls.push({ name: "callback", value: { code, state } });
				return { connectionId: "connection-github" };
			},
			disconnectConnection: async (
				principalId: string,
				connectionId: string,
			) => {
				calls.push({
					name: "disconnect",
					value: { connectionId, principalId },
				});
			},
			overview: async () => ({
				actions,
				calls: [],
				connections: [
					{
						actionVersionIds: [actions[0]?.id ?? ""],
						displayName: "GitHub",
						externalAccount: "octocat",
						id: "connection-github",
						ownerType: "PERSONAL" as const,
						requiresReconnect: false,
						status: "ACTIVE" as const,
					},
					{
						actionVersionIds: [],
						displayName: "Old GitHub",
						externalAccount: "octocat-old",
						id: "connection-old",
						ownerType: "PERSONAL" as const,
						requiresReconnect: true,
						status: "ACTIVE" as const,
					},
					{
						actionVersionIds: [actions[0]?.id ?? ""],
						displayName: "Agora GitHub",
						externalAccount: "agora-release-bot",
						id: "connection-shared",
						ownerType: "SHARED" as const,
						requiresReconnect: false,
						status: "ACTIVE" as const,
					},
				],
				consumers: [{ id: "consumer-portable-pat", name: "Portable PAT" }],
				grants: [
					{
						actionVersionIds: ["github.stale_action@v1"],
						connectionId: "connection-github",
						consumerId: "consumer-portable-pat",
						consumerName: "Portable PAT",
						id: "grant-existing",
						status: "ACTIVE" as const,
					},
				],
				principal: { displayName: "Connection User", id: "principal-user" },
			}),
			revokeGrant: async (principalId: string, grantId: string) => {
				calls.push({ name: "revoke", value: { grantId, principalId } });
			},
			startGithubOAuth: async (principalId: string, redirectUri: string) => {
				calls.push({ name: "connect", value: { principalId, redirectUri } });
				return {
					authorizationUrl: "https://github.test/login/oauth/authorize",
				};
			},
			connectProviderCredential: async (
				principalId: string,
				providerId: string,
				accessToken: string,
			) => {
				expect(accessToken).toBe("test-bitbucket-pat");
				calls.push({
					name: "connect-bitbucket",
					value: { principalId, providerId },
				});
				return { connectionId: "connection-bitbucket" };
			},
		} as unknown as ConnectionApplicationService;
		const app = createConnectionOAuthApp({
			issuer: "https://connection.example/",
			management: {
				githubRedirectUri: "https://connection.example/oauth/callback",
				service: management,
			},
			resource: "https://connection.example/mcp",
			service: oauth,
		});
		const login = await app.request("/api/v1/connection/session", {
			body: JSON.stringify({ password: "password", username: "user" }),
			headers: {
				"content-type": "application/json",
				"idempotency-key": "test-management-login",
				origin: "https://connection.example",
			},
			method: "POST",
		});
		expect(login.status).toBe(200);
		const cookie =
			(login.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
		const apiOverview = await app.request("/api/v1/connection/connections", {
			headers: { cookie },
		});
		expect(apiOverview.status).toBe(200);
		const apiOverviewBody = (await apiOverview.json()) as {
			overview: { principal?: unknown };
		};
		expect(apiOverviewBody).toMatchObject({
			account: { displayName: "Connection User" },
			isAdministrator: false,
			overview: {
				connections: [
					{ id: "connection-github", ownerType: "PERSONAL" },
					{ id: "connection-old", requiresReconnect: true },
					{ id: "connection-shared", ownerType: "SHARED" },
				],
			},
		});
		expect(apiOverviewBody.overview.principal).toBeUndefined();
		const apiResponses = [
			await app.request("/api/v1/connection/oauth-transactions", {
				body: "{}",
				headers: {
					"content-type": "application/json",
					cookie,
					"idempotency-key": "test-github-oauth-start",
					origin: "https://connection.example",
				},
				method: "POST",
			}),
			await app.request("/api/v1/connection/provider-credentials", {
				body: JSON.stringify({
					accessToken: "test-bitbucket-pat",
					providerId: "bitbucket",
				}),
				headers: {
					"content-type": "application/json",
					cookie,
					"idempotency-key": "test-bitbucket-connect",
					origin: "https://connection.example",
				},
				method: "POST",
			}),
			await app.request("/api/v1/connection/authorization-previews", {
				body: JSON.stringify({
					connectionId: "connection-github",
					consumerId: "consumer-portable-pat",
				}),
				headers: {
					"content-type": "application/json",
					cookie,
					"idempotency-key": "test-preview-create",
					origin: "https://connection.example",
				},
				method: "POST",
			}),
			await app.request("/api/v1/connection/authorization-consents", {
				body: JSON.stringify({
					confirmationToken: "opaque-preview-token",
					previewId: "preview-1",
				}),
				headers: {
					"content-type": "application/json",
					cookie,
					"idempotency-key": "confirmation-api",
					origin: "https://connection.example",
				},
				method: "POST",
			}),
			await app.request("/api/v1/connection/grants/grant-existing", {
				headers: {
					cookie,
					"idempotency-key": "test-grant-revoke",
					origin: "https://connection.example",
				},
				method: "DELETE",
			}),
			await app.request("/api/v1/connection/connections/connection-github", {
				headers: {
					cookie,
					"idempotency-key": "test-connection-disconnect",
					origin: "https://connection.example",
				},
				method: "DELETE",
			}),
		];
		expect(apiResponses.map(({ status }) => status)).toEqual([
			200, 201, 201, 201, 204, 204,
		]);
		expect(await apiResponses[0]?.json()).toEqual({
			authorizationUrl: "https://github.test/login/oauth/authorize",
		});
		expect(await apiResponses[1]?.json()).toEqual({
			connectionId: "connection-bitbucket",
		});
		expect(await apiResponses[2]?.json()).toMatchObject({
			idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
			preview: { previewId: "preview-1" },
		});
		expect(calls).toEqual([
			{
				name: "connect",
				value: {
					principalId: "principal-user",
					redirectUri: "https://connection.example/oauth/callback",
				},
			},
			{
				name: "connect-bitbucket",
				value: {
					principalId: "principal-user",
					providerId: "bitbucket",
				},
			},
			{
				name: "preview",
				value: {
					connectionId: "connection-github",
					consumerId: "consumer-portable-pat",
					principalId: "principal-user",
				},
			},
			{
				name: "confirm",
				value: {
					confirmationToken: "opaque-preview-token",
					idempotencyKey: "confirmation-api",
					previewId: "preview-1",
					principalId: "principal-user",
				},
			},
			{
				name: "revoke",
				value: { grantId: "grant-existing", principalId: "principal-user" },
			},
			{
				name: "disconnect",
				value: {
					connectionId: "connection-github",
					principalId: "principal-user",
				},
			},
		]);
	});

	it("allows only Connection administrators to open the administrator console", async () => {
		const mutations: Array<{ action: string; targetPrincipalId: string }> = [];
		const accounts = new Map([
			[
				"admin-session",
				{
					displayName: "Connection Admin",
					email: "admin@example.invalid",
					principalId: "principal-admin",
				},
			],
			[
				"user-session",
				{
					displayName: "Connection User",
					email: "user@example.invalid",
					principalId: "principal-user",
				},
			],
		]);
		const oauth = {
			getBrowserAccount: async (sessionToken: string | undefined) => {
				const account = sessionToken ? accounts.get(sessionToken) : undefined;
				if (!account)
					throw new OAuthProtocolError("invalid_token", "denied", 401);
				return account;
			},
		} as unknown as ConnectionOAuthService;
		const management = {
			authorizeConnectionAdministration: async (principalId: string) =>
				principalId === "principal-admin",
			grantConnectionAdministrator: async (input: {
				actorPrincipalId: string;
				targetPrincipalId: string;
			}) => {
				expect(input.actorPrincipalId).toBe("principal-admin");
				mutations.push({
					action: "grant",
					targetPrincipalId: input.targetPrincipalId,
				});
			},
			isConnectionAdministrator: async (principalId: string) =>
				principalId === "principal-admin",
			listConnectionAdministratorCandidates: async (principalId: string) => {
				expect(principalId).toBe("principal-admin");
				return [
					{
						displayName: "Connection Admin",
						email: "admin@example.invalid",
						isAdministrator: true,
						principalId: "principal-admin",
					},
					{
						displayName: "Connection User",
						email: "user@example.invalid",
						isAdministrator: false,
						principalId: "principal-user",
					},
				];
			},
			revokeConnectionAdministrator: async (input: {
				actorPrincipalId: string;
				targetPrincipalId: string;
			}) => {
				expect(input.actorPrincipalId).toBe("principal-admin");
				mutations.push({
					action: "revoke",
					targetPrincipalId: input.targetPrincipalId,
				});
			},
		} as unknown as ConnectionApplicationService;
		const app = createConnectionOAuthApp({
			issuer: "https://connection.example/",
			management: {
				githubRedirectUri: "https://connection.example/oauth/callback",
				service: management,
			},
			resource: "https://connection.example/mcp",
			service: oauth,
		});

		const deniedApi = await app.request(
			"/api/v1/connection/admin/administrators",
			{ headers: { cookie: "connection_session=user-session" } },
		);
		expect(deniedApi.status).toBe(404);
		expect(await deniedApi.json()).toMatchObject({
			error: {
				code: "RESOURCE_NOT_FOUND",
				messageKey: "connection.error.resource_not_found",
			},
		});
		const adminApi = await app.request(
			"/api/v1/connection/admin/administrators",
			{ headers: { cookie: "connection_session=admin-session" } },
		);
		expect(adminApi.status).toBe(200);
		expect(await adminApi.json()).toMatchObject({
			administrators: [
				{ isAdministrator: true, principalId: "principal-admin" },
				{ isAdministrator: false, principalId: "principal-user" },
			],
		});
		const adminHeaders = {
			cookie: "connection_session=admin-session",
			"idempotency-key": "test-administrator-mutation",
			origin: "https://connection.example",
		};
		const apiMutations = await Promise.all([
			app.request("/api/v1/connection/admin/administrators/principal-user", {
				headers: adminHeaders,
				method: "PUT",
			}),
			app.request("/api/v1/connection/admin/administrators/principal-admin", {
				headers: adminHeaders,
				method: "DELETE",
			}),
		]);
		expect(apiMutations.map(({ status }) => status)).toEqual([204, 204]);
		expect(mutations).toEqual([
			{ action: "grant", targetPrincipalId: "principal-user" },
			{ action: "revoke", targetPrincipalId: "principal-admin" },
		]);
	});

	it("manages Shared GitHub Connections without granting administrators implicit eligibility", async () => {
		const sessionToken = "shared-admin-session";
		const calls: Array<{ action: string; value: unknown }> = [];
		const oauth = {
			getBrowserAccount: async (value: string | undefined) => {
				if (value === "shared-user-session") {
					return {
						displayName: "Shared User",
						email: "shared-user@example.invalid",
						principalId: "principal-user",
					};
				}
				if (value !== sessionToken)
					throw new OAuthProtocolError("invalid_token", "denied", 401);
				return {
					displayName: "Shared Admin",
					email: "shared-admin@example.invalid",
					principalId: "principal-admin",
				};
			},
		} as unknown as ConnectionOAuthService;
		const management = {
			authorizeConnectionAdministration: async (principalId: string) =>
				principalId === "principal-admin",
			createSharedScope: async (value: unknown) => {
				calls.push({ action: "create-scope", value });
				return { sharedScopeId: "scope-company" };
			},
			disconnectSharedConnection: async (value: unknown) => {
				calls.push({ action: "disconnect", value });
			},
			grantSharedScopePrincipal: async (value: unknown) => {
				calls.push({ action: "grant", value });
			},
			isConnectionAdministrator: async (principalId: string) =>
				principalId === "principal-admin",
			revokeSharedScopePrincipal: async (value: unknown) => {
				calls.push({ action: "revoke", value });
			},
			renameSharedScope: async (value: unknown) => {
				calls.push({ action: "rename", value });
			},
			sharedGithubAdministration: async (principalId: string) => {
				expect(principalId).toBe("principal-admin");
				return {
					principals: [
						{
							displayName: "Shared Admin",
							email: "shared-admin@example.invalid",
							principalId: "principal-admin",
						},
						{
							displayName: "Eligible User",
							email: "eligible@example.invalid",
							principalId: "principal-eligible",
						},
					],
					scopes: [
						{
							connections: [
								{
									displayName: "Agora GitHub",
									externalAccount: "agora-release-bot",
									id: "connection-shared",
									status: "ACTIVE" as const,
								},
							],
							displayName: "Agora Engineering",
							members: ["principal-eligible"],
							sharedScopeId: "scope-company",
							state: "ACTIVE" as const,
						},
					],
				};
			},
			startSharedGithubOAuth: async (
				actorPrincipalId: string,
				sharedScopeId: string,
				redirectUri: string,
			) => {
				calls.push({
					action: "connect",
					value: { actorPrincipalId, redirectUri, sharedScopeId },
				});
				return {
					authorizationUrl: "https://github.test/login/oauth/authorize",
				};
			},
		} as unknown as ConnectionApplicationService;
		const app = createConnectionOAuthApp({
			issuer: "https://connection.example/",
			management: {
				githubRedirectUri: "https://connection.example/oauth/callback",
				service: management,
			},
			resource: "https://connection.example/mcp",
			service: oauth,
		});
		const cookie = `connection_session=${sessionToken}`;
		const deniedApi = await app.request(
			"/api/v1/connection/admin/shared-connections",
			{ headers: { cookie: "connection_session=shared-user-session" } },
		);
		expect(deniedApi.status).toBe(404);
		expect(await deniedApi.json()).toMatchObject({
			error: {
				code: "RESOURCE_NOT_FOUND",
				messageKey: "connection.error.resource_not_found",
			},
		});
		const sharedApi = await app.request(
			"/api/v1/connection/admin/shared-connections",
			{ headers: { cookie } },
		);
		expect(sharedApi.status).toBe(200);
		expect(await sharedApi.json()).toMatchObject({
			overview: {
				scopes: [
					{
						displayName: "Agora Engineering",
						sharedScopeId: "scope-company",
					},
				],
			},
		});
		const apiHeaders = {
			"content-type": "application/json",
			cookie,
			"idempotency-key": "test-shared-mutation",
			origin: "https://connection.example",
		};
		const apiMutations = [
			await app.request("/api/v1/connection/admin/shared-scopes", {
				body: JSON.stringify({ displayName: "中国研发" }),
				headers: apiHeaders,
				method: "POST",
			}),
			await app.request(
				"/api/v1/connection/admin/shared-scopes/scope-company",
				{
					body: JSON.stringify({ displayName: "发布工程" }),
					headers: apiHeaders,
					method: "PATCH",
				},
			),
			await app.request(
				"/api/v1/connection/admin/shared-scopes/scope-company/principals/principal-admin",
				{ headers: apiHeaders, method: "PUT" },
			),
			await app.request(
				"/api/v1/connection/admin/shared-scopes/scope-company/principals/principal-eligible",
				{ headers: apiHeaders, method: "DELETE" },
			),
			await app.request("/api/v1/connection/oauth-transactions", {
				body: JSON.stringify({ sharedScopeId: "scope-company" }),
				headers: apiHeaders,
				method: "POST",
			}),
			await app.request(
				"/api/v1/connection/admin/shared-connections/connection-shared",
				{ headers: apiHeaders, method: "DELETE" },
			),
		];
		expect(apiMutations.map(({ status }) => status)).toEqual([
			201, 204, 204, 204, 200, 204,
		]);
		expect(await apiMutations[0]?.json()).toEqual({
			sharedScopeId: "scope-company",
		});
		expect(await apiMutations[4]?.json()).toEqual({
			authorizationUrl: "https://github.test/login/oauth/authorize",
		});
		expect(calls).toEqual(
			expect.arrayContaining([
				{
					action: "create-scope",
					value: {
						actorPrincipalId: "principal-admin",
						displayName: "中国研发",
					},
				},
				{
					action: "rename",
					value: {
						actorPrincipalId: "principal-admin",
						displayName: "发布工程",
						sharedScopeId: "scope-company",
					},
				},
				{
					action: "connect",
					value: {
						actorPrincipalId: "principal-admin",
						redirectUri: "https://connection.example/oauth/callback",
						sharedScopeId: "scope-company",
					},
				},
			]),
		);
	});

	it("limits DCR to the measured Codex native-client profile", async () => {
		const redirectUri = "http://127.0.0.1:58245/callback/test-nonce";
		const service = {
			registerClient: async () => ({
				clientId: "client-codex",
				clientName: "Codex",
				consumerId: "consumer-codex",
				consumerName: "Codex",
				instanceId: "instance-codex",
				redirectUris: [redirectUri],
			}),
		} as unknown as ConnectionOAuthService;
		const app = createConnectionOAuthApp({
			dynamicClientRegistration: { clientName: "Codex" },
			issuer: "https://connection.example/",
			resource: "https://connection.example/mcp",
			service,
		});
		const metadata = {
			application_type: "native",
			client_name: "Codex",
			grant_types: ["authorization_code", "refresh_token"],
			redirect_uris: [redirectUri],
			response_types: ["code"],
			scope: "mcp",
			token_endpoint_auth_method: "none",
		};
		const registration = await app.request("/oauth/register", {
			body: JSON.stringify(metadata),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(registration.status).toBe(201);
		expect(await registration.json()).toMatchObject({ scope: "mcp" });
		for (const rejected of [
			{ ...metadata, client_name: "Unapproved client" },
			{ ...metadata, redirect_uris: ["https://attacker.example/callback"] },
			{ ...metadata, scope: "admin" },
			{ ...metadata, software_id: "unreviewed" },
		]) {
			expect(
				(
					await app.request("/oauth/register", {
						body: JSON.stringify(rejected),
						headers: { "content-type": "application/json" },
						method: "POST",
					})
				).status,
			).toBe(400);
		}
	});

	it("publishes the versioned Connection Browser OpenAPI contract", async () => {
		const app = createConnectionOAuthApp({
			issuer: "https://connection.example/",
			resource: "https://connection.example/mcp",
			service: {} as ConnectionOAuthService,
		});
		const response = await app.request("/api/v1/connection/openapi.json");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const document = (await response.json()) as {
			info: { title: string; version: string };
			openapi: string;
			paths: Record<string, unknown>;
		};
		expect(document).toMatchObject({
			info: { title: "Connection Browser API", version: "1.0.0" },
			openapi: "3.1.0",
		});
		expect(Object.keys(document.paths)).toEqual(
			expect.arrayContaining([
				"/api/v1/connection/session",
				"/api/v1/connection/tokens",
				"/api/v1/connection/connections",
				"/api/v1/connection/authorization-previews",
				"/api/v1/connection/admin/administrators",
				"/api/v1/connection/admin/shared-connections",
			]),
		);
	});

	it("renders the retained OAuth security interaction in Chinese", async () => {
		const app = createConnectionOAuthApp({
			issuer: "https://connection.example/",
			resource: "https://connection.example/mcp",
			service: {
				beginAuthorization: async () => ({
					clientName: "Codex",
					requestId: "oauth-request-id",
				}),
			} as unknown as ConnectionOAuthService,
		});
		const response = await app.request("/oauth/authorize");
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('<html lang="zh-CN">');
		expect(body).toContain("登录 Connection");
		expect(body).toContain("公司账号");
		expect(body).toContain("密码");
		expect(body).not.toContain("Company username");
	});

	it("identifies the issuer on OAuth authorization responses", async () => {
		let approvalCalls = 0;
		const service = {
			approveAuthorization: async () => {
				approvalCalls += 1;
				return {
					code: "authorization-code",
					redirectUri: "http://127.0.0.1:58245/callback/test-nonce",
					state: "authorization-state",
				};
			},
		} as unknown as ConnectionOAuthService;
		const app = createConnectionOAuthApp({
			issuer: "https://connection.example/",
			resource: "https://connection.example/mcp",
			service,
		});

		const metadata = await app.request(
			"/.well-known/oauth-authorization-server",
		);
		expect(await metadata.json()).toMatchObject({
			authorization_response_iss_parameter_supported: true,
		});
		const loginBody = new URLSearchParams({
			password: "password",
			request_id: "request-id",
			username: "user",
		});
		for (const origin of [undefined, "https://attacker.invalid"]) {
			const headers: Record<string, string> = {
				"content-type": "application/x-www-form-urlencoded",
			};
			if (origin) headers.origin = origin;
			expect(
				(
					await app.request("/oauth/login", {
						body: loginBody,
						headers,
						method: "POST",
					})
				).status,
			).toBe(400);
		}
		expect(approvalCalls).toBe(0);

		const response = await app.request("/oauth/login", {
			body: loginBody,
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "https://connection.example",
			},
			method: "POST",
		});
		const redirect = new URL(response.headers.get("location") ?? "");

		expect(response.status).toBe(302);
		expect(approvalCalls).toBe(1);
		expect(redirect.searchParams.get("code")).toBe("authorization-code");
		expect(redirect.searchParams.get("iss")).toBe(
			"https://connection.example/",
		);
		expect(redirect.searchParams.get("state")).toBe("authorization-state");
	});

	it("keeps production identity and MCP routes closed while G-01 is open", async () => {
		const app = createProductionConnectionApp();
		expect((await app.request("/healthz")).status).toBe(200);
		expect((await app.request("/")).status).toBe(200);
		expect((await app.request("/mcp", { method: "POST" })).status).toBe(404);
		expect(
			(await app.request("/.well-known/oauth-authorization-server")).status,
		).toBe(404);
	});

	it("reports health without requiring a configured database", async () => {
		const response = await createConnectionApp().request("/healthz");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "connection-api",
			status: "ok",
		});
	});

	it("does not expose Direct Action REST routes alongside MCP", async () => {
		const app = createTestApp();
		const tools = await app.request("/api/direct/tools", {
			headers: { authorization: "Bearer test" },
		});
		const invoke = await app.request(
			"/api/direct/actions/github.getRepository",
			{
				body: JSON.stringify({ repository: "acme/widgets" }),
				headers: {
					"content-type": "application/json",
					authorization: "Bearer test",
				},
				method: "POST",
			},
		);

		expect([tools.status, invoke.status]).toEqual([404, 404]);
	});

	it("uses the HTTP idempotency header for delegated writes", async () => {
		const app = createTestApp();
		const request = () =>
			app.request("/connection/internal/v1/action-calls", {
				body: JSON.stringify({
					actionVersionId: "github.createPullRequest@v1",
					deadlineAt: "2099-01-01T00:00:00.000Z",
					args: {
						base: "main",
						head: "feature/login",
						repository: "acme/widgets",
						title: "Login",
					},
				}),
				headers: {
					"content-type": "application/json",
					"delegated-assertion": "signed-assertion",
					"idempotency-key": "retry-1",
				},
				method: "POST",
			});
		const first = await request();
		const retry = await request();
		expect(first.status).toBe(200);
		expect(await retry.json()).toEqual(await first.json());
	});

	it("keeps removed Direct REST routes closed for every payload", async () => {
		const app = createTestApp();
		const malformed = await app.request(
			"/api/direct/actions/github.getRepository",
			{
				body: "{",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer test",
				},
				method: "POST",
			},
		);
		const selector = await app.request(
			"/api/direct/actions/github.getRepository",
			{
				body: JSON.stringify({
					connectionId: "other",
					repository: "acme/widgets",
				}),
				headers: {
					"content-type": "application/json",
					authorization: "Bearer test",
				},
				method: "POST",
			},
		);
		expect([malformed.status, selector.status]).toEqual([404, 404]);
	});

	it("describes the API root and accepts disconnect", async () => {
		const app = createTestApp();
		const root = await app.request("/");
		const disconnected = await app.request(
			"/api/connections/connection-alice/disconnect",
			{
				headers: { authorization: "Bearer test" },
				method: "POST",
			},
		);

		expect(root.status).toBe(200);
		expect(await root.json()).toEqual({
			health: "/healthz",
			service: "connection-api",
			ui: "http://localhost:3001",
		});
		expect(disconnected.status).toBe(204);
	});

	it("runs GitHub OAuth through a server-owned callback and rejects replay", async () => {
		const oauth: GitHubOAuthProvider = {
			exchangeCode: async ({ code, codeVerifier, redirectUri }) => {
				expect(code).toBe("provider-code");
				expect(codeVerifier).toHaveLength(43);
				expect(redirectUri).toBe(
					"https://connection.test/oauth/github/callback",
				);
				return {
					accessToken: "provider-secret",
					displayName: "Alice GitHub",
					externalAccount: "alice-github",
					grantedScopes: ["repo"],
				};
			},
			getAuthorizationUrl: ({ codeChallenge, redirectUri, state }) =>
				`https://github.test/authorize?challenge=${codeChallenge}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
		};
		const app = createTestApp({ oauth });
		const start = await app.request("/api/github/oauth/start", {
			headers: { authorization: "Bearer test" },
			method: "POST",
		});
		const authorizationUrl = new URL(
			((await start.json()) as { authorizationUrl: string }).authorizationUrl,
		);
		const state = authorizationUrl.searchParams.get("state");

		expect(start.status).toBe(200);
		expect(authorizationUrl.searchParams.get("challenge")).toHaveLength(43);
		expect(state).toHaveLength(43);
		const callback = await app.request(
			`/oauth/github/callback?code=provider-code&state=${state}`,
			{
				redirect: "manual",
			},
		);
		const replay = await app.request(
			`/oauth/github/callback?code=provider-code&state=${state}`,
		);

		expect(callback.status).toBe(302);
		expect(callback.headers.get("location")).toBe("http://localhost:3001");
		expect(replay.status).toBe(400);
		expect(JSON.stringify(await replay.json())).not.toContain(
			"provider-secret",
		);
	});

	it("serves direct GitHub actions through the MCP JSON-RPC contract", async () => {
		const app = createTestApp();
		const headers = {
			"content-type": "application/json",
			authorization: "Bearer test",
		};
		const initialize = await app.request("/mcp", {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
			headers,
			method: "POST",
		});
		const list = await app.request("/mcp", {
			body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
			headers,
			method: "POST",
		});
		const call = await app.request("/mcp", {
			body: JSON.stringify({
				id: 3,
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					arguments: {
						actionId: "github.getRepository",
						input: { repository: "acme/widgets" },
					},
					name: "execute_action",
				},
			}),
			headers,
			method: "POST",
		});

		expect(initialize.status).toBe(200);
		const initializePayload = (await initialize.json()) as {
			result: {
				instructions: string;
				serverInfo: { name: string };
			};
		};
		expect(initializePayload.result.serverInfo.name).toBe("connection");
		expect(initializePayload.result.instructions).toContain(
			"Connection resolves the current user",
		);
		const listedTools = (
			(await list.json()) as {
				result: {
					tools: Array<{
						annotations: { readOnlyHint: boolean };
						name: string;
					}>;
				};
			}
		).result.tools;
		expect(listedTools.map((tool) => tool.name)).toEqual([
			"list_apps",
			"list_connections",
			"search_actions",
			"get_action_guide",
			"execute_action",
		]);
		expect(listedTools.map((tool) => tool.annotations.readOnlyHint)).toEqual([
			true,
			true,
			true,
			true,
			false,
		]);
		expect(call.status).toBe(200);
		expect(JSON.stringify(await call.json())).not.toContain("test-secret");
	});

	it("rejects selector fields outside the fixed MCP tool schemas", async () => {
		const response = await createTestApp().request("/mcp", {
			body: JSON.stringify({
				id: 1,
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					arguments: { connectionId: "caller-selected" },
					name: "list_connections",
				},
			}),
			headers: {
				authorization: "Bearer test",
				"content-type": "application/json",
			},
			method: "POST",
		});

		expect(await response.json()).toMatchObject({
			error: { code: -32602, message: expect.stringContaining("connectionId") },
		});
	});

	it("discovers and executes an authorized catalog action without a route map", async () => {
		const app = createTestApp({
			actions: [
				...actions,
				{
					description: "List branches in a repository.",
					effect: "READ",
					id: "github.listBranches@v1",
					inputSchema: { required: ["owner", "repo"] },
					name: "github.listBranches",
					requiredScopes: [],
				},
			],
		});
		const headers = {
			"content-type": "application/json",
			authorization: "Bearer test",
		};
		const list = await app.request("/mcp", {
			body: JSON.stringify({
				id: 1,
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					arguments: { query: "branches" },
					name: "search_actions",
				},
			}),
			headers,
			method: "POST",
		});
		const call = await app.request("/mcp", {
			body: JSON.stringify({
				id: 2,
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					arguments: {
						actionId: "github.listBranches",
						input: { owner: "acme", repo: "widgets" },
					},
					name: "execute_action",
				},
			}),
			headers,
			method: "POST",
		});

		expect(list.status).toBe(200);
		expect(
			(
				(await list.json()) as {
					result: {
						structuredContent: { actions: Array<{ actionId: string }> };
					};
				}
			).result.structuredContent.actions.map((action) => action.actionId),
		).toContain("github.listBranches");
		expect(call.status).toBe(200);
	});

	it("publishes the write idempotency key in the action guide", async () => {
		const app = createTestApp();
		const response = await app.request("/mcp", {
			body: JSON.stringify({
				id: 1,
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					arguments: { actionId: "github.createPullRequest" },
					name: "get_action_guide",
				},
			}),
			headers: {
				authorization: "Bearer test",
				"content-type": "application/json",
			},
			method: "POST",
		});
		const payload = (await response.json()) as {
			result: {
				structuredContent: {
					guide: string;
					inputSchema: { required: string[] };
				};
			};
		};

		expect(response.status).toBe(200);
		expect(payload.result.structuredContent.inputSchema.required).toContain(
			"idempotencyKey",
		);
		expect(payload.result.structuredContent.guide).toContain(
			'"idempotencyKey"',
		);
	});

	it("keeps the generic MCP contract visible while Provider gates are closed", async () => {
		const app = createConnectionApp({
			accessTokens: {
				verifyAccessToken: async () => ({
					consumerId: "consumer-codex",
					instanceId: "instance-codex",
					principalId: "alice",
				}),
			},
			directMcpEnabled: true,
			githubProviderEnabled: false,
		});
		const headers = {
			authorization: "Bearer test",
			"content-type": "application/json",
		};
		const list = await app.request("/mcp", {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
			headers,
			method: "POST",
		});
		const call = await app.request("/mcp", {
			body: JSON.stringify({
				id: 2,
				jsonrpc: "2.0",
				method: "tools/call",
				params: { arguments: {}, name: "execute_action" },
			}),
			headers,
			method: "POST",
		});

		expect(
			(
				(await list.json()) as { result: { tools: Array<{ name: string }> } }
			).result.tools.map((tool) => tool.name),
		).toEqual([
			"list_apps",
			"list_connections",
			"search_actions",
			"get_action_guide",
			"execute_action",
		]);
		expect(await call.json()).toEqual({
			error: { code: -32601, message: "Connection tool is not available" },
			id: 2,
			jsonrpc: "2.0",
		});
		expect((await app.request("/api/overview")).status).toBe(404);
	});

	it("does not accept an MCP bearer as a management identity", async () => {
		const app = createConnectionApp({
			accessTokens: {
				verifyAccessToken: async () => ({
					consumerId: "consumer-portable-pat",
					instanceId: "instance-pat",
					principalId: "alice",
				}),
			},
			service: new ConnectionApplicationService(new TestRepository(), {
				execute: async () => ({}),
			}),
		});
		expect((await app.request("/api/overview")).status).toBe(404);
		expect(
			(
				await app.request("/api/connections/connection-alice/disconnect", {
					headers: { authorization: "Bearer conn_pat_test" },
					method: "POST",
				})
			).status,
		).toBe(404);
		expect(
			(
				await app.request("/api/github/oauth/start", {
					headers: { authorization: "Bearer conn_pat_test" },
					method: "POST",
				})
			).status,
		).toBe(404);
	});

	it("does not accept a portable PAT on legacy Direct REST routes", async () => {
		const app = createConnectionApp({
			accessTokens: {
				verifyAccessToken: async () => ({
					consumerId: "consumer-portable-pat",
					instanceId: "instance-pat",
					principalId: "alice",
				}),
			},
			service: new ConnectionApplicationService(new TestRepository(), {
				execute: async () => ({}),
			}),
		});
		const authorization = { authorization: "Bearer conn_pat_test" };
		const tools = await app.request("/api/direct/tools", {
			headers: authorization,
		});
		const authorize = await app.request("/api/direct/authorizations", {
			body: JSON.stringify({
				actionVersionIds: ["github.getRepository@v1"],
				connectionId: "connection-alice",
			}),
			headers: { ...authorization, "content-type": "application/json" },
			method: "POST",
		});
		const action = await app.request(
			"/api/direct/actions/github.getRepository",
			{
				body: JSON.stringify({ repository: "acme/widgets" }),
				headers: { ...authorization, "content-type": "application/json" },
				method: "POST",
			},
		);

		expect([tools.status, authorize.status, action.status]).toEqual([
			404, 404, 404,
		]);
	});

	it("does not publish optional protocols when production gates are closed", async () => {
		const app = createConnectionApp({
			directMcpEnabled: false,
			githubProviderEnabled: false,
			service: new ConnectionApplicationService(new TestRepository(), {
				execute: async () => ({}),
			}),
		});

		const mcp = await app.request("/mcp", { method: "POST" });
		const authorize = await app.request("/api/direct/authorizations", {
			method: "POST",
		});
		const directTools = await app.request("/api/direct/tools");
		const directAction = await app.request(
			"/api/direct/actions/github.getRepository",
			{ method: "POST" },
		);
		const delegatedAction = await app.request(
			"/connection/internal/v1/action-calls",
			{ method: "POST" },
		);
		const provider = await app.request("/api/github/oauth/start", {
			method: "POST",
		});
		const grantUpdate = await app.request(
			"/api/grants/grant-alice-codex/actions",
			{ method: "PUT" },
		);
		const grantRevoke = await app.request(
			"/api/grants/grant-alice-codex/revoke",
			{ method: "POST" },
		);
		const disconnect = await app.request(
			"/api/connections/connection-alice/disconnect",
			{ method: "POST" },
		);

		expect(mcp.status).toBe(404);
		expect(authorize.status).toBe(404);
		expect(directTools.status).toBe(404);
		expect(directAction.status).toBe(404);
		expect(delegatedAction.status).toBe(404);
		expect(provider.status).toBe(404);
		expect(grantUpdate.status).toBe(404);
		expect(grantRevoke.status).toBe(404);
		expect(disconnect.status).toBe(404);
	});

	it("publishes MCP protected-resource metadata and challenges unauthenticated calls", async () => {
		const resourceUrl = "https://connection.example/mcp";
		const app = createConnectionApp({
			directMcpEnabled: true,
			oauthServer: {
				issuer: "https://id.example/",
				resource: resourceUrl,
				service: undefined as never,
			},
			accessTokens: {
				verifyAccessToken: async () => {
					throw new ConnectionError(
						"AUTHENTICATION_FAILED",
						"Bearer token is required",
					);
				},
			},
			service: new ConnectionApplicationService(new TestRepository(), {
				execute: async () => ({}),
			}),
		});

		const unauthenticated = await app.request("/mcp", {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const metadata = await app.request(
			"/.well-known/oauth-protected-resource/mcp",
		);
		const authorizationMetadata = await app.request(
			"/.well-known/oauth-authorization-server",
		);

		expect(unauthenticated.status).toBe(401);
		expect(unauthenticated.headers.get("www-authenticate")).toBe(
			'Bearer resource_metadata="https://connection.example/.well-known/oauth-protected-resource/mcp"',
		);
		expect(await metadata.json()).toEqual({
			authorization_servers: ["https://id.example/"],
			resource: resourceUrl,
			scopes_supported: ["mcp"],
		});
		expect(await authorizationMetadata.json()).not.toHaveProperty(
			"registration_endpoint",
		);
		expect(
			(await app.request("/oauth/register", { method: "POST" })).status,
		).toBe(404);
	});
});
