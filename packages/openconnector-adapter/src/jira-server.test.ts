import assert from "node:assert/strict";
import test from "node:test";
import { setDefaultGuardedFetchDnsLookup } from "@agent-infra/openconnector-kernel";

import {
	JiraServerAdapter,
	JiraServerOAuthTokenProvider,
	jiraServerConnectionCatalog,
} from "./jira-server.ts";

setDefaultGuardedFetchDnsLookup(null);

const credential = JSON.stringify({
	password: "test-jira-password",
	username: "alice@example.com",
});

function createAdapter(accessToken = "test-jira-access-token") {
	return new JiraServerAdapter((input, init) => globalThis.fetch(input, init), {
		getAccessToken: async () => accessToken,
	});
}

const expectedActions = [
	"add_comment",
	"bulk_create_issues",
	"create_issue",
	"delete_issue",
	"edit_comment",
	"get_current_user",
	"get_field_options",
	"get_issue",
	"get_issue_changelog",
	"get_project",
	"get_user",
	"list_issue_attachments",
	"list_issue_comments",
	"list_issue_transitions",
	"list_projects",
	"search_fields",
	"search_issues",
	"search_users",
	"transition_issue",
	"update_issue",
] as const;

test("Jira Server catalog covers OpenConnector overlap and CLI additions", () => {
	assert.deepEqual(
		jiraServerConnectionCatalog.actions
			.map((action) => action.name.replace("jira.", ""))
			.sort(),
		[...expectedActions].sort(),
	);
	assert.equal(jiraServerConnectionCatalog.deploymentProfile.version, "7.11.0");
	assert.equal(jiraServerConnectionCatalog.deploymentProfile.build, "711000");
	for (const action of jiraServerConnectionCatalog.actions) {
		assert.match(action.id, /^jira\.[a-z_]+@v4$/);
		assert.equal("endpoint" in action.inputSchema.properties, false);
		assert.deepEqual(action.requiredScopes, ["jira.server.access"]);
	}
});

test("Jira credential validation uses Basic plus the server accessToken header", async () => {
	const requests: Array<{ headers: Headers; url: string }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({ headers: new Headers(init?.headers), url: String(input) });
		return Response.json({
			active: true,
			displayName: "Alice",
			emailAddress: "alice@example.com",
			key: "alice@example.com",
			name: "alice@example.com",
		});
	};

	try {
		const identity = await createAdapter().validateCredential(credential);
		assert.equal(identity.externalAccount, "alice@example.com");
		assert.equal(identity.displayName, "Alice");
		assert.equal(identity.providerId, "jira");
		assert.equal(
			requests[0]?.url,
			"https://jira.agoralab.co/rest/api/2/myself",
		);
		assert.match(requests[0]?.headers.get("authorization") ?? "", /^Basic /);
		assert.equal(
			requests[0]?.headers.get("accesstoken"),
			"test-jira-access-token",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Jira Server execution encodes issue paths and maps JSON responses", async () => {
	const requests: Array<{ init?: RequestInit; url: string }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({ init, url: String(input) });
		return Response.json({
			fields: { summary: "Issue" },
			id: "10001",
			key: "ASS-1",
		});
	};

	try {
		const adapter = createAdapter();
		const issue = await adapter.execute({
			action: "jira.get_issue",
			credential: { accessToken: credential },
			input: { issueIdOrKey: "ASS/1" },
		});
		assert.deepEqual(issue, {
			issue: { fields: { summary: "Issue" }, id: "10001", key: "ASS-1" },
		});
		assert.equal(
			requests[0]?.url,
			"https://jira.agoralab.co/rest/api/2/issue/ASS%2F1",
		);

		await adapter.execute({
			action: "jira.add_comment",
			credential: { accessToken: credential },
			input: { bodyText: "hello", issueIdOrKey: "ASS-1" },
		});
		assert.equal(requests[1]?.init?.method, "POST");
		assert.equal(requests[1]?.init?.body, JSON.stringify({ body: "hello" }));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Jira Server OAuth token provider caches and refreshes the application token", async () => {
	let now = 1_000_000;
	let tokenRequests = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, init) => {
		tokenRequests += 1;
		assert.equal(init?.method, "POST");
		assert.match(String(init?.body), /grant_type=password/);
		return Response.json({
			access_token: `server-token-${tokenRequests}`,
			expires_in: 120,
		});
	};

	try {
		const provider = new JiraServerOAuthTokenProvider(
			(input, init) => globalThis.fetch(input, init),
			{
				clientId: "client",
				clientSecret: "secret",
				password: "password",
				tokenUrl: "https://oauth.agoralab.co/oauth/token",
				username: "token-user",
			},
			() => now,
		);
		assert.equal(await provider.getAccessToken(), "server-token-1");
		assert.equal(await provider.getAccessToken(), "server-token-1");
		assert.equal(tokenRequests, 1);
		now += 61_000;
		assert.equal(await provider.getAccessToken(), "server-token-2");
		assert.equal(tokenRequests, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Jira credential validation fails closed for inactive or ambiguous identity", async (context) => {
	const originalFetch = globalThis.fetch;
	try {
		await context.test("rejects incomplete credential envelopes", async () => {
			await assert.rejects(
				createAdapter().validateCredential(
					JSON.stringify({ username: "alice" }),
				),
				(error: Error & { providerCredentialInvalid?: boolean }) =>
					error.providerCredentialInvalid === true,
			);
		});
		for (const payload of [
			{ active: false, name: "alice@example.com" },
			{ active: true, name: "bob@example.com" },
		]) {
			await context.test("rejects invalid identity proof", async () => {
				globalThis.fetch = async () => Response.json(payload);
				await assert.rejects(
					createAdapter().validateCredential(credential),
					(error: Error & { providerCredentialInvalid?: boolean }) =>
						error.providerCredentialInvalid === true,
				);
			});
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});
