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

	async resolveDelegatedWorkload() {
		return delegated;
	}

	async resolveDirectSession() {
		return direct;
	}
	async resolveDirectIdentity() {
		return direct;
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
	it("logs in once and issues a portable PAT from the authenticated console", async () => {
		const token = `conn_pat_${"A".repeat(43)}`;
		const sessionToken = `conn_session_${"B".repeat(43)}`;
		let login: { password: string; username: string } | undefined;
		let issuance:
			| { name: string; sessionToken: string | undefined }
			| undefined;
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
		} as unknown as ConnectionOAuthService;
		const app = createConnectionOAuthApp({
			dynamicClientRegistration: { clientName: "Codex" },
			issuer: "https://connection.example/",
			resource: "https://connection.example/mcp",
			service,
		});

		expect((await app.request("/connection/tokens")).status).toBe(302);
		const page = await app.request("/connection/login");
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Sign in to Connection");

		const loggedIn = await app.request("/connection/login", {
			body: new URLSearchParams({
				password: "ldap-password-must-not-be-returned",
				username: "ldap-user",
			}),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "https://connection.example",
			},
			method: "POST",
		});
		expect(loggedIn.status).toBe(303);
		const cookie =
			(loggedIn.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
		const consolePage = await app.request("/connection/tokens", {
			headers: { cookie },
		});
		const consoleBody = await consolePage.text();
		expect(consoleBody).toContain("Connection navigation");
		expect(consoleBody).toContain("Use a separate token");
		expect(consoleBody).not.toContain('name="password"');

		const issued = await app.request("/connection/tokens", {
			body: new URLSearchParams({
				name: "Codex laptop",
			}),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				cookie,
				origin: "https://connection.example",
			},
			method: "POST",
		});
		expect(issued.status).toBe(201);
		expect(issued.headers.get("cache-control")).toBe("no-store");
		const result = await issued.text();
		expect(result).toContain(token);
		expect(result).toContain("Codex laptop");
		expect(result).toContain("It will not be shown again");
		expect(result).not.toContain("ldap-password-must-not-be-returned");
		expect(login).toEqual({
			password: "ldap-password-must-not-be-returned",
			username: "ldap-user",
		});
		expect(issuance).toEqual({
			name: "Codex laptop",
			sessionToken,
		});

		const loopbackApp = createConnectionOAuthApp({
			issuer: "http://127.0.0.1:3002/",
			resource: "http://127.0.0.1:3002/mcp",
			service,
		});
		const loopbackLogin = await loopbackApp.request("/connection/login", {
			body: new URLSearchParams({ password: "password", username: "user" }),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "http://127.0.0.1:3002",
			},
			method: "POST",
		});
		expect(loopbackLogin.headers.get("set-cookie")).not.toContain("Secure");
		const opaqueOriginLogin = await loopbackApp.request("/connection/login", {
			body: new URLSearchParams({ password: "password", username: "user" }),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				host: "127.0.0.1:3002",
				origin: "null",
				"sec-fetch-site": "same-origin",
			},
			method: "POST",
		});
		expect(opaqueOriginLogin.status).toBe(303);
		const opaqueCookie =
			(opaqueOriginLogin.headers.get("set-cookie") ?? "").split(";", 1)[0] ??
			"";
		const opaqueOriginIssue = await loopbackApp.request("/connection/tokens", {
			body: new URLSearchParams({ name: "Safari laptop" }),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				cookie: opaqueCookie,
				host: "127.0.0.1:3002",
				origin: "null",
				"sec-fetch-site": "same-origin",
			},
			method: "POST",
		});
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
			const rejected = await loopbackApp.request("/connection/login", {
				body: new URLSearchParams({ password: "password", username: "user" }),
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					...headers,
				},
				method: "POST",
			});
			expect(rejected.status).toBe(400);
		}

		for (const path of [
			"/connection/tokens",
			"/connection/tokens/pat-other/revoke",
			"/connection/logout",
		]) {
			for (const origin of [undefined, "https://attacker.invalid"]) {
				const headers: Record<string, string> = {
					"content-type": "application/x-www-form-urlencoded",
					cookie: opaqueCookie,
				};
				if (origin) headers.origin = origin;
				const rejected = await loopbackApp.request(path, {
					body: new URLSearchParams({ name: "Rejected" }),
					headers,
					method: "POST",
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
		const login = await app.request("/connection/login", {
			body: new URLSearchParams({ password: "password", username: "user" }),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "https://connection.example",
			},
			method: "POST",
		});
		expect(login.headers.get("location")).toBe("/connection/connections");
		const cookie =
			(login.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
		const page = await app.request("/connection/connections", {
			headers: { cookie },
		});
		const body = await page.text();
		expect(body).toContain("GitHub account octocat");
		expect(body).toContain("Portable PAT");
		expect(body).toContain("Use with Portable PAT");
		expect(body).not.toContain(
			'action="/connection/grants/grant-existing/revoke"',
		);
		expect(body).toContain("Reconnect GitHub");
		expect(body).toContain("SHARED");
		expect(body).toContain("GitHub account agora-release-bot");
		expect(body).not.toContain(
			'action="/connection/connections/connection-shared/disconnect"',
		);
		expect(body).toContain(
			'href="/connection/connections/github" target="_blank" rel="noopener noreferrer">Add GitHub account</a>',
		);

		const formHeaders = {
			"content-type": "application/x-www-form-urlencoded",
			cookie,
			origin: "https://connection.example",
		};
		const preview = await app.request(
			"/connection/connections/connection-github/authorize",
			{
				body: new URLSearchParams({ consumer_id: "consumer-portable-pat" }),
				headers: formHeaders,
				method: "POST",
			},
		);
		expect(preview.status).toBe(200);
		const previewBody = await preview.text();
		expect(previewBody).toContain("Review access for Portable PAT");
		expect(previewBody).toContain("Current GitHub account octocat-old");
		expect(previewBody).toContain("New GitHub account octocat");
		expect(previewBody).toContain("READ");
		expect(previewBody).toContain("Confirm switch");
		expect(previewBody).toContain('href="/connection/connections">Cancel</a>');
		expect(previewBody).not.toContain('name="connection_id"');
		expect(previewBody).not.toContain('name="action_version_ids"');
		expect(calls).toEqual([
			{
				name: "preview",
				value: {
					connectionId: "connection-github",
					consumerId: "consumer-portable-pat",
					principalId: "principal-user",
				},
			},
		]);

		const responses = [
			await app.request("/connection/connections/github", {
				headers: { cookie },
			}),
			await app.request(
				"/connection/authorization-previews/preview-1/confirm",
				{
					body: new URLSearchParams({
						confirmation_token: "opaque-preview-token",
						idempotency_key: "confirmation-1",
					}),
					headers: formHeaders,
					method: "POST",
				},
			),
			await app.request("/connection/grants/grant-existing/revoke", {
				headers: formHeaders,
				method: "POST",
			}),
			await app.request(
				"/connection/connections/connection-github/disconnect",
				{
					headers: formHeaders,
					method: "POST",
				},
			),
			await app.request("/oauth/callback?code=github-code&state=oauth-state"),
		];
		expect(responses.map((response) => response.status)).toEqual([
			303, 303, 303, 303, 303,
		]);
		expect(responses[0]?.headers.get("location")).toBe(
			"https://github.test/login/oauth/authorize",
		);
		const expiredConfirmation = await app.request(
			"/connection/authorization-previews/preview-expired/confirm",
			{
				body: new URLSearchParams({
					confirmation_token: "expired-preview-token",
					idempotency_key: "confirmation-expired",
				}),
				headers: formHeaders,
				method: "POST",
			},
		);
		expect(expiredConfirmation.status).toBe(400);
		expect(await expiredConfirmation.json()).toEqual({
			error: "invalid_request",
			error_description: "Authorization preview has expired",
		});
		const staleAuthorization = await app.request(
			"/connection/connections/connection-old/authorize",
			{
				body: new URLSearchParams({ consumer_id: "consumer-portable-pat" }),
				headers: formHeaders,
				method: "POST",
			},
		);
		expect(staleAuthorization.status).toBe(400);
		expect(await staleAuthorization.json()).toEqual({
			error: "invalid_request",
			error_description: "Reconnect GitHub before authorizing this client",
		});
		expect(calls).toEqual([
			{
				name: "preview",
				value: {
					connectionId: "connection-github",
					consumerId: "consumer-portable-pat",
					principalId: "principal-user",
				},
			},
			{
				name: "connect",
				value: {
					principalId: "principal-user",
					redirectUri: "https://connection.example/oauth/callback",
				},
			},
			{
				name: "confirm",
				value: {
					confirmationToken: "opaque-preview-token",
					idempotencyKey: "confirmation-1",
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
			{
				name: "callback",
				value: { code: "github-code", state: "oauth-state" },
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

		const userResponse = await app.request("/connection/admin/administrators", {
			headers: { cookie: "connection_session=user-session" },
		});
		expect(userResponse.status).toBe(403);
		const denied = await userResponse.json();
		expect(denied).toMatchObject({
			error: "forbidden",
			message: "Connection administration is not authorized",
			retryable: false,
			traceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(JSON.stringify(denied)).not.toContain("admin@example.invalid");

		const adminResponse = await app.request(
			"/connection/admin/administrators",
			{ headers: { cookie: "connection_session=admin-session" } },
		);
		expect(adminResponse.status).toBe(200);
		const body = await adminResponse.text();
		expect(body).toContain("Administrators");
		expect(body).toContain("admin@example.invalid");
		expect(body).toContain("user@example.invalid");
		expect(body).toContain(
			'action="/connection/admin/administrators/principal-user/grant"',
		);
		expect(body).toContain(
			'action="/connection/admin/administrators/principal-admin/revoke"',
		);

		const formHeaders = {
			cookie: "connection_session=admin-session",
			origin: "https://connection.example",
		};
		const adminMutations = await Promise.all([
			app.request("/connection/admin/administrators/principal-user/grant", {
				headers: formHeaders,
				method: "POST",
			}),
			app.request("/connection/admin/administrators/principal-admin/revoke", {
				headers: formHeaders,
				method: "POST",
			}),
		]);
		expect(adminMutations.map((response) => response.status)).toEqual([
			303, 303,
		]);
		expect(mutations).toEqual([
			{ action: "grant", targetPrincipalId: "principal-user" },
			{ action: "revoke", targetPrincipalId: "principal-admin" },
		]);

		const userMutations = await Promise.all([
			app.request("/connection/admin/administrators/principal-user/grant", {
				headers: {
					cookie: "connection_session=user-session",
					origin: "https://connection.example",
				},
				method: "POST",
			}),
			app.request("/connection/admin/administrators/principal-admin/revoke", {
				headers: {
					cookie: "connection_session=user-session",
					origin: "https://connection.example",
				},
				method: "POST",
			}),
		]);
		expect(userMutations.map((response) => response.status)).toEqual([
			403, 403,
		]);
		expect(mutations).toHaveLength(2);
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
		expect(
			(
				await app.request("/connection/admin/shared-connections", {
					headers: { cookie: "connection_session=shared-user-session" },
				})
			).status,
		).toBe(403);

		const page = await app.request("/connection/admin/shared-connections", {
			headers: { cookie },
		});
		expect(page.status).toBe(200);
		const body = await page.text();
		expect(body).toContain("Shared GitHub Connections");
		expect(body).toContain("Agora Engineering");
		expect(body).toContain(
			'action="/connection/admin/shared-connections/scope-company/rename"',
		);
		expect(body).toContain('value="Agora Engineering"');
		expect(body).toContain("agora-release-bot");
		expect(body).toContain("Eligible User");
		expect(body).toContain(
			'href="/connection/admin/shared-connections/scope-company/github"',
		);
		expect(body).toContain(
			'action="/connection/admin/shared-connections/scope-company/principals/principal-admin/grant"',
		);
		expect(body).toContain(
			'action="/connection/admin/shared-connections/scope-company/principals/principal-eligible/revoke"',
		);

		const formHeaders = {
			"content-type": "application/x-www-form-urlencoded",
			cookie,
			origin: "https://connection.example",
		};
		const mutations = await Promise.all([
			app.request("/connection/admin/shared-connections", {
				body: new URLSearchParams({ display_name: "New shared scope" }),
				headers: formHeaders,
				method: "POST",
			}),
			app.request(
				"/connection/admin/shared-connections/scope-company/principals/principal-admin/grant",
				{ headers: formHeaders, method: "POST" },
			),
			app.request(
				"/connection/admin/shared-connections/scope-company/principals/principal-eligible/revoke",
				{ headers: formHeaders, method: "POST" },
			),
			app.request(
				"/connection/admin/shared-connections/connections/connection-shared/disconnect",
				{ headers: formHeaders, method: "POST" },
			),
			app.request("/connection/admin/shared-connections/scope-company/rename", {
				body: new URLSearchParams({ display_name: "Release Engineering" }),
				headers: formHeaders,
				method: "POST",
			}),
		]);
		expect(mutations.map((response) => response.status)).toEqual([
			303, 303, 303, 303, 303,
		]);
		const connect = await app.request(
			"/connection/admin/shared-connections/scope-company/github",
			{ headers: { cookie } },
		);
		expect(connect.status).toBe(303);
		expect(connect.headers.get("location")).toBe(
			"https://github.test/login/oauth/authorize",
		);
		expect(calls).toHaveLength(6);
		expect(calls).toEqual(
			expect.arrayContaining([
				{
					action: "create-scope",
					value: {
						actorPrincipalId: "principal-admin",
						displayName: "New shared scope",
					},
				},
				{
					action: "grant",
					value: {
						actorPrincipalId: "principal-admin",
						sharedScopeId: "scope-company",
						targetPrincipalId: "principal-admin",
					},
				},
				{
					action: "revoke",
					value: {
						actorPrincipalId: "principal-admin",
						sharedScopeId: "scope-company",
						targetPrincipalId: "principal-eligible",
					},
				},
				{
					action: "disconnect",
					value: {
						actorPrincipalId: "principal-admin",
						connectionId: "connection-shared",
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
				{
					action: "rename",
					value: {
						actorPrincipalId: "principal-admin",
						displayName: "Release Engineering",
						sharedScopeId: "scope-company",
					},
				},
			]),
		);
		const deniedRename = await app.request(
			"/connection/admin/shared-connections/scope-company/rename",
			{
				body: new URLSearchParams({ display_name: "Unauthorized rename" }),
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					cookie: "connection_session=shared-user-session",
					origin: "https://connection.example",
				},
				method: "POST",
			},
		);
		expect(deniedRename.status).toBe(403);
		expect(calls).toHaveLength(6);
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
