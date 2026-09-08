import { describe, expect, it } from "vitest";

import {
	ConnectionActionCallProjectionV1Schema,
	ConnectionBrowserSessionV1Schema,
	ConnectionCatalogV1Schema,
	ConnectionGrantCreateRequestV1Schema,
	ConnectionLoginRequestV1Schema,
	ConnectionProviderRevokeProjectionV1Schema,
	connectionBrowserOpenApiPathsV1,
	connectionCatalogOpenApiPathsV1,
	GitHubCreatePullRequestInputV1Schema,
	GitHubGetCurrentUserOutputV1Schema,
	GitHubListMyRepositoriesOutputV1Schema,
} from "../../src/pilot/connection.js";

const catalog = {
	schemaVersion: 1,
	catalogVersion: "catalog-2026-09-08",
	providers: [
		{
			providerId: "github",
			providerReleaseId: "github-release-1",
			displayName: "GitHub",
			status: "published",
			actions: [
				{
					actionId: "github.get_current_user",
					actionVersionId: "github.get_current_user@v1",
					effect: "read",
					requiredScopes: ["read:user"],
					status: "published",
					inputSchema: { type: "object", additionalProperties: false },
					outputSchema: { type: "object" },
				},
				{
					actionId: "github.list_my_repositories",
					actionVersionId: "github.list_my_repositories@v1",
					effect: "read",
					requiredScopes: ["repo"],
					status: "published",
					inputSchema: { type: "object", additionalProperties: false },
					outputSchema: { type: "object" },
				},
				{
					actionId: "github.create_pull_request",
					actionVersionId: "github.create_pull_request@v1",
					effect: "write",
					requiredScopes: ["repo"],
					status: "published",
					inputSchema: { type: "object" },
					outputSchema: { type: "object" },
				},
			],
		},
	],
} as const;

describe("Connection Pilot contracts", () => {
	it("publishes only the three immutable GitHub Pilot Actions", () => {
		expect(ConnectionCatalogV1Schema.parse(catalog)).toEqual(catalog);
		expect(
			ConnectionCatalogV1Schema.safeParse({
				...catalog,
				providers: [
					{
						...catalog.providers[0],
						actions: [
							{
								...catalog.providers[0].actions[0],
								actionVersionId: "github.get_current_user@v2",
							},
							...catalog.providers[0].actions.slice(1),
						],
					},
				],
			}).success,
		).toBe(false);
		expect(
			ConnectionCatalogV1Schema.safeParse({
				...catalog,
				connections: [{ connectionId: "must-not-leak" }],
			}).success,
		).toBe(false);
		expect(
			ConnectionCatalogV1Schema.safeParse({
				...catalog,
				providers: [
					{
						...catalog.providers[0],
						actions: [
							...catalog.providers[0].actions,
							{
								actionId: "github.add_issue_labels",
								actionVersionId: "github.add_issue_labels@v1",
								effect: "write",
								requiredScopes: ["repo"],
								status: "published",
								inputSchema: {},
								outputSchema: {},
							},
						],
					},
				],
			}).success,
		).toBe(false);
	});

	it("validates repository-bound Action input and stable numeric identities", () => {
		expect(
			GitHubGetCurrentUserOutputV1Schema.parse({
				accountId: "53285945",
				login: "pilot-alice",
			}),
		).toEqual({ accountId: "53285945", login: "pilot-alice" });
		expect(
			GitHubListMyRepositoriesOutputV1Schema.parse({
				repositories: [
					{
						repositoryId: "1316991471",
						owner: "AgoraIO-Extensions",
						name: "agent-infra-pilot",
						private: true,
					},
				],
			}),
		).toBeTruthy();
		expect(
			GitHubListMyRepositoriesOutputV1Schema.safeParse({
				repositories: [
					{
						repositoryId: "1316991471",
						owner: "AgoraIO-Extensions",
						name: "agent-infra-pilot",
						private: false,
					},
				],
			}).success,
		).toBe(false);
		expect(
			GitHubCreatePullRequestInputV1Schema.safeParse({
				repositoryId: "1316991471",
				head: "pilot/alice",
				base: "main",
				title: "Pilot PR",
				body: "Evidence",
				connectionId: "caller-selected",
			}).success,
		).toBe(false);
	});

	it("keeps credentials write-only and server-resolves the current Principal", () => {
		expect(
			ConnectionLoginRequestV1Schema.parse({
				schemaVersion: 1,
				username: "alice",
				password: "not-a-real-password",
			}),
		).toBeTruthy();
		expect(
			ConnectionBrowserSessionV1Schema.safeParse({
				schemaVersion: 1,
				principal: {
					principalId: "principal-1",
					uid: "alice",
					displayName: "Alice",
				},
				password: "must-not-leak",
			}).success,
		).toBe(false);
		expect(
			ConnectionGrantCreateRequestV1Schema.safeParse({
				schemaVersion: 1,
				consumerId: "agent-platform",
				actorId: "agent-1",
				connectionId: "connection-1",
				actionVersionIds: ["github.get_current_user@v1"],
				principalId: "caller-selected",
			}).success,
		).toBe(false);
	});

	it("cannot confuse a known Provider rejection with an unknown write", () => {
		const base = {
			schemaVersion: 1,
			callId: "call-1",
			actionVersionId: "github.create_pull_request@v1",
			traceId: "trace-1",
			createdAt: "2026-09-08T02:00:00Z",
			updatedAt: "2026-09-08T02:00:01Z",
		};
		expect(
			ConnectionActionCallProjectionV1Schema.parse({
				...base,
				status: "provider_failed",
				error: {
					code: "PROVIDER_FAILED",
					message: "Provider rejected the Action",
					retryable: false,
					providerStatusCode: 403,
					providerRequestId: "github-request-1",
				},
			}),
		).toBeTruthy();
		expect(
			ConnectionActionCallProjectionV1Schema.parse({
				...base,
				status: "result_pending",
				uncertainty: {
					reason: "provider_response_lost",
					reconcileUntil: "2026-09-09T02:00:00Z",
				},
			}),
		).toBeTruthy();
		expect(
			ConnectionActionCallProjectionV1Schema.safeParse({
				...base,
				status: "result_pending",
				error: {
					code: "PROVIDER_FAILED",
					message: "raw GitHub response",
					retryable: false,
					providerStatusCode: 403,
				},
			}).success,
		).toBe(false);
		for (const providerStatusCode of [429, 500]) {
			expect(
				ConnectionActionCallProjectionV1Schema.safeParse({
					...base,
					status: "provider_failed",
					error: {
						code: "PROVIDER_FAILED",
						message: "Provider rejected the Action",
						retryable: false,
						providerStatusCode,
						providerRequestId: null,
					},
				}).success,
			).toBe(false);
		}
	});

	it("publishes separate authenticated Browser and read-only Catalog paths", () => {
		expect(connectionBrowserOpenApiPathsV1).toHaveProperty(
			"/connection/api/v1/session.post.operationId",
			"loginConnectionSession",
		);
		expect(connectionBrowserOpenApiPathsV1).toHaveProperty(
			"/connection/api/v1/session.post.security",
			[{ ConnectionCsrf: [] }],
		);
		expect(connectionBrowserOpenApiPathsV1).toHaveProperty(
			"/connection/api/v1/grants.post.operationId",
			"createConnectionGrant",
		);
		expect(connectionBrowserOpenApiPathsV1).toHaveProperty(
			"/connection/api/v1/action-calls.get.operationId",
			"listConnectionActionCalls",
		);
		expect(connectionBrowserOpenApiPathsV1).toHaveProperty(
			"/connection/api/v1/grants/{grantId}.delete.operationId",
			"revokeConnectionGrant",
		);
		expect(connectionBrowserOpenApiPathsV1).toHaveProperty(
			"/connection/api/v1/connections/{connectionId}.delete.operationId",
			"disconnectConnection",
		);
		expect(connectionBrowserOpenApiPathsV1).toHaveProperty(
			"/connection/api/v1/admin/action-calls/{callId}/resolution.post.operationId",
			"resolveConnectionActionCall",
		);
		expect(connectionCatalogOpenApiPathsV1).toHaveProperty(
			"/connection/internal/v1/catalog.get.operationId",
			"readConnectionCatalog",
		);
		expect(connectionCatalogOpenApiPathsV1).not.toHaveProperty(
			"/connection/internal/v1/catalog.post",
		);
	});

	it("projects Provider revoke state without exposing credential material", () => {
		expect(
			ConnectionProviderRevokeProjectionV1Schema.parse({
				schemaVersion: 1,
				attemptId: "revoke-1",
				connectionId: "connection-1",
				credentialVersionId: "credential-version-1",
				status: "retryable_failure",
				updatedAt: "2026-09-08T02:00:01Z",
			}),
		).toBeTruthy();
		expect(
			ConnectionProviderRevokeProjectionV1Schema.safeParse({
				schemaVersion: 1,
				attemptId: "revoke-1",
				connectionId: "connection-1",
				credentialVersionId: "credential-version-1",
				status: "retryable_failure",
				updatedAt: "2026-09-08T02:00:01Z",
				token: "must-not-leak",
			}).success,
		).toBe(false);
	});
});
