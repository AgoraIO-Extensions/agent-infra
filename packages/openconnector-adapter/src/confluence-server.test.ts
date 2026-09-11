import assert from "node:assert/strict";
import test from "node:test";
import { setDefaultGuardedFetchDnsLookup } from "@agent-infra/openconnector-kernel";

import {
	ConfluenceServerAdapter,
	confluenceServerConnectionCatalog,
} from "./confluence-server.ts";

setDefaultGuardedFetchDnsLookup(null);

const credential = JSON.stringify({
	password: "test-confluence-password",
	username: "alice@example.com",
});

function createAdapter(accessToken = "test-atlassian-access-token") {
	return new ConfluenceServerAdapter(
		(input, init) => globalThis.fetch(input, init),
		{ getAccessToken: async () => accessToken },
	);
}

const expectedActions = [
	"add_comment",
	"create_page",
	"delete_page",
	"get_current_user",
	"get_page",
	"get_page_by_title",
	"get_page_diff",
	"get_page_history",
	"get_space",
	"list_attachments",
	"list_comments",
	"list_page_children",
	"list_page_tree",
	"list_spaces",
	"move_page",
	"reply_comment",
	"search_content",
	"update_page",
] as const;

test("Confluence Server catalog covers OpenConnector overlap and CLI additions", () => {
	assert.deepEqual(
		confluenceServerConnectionCatalog.actions
			.map((action) => action.name.replace("confluence.", ""))
			.sort(),
		[...expectedActions].sort(),
	);
	assert.equal(
		confluenceServerConnectionCatalog.deploymentProfile.apiOrigin,
		"https://confluence.agoralab.co",
	);
	for (const action of confluenceServerConnectionCatalog.actions) {
		assert.match(action.id, /^confluence\.[a-z_]+@v1$/);
		assert.deepEqual(action.requiredScopes, ["confluence.server.access"]);
	}
});

test("Confluence credential validation uses Basic plus the server accessToken header", async () => {
	const requests: Array<{ headers: Headers; url: string }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({ headers: new Headers(init?.headers), url: String(input) });
		return Response.json({
			active: true,
			displayName: "Alice",
			emailAddress: "alice@example.com",
			key: "alice@example.com",
			username: "alice@example.com",
		});
	};

	try {
		const identity = await createAdapter().validateCredential(credential);
		assert.equal(identity.externalAccount, "alice@example.com");
		assert.equal(identity.displayName, "Alice");
		assert.equal(identity.providerId, "confluence");
		assert.equal(
			requests[0]?.url,
			"https://confluence.agoralab.co/rest/api/user/current",
		);
		assert.match(requests[0]?.headers.get("authorization") ?? "", /^Basic /);
		assert.equal(
			requests[0]?.headers.get("accesstoken"),
			"test-atlassian-access-token",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Confluence Server maps page and comment requests to Server REST API", async () => {
	const requests: Array<{ init?: RequestInit; url: string }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({ init, url: String(input) });
		return Response.json({
			body: { storage: { value: "<p>Page</p>" } },
			id: "123",
			space: { key: "DOC" },
			status: "current",
			title: "Page",
			version: { number: 4 },
		});
	};

	try {
		const adapter = createAdapter();
		const page = await adapter.execute({
			action: "confluence.get_page",
			credential: { accessToken: credential },
			input: { pageId: "123" },
		});
		assert.deepEqual(page, {
			page: {
				body: { storage: { value: "<p>Page</p>" } },
				id: "123",
				space: { key: "DOC" },
				status: "current",
				title: "Page",
				version: { number: 4 },
			},
		});
		assert.equal(
			requests[0]?.url,
			"https://confluence.agoralab.co/rest/api/content/123?expand=space%2Cversion%2Cbody.storage",
		);

		await adapter.execute({
			action: "confluence.add_comment",
			credential: { accessToken: credential },
			input: { bodyText: "hello", pageId: "123" },
		});
		assert.equal(requests[1]?.init?.method, "POST");
		assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
			body: { storage: { representation: "storage", value: "hello" } },
			container: { id: "123", status: "current", type: "page" },
			type: "comment",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Confluence credential validation fails closed for inactive or mismatched identity", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			Response.json({ active: false, username: "alice@example.com" });
		await assert.rejects(
			createAdapter().validateCredential(credential),
			(error: Error & { providerCredentialInvalid?: boolean }) =>
				error.providerCredentialInvalid === true,
		);

		globalThis.fetch = async () =>
			Response.json({ active: true, username: "bob@example.com" });
		await assert.rejects(
			createAdapter().validateCredential(credential),
			(error: Error & { providerCredentialInvalid?: boolean }) =>
				error.providerCredentialInvalid === true,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
