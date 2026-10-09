import assert from "node:assert/strict";
import test from "node:test";

import {
	githubConnectionCatalog,
	OpenConnectorGitHubAdapter,
	OpenConnectorGitHubOAuthAdapter,
} from "./index.ts";

test("GitHub OAuth uses published-action scopes and the kernel token flow", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		if (url === "https://github.com/login/oauth/access_token") {
			return Response.json({
				access_token: "github-token",
				expires_in: 28_800,
				refresh_token: "github-refresh-token",
				refresh_token_expires_in: 15_897_600,
				scope: "repo,user:email read:user workflow delete_repo",
				token_type: "bearer",
			});
		}
		if (url === "https://api.github.com/user") {
			return Response.json({ id: 42, login: "octocat", name: "The Octocat" });
		}
		throw new Error(`unexpected request: ${url}`);
	};

	try {
		const adapter = new OpenConnectorGitHubOAuthAdapter({
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		const authorizationUrl = new URL(
			adapter.getAuthorizationUrl({
				codeChallenge: "challenge",
				redirectUri: "https://connection.test/oauth/github/callback",
				state: "state",
			}),
		);
		assert.equal(
			authorizationUrl.searchParams.get("scope"),
			"read:user user:email repo delete_repo workflow",
		);

		const identity = await adapter.exchangeCode({
			code: "code",
			codeVerifier: "verifier",
			redirectUri: "https://connection.test/oauth/github/callback",
		});
		assert.deepEqual(identity, {
			accessToken: "github-token",
			displayName: "The Octocat",
			externalAccount: "42",
			expiresAt: identity.expiresAt,
			grantedScopes: [
				"delete_repo",
				"read:user",
				"repo",
				"user:email",
				"workflow",
			],
			refreshExpiresAt: identity.refreshExpiresAt,
			refreshToken: "github-refresh-token",
		});
		assert.equal(Date.parse(identity.expiresAt ?? "") > Date.now(), true);
		assert.equal(
			Date.parse(identity.refreshExpiresAt ?? "") > Date.now(),
			true,
		);
		assert.equal(requests.length, 2);
		const tokenRequest = requests[0]?.init;
		assert.equal(tokenRequest?.method, "POST");
		assert.match(String(tokenRequest?.body), /code_verifier=verifier/);
		assert.match(authorizationUrl.searchParams.get("scope") ?? "", /workflow/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("GitHub execution resolves a newly cataloged action through the kernel", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		assert.equal(
			String(input),
			"https://api.github.com/repos/acme/widgets/branches",
		);
		return Response.json([{ name: "main" }]);
	};

	try {
		const result = await new OpenConnectorGitHubAdapter().execute({
			action: "github.listBranches",
			credential: { accessToken: "github-token" },
			input: { owner: "acme", repo: "widgets" },
		});
		assert.deepEqual(result, { branches: [{ name: "main" }] });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("GitHub OAuth refresh rotates expiring credentials", async () => {
	const requests: string[] = [];
	const adapter = new OpenConnectorGitHubOAuthAdapter({
		clientId: "client-id",
		clientSecret: "client-secret",
		fetcher: async (input, init) => {
			const url = String(input);
			requests.push(url);
			if (url === "https://github.com/login/oauth/access_token") {
				assert.match(String(init?.body), /grant_type=refresh_token/);
				assert.match(String(init?.body), /refresh_token=old-refresh-token/);
				return Response.json({
					access_token: "new-access-token",
					expires_in: 28_800,
					refresh_token: "new-refresh-token",
					refresh_token_expires_in: 15_897_600,
					scope: "repo workflow",
					token_type: "bearer",
				});
			}
			if (url === "https://api.github.com/user") {
				return Response.json({ id: 42, login: "octocat" });
			}
			throw new Error(`unexpected request: ${url}`);
		},
	});

	const identity = await adapter.refresh("old-refresh-token");
	assert.equal(identity.accessToken, "new-access-token");
	assert.equal(identity.refreshToken, "new-refresh-token");
	assert.deepEqual(identity.grantedScopes, ["repo", "workflow"]);
	assert.deepEqual(requests, [
		"https://github.com/login/oauth/access_token",
		"https://api.github.com/user",
	]);
});

test("GitHub OAuth v9 release reuses only its 143 v9 actions", () => {
	assert.match(githubConnectionCatalog.providerReleaseId, /-connection-v9$/);
	assert.equal(githubConnectionCatalog.actions.length, 143);
	assert.deepEqual(
		githubConnectionCatalog.actions
			.filter(({ name }) =>
				["github.rerequest_check_run", "github.rerequest_check_suite"].includes(
					name,
				),
			)
			.map(({ name }) => name),
		[],
	);
	for (const action of githubConnectionCatalog.actions) {
		assert.match(action.id, /@v9$/);
	}
});
