import assert from "node:assert/strict";
import test from "node:test";
import { setDefaultGuardedFetchDnsLookup } from "@agent-infra/openconnector-kernel";

import {
	BitbucketServerAdapter,
	bitbucketServerConnectionCatalog,
} from "./bitbucket-server.ts";

setDefaultGuardedFetchDnsLookup(null);

function createAdapter() {
	return new BitbucketServerAdapter((input, init) =>
		globalThis.fetch(input, init),
	);
}

const expectedActions = [
	"approve_pull_request",
	"create_pull_request",
	"create_pull_request_comment",
	"create_repository",
	"decline_pull_request",
	"delete_pull_request_comment",
	"get_commit",
	"get_commit_build_status",
	"get_current_user",
	"get_project",
	"get_pull_request",
	"get_pull_request_build_status",
	"get_pull_request_comment",
	"get_pull_request_diff",
	"get_repository",
	"list_branches",
	"list_commits",
	"list_projects",
	"list_pull_request_comments",
	"list_pull_requests",
	"list_repositories",
	"merge_pull_request",
	"reply_pull_request_comment",
	"unapprove_pull_request",
	"update_pull_request_comment",
] as const;

test("Bitbucket Server catalog exposes the reviewed OpenConnector-compatible actions", () => {
	assert.deepEqual(
		bitbucketServerConnectionCatalog.actions
			.map((action) => action.name.replace("bitbucket.", ""))
			.sort(),
		[...expectedActions].sort(),
	);
	for (const action of bitbucketServerConnectionCatalog.actions) {
		assert.match(action.id, /^bitbucket\.[a-z_]+@v3$/);
		assert.equal("endpoint" in action.inputSchema.properties, false);
		assert.deepEqual(action.requiredScopes, ["bitbucket.server.pat"]);
	}
});

test("Bitbucket PAT validation uses fixed Server identity endpoints", async () => {
	const requests: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push(String(input));
		assert.equal(init?.headers && "authorization" in init.headers, true);
		if (String(input).endsWith("/plugins/servlet/applinks/whoami")) {
			return new Response("alice@example.com");
		}
		return Response.json({
			isLastPage: true,
			values: [
				{
					active: true,
					displayName: "Alice",
					emailAddress: "alice@example.com",
					id: 2588,
					name: "alice",
				},
			],
		});
	};

	try {
		const identity = await createAdapter().validateCredential(
			"test-personal-access-token",
		);
		assert.equal(identity.externalAccount, "2588");
		assert.equal(identity.displayName, "Alice");
		assert.equal(identity.providerId, "bitbucket");
		assert.deepEqual(requests, [
			"https://bitbucket-api.agoralab.co/plugins/servlet/applinks/whoami",
			"https://bitbucket-api.agoralab.co/rest/api/1.0/users?filter=alice%40example.com&limit=100&start=0",
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Bitbucket execution encodes path segments and never returns the PAT", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/plugins/servlet/applinks/whoami")) {
			return new Response("alice");
		}
		if (url.includes("/rest/api/1.0/users?")) {
			return Response.json({
				isLastPage: true,
				values: [
					{ active: true, displayName: "Alice", id: 2588, name: "alice" },
				],
			});
		}
		assert.equal(
			url,
			"https://bitbucket-api.agoralab.co/rest/api/1.0/projects/A%20B/repos/repo%2Fname",
		);
		return Response.json({ name: "Repository" });
	};

	try {
		const adapter = createAdapter();
		const profile = await adapter.execute({
			action: "bitbucket.get_current_user",
			credential: { accessToken: "test-personal-access-token" },
			input: {},
		});
		assert.equal("accessToken" in profile, false);
		const repository = await adapter.execute({
			action: "bitbucket.get_repository",
			credential: { accessToken: "test-personal-access-token" },
			input: { project: "A B", repository: "repo/name" },
		});
		assert.deepEqual(repository, { name: "Repository" });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Bitbucket rejects declared oversized responses before reading the body", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response("{}", {
			headers: { "content-length": String(5 * 1024 * 1024 + 1) },
		});
	try {
		await assert.rejects(
			createAdapter().execute({
				action: "bitbucket.list_projects",
				credential: { accessToken: "test-personal-access-token" },
				input: {},
			}),
			/response is too large/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Bitbucket rejects a response body that misses the deadline", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"values":['));
				},
			}),
		);
	try {
		await assert.rejects(
			createAdapter().execute({
				action: "bitbucket.list_projects",
				credential: { accessToken: "test-personal-access-token" },
				input: {},
			}),
			/response timed out/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Bitbucket PAT identity validation fails closed", async (context) => {
	const originalFetch = globalThis.fetch;
	try {
		for (const status of [401, 403]) {
			await context.test(`rejects HTTP ${status}`, async () => {
				globalThis.fetch = async () => new Response("denied", { status });
				await assert.rejects(
					createAdapter().validateCredential("test-pat"),
					(error: Error & { providerCredentialInvalid?: boolean }) =>
						error.providerCredentialInvalid === true,
				);
			});
		}
		for (const values of [
			[],
			[{ active: false, id: 1, name: "alice" }],
			[
				{ active: true, id: 1, name: "alice" },
				{ active: true, id: 2, name: "alice" },
			],
		]) {
			await context.test(
				"rejects missing, disabled, or ambiguous users",
				async () => {
					let request = 0;
					globalThis.fetch = async () => {
						request += 1;
						return request === 1
							? new Response("alice")
							: Response.json({ isLastPage: true, values });
					};
					await assert.rejects(
						createAdapter().validateCredential("test-pat"),
						(error: Error & { providerCredentialInvalid?: boolean }) =>
							error.providerCredentialInvalid === true,
					);
				},
			);
		}
		await context.test("rejects non-JSON identity responses", async () => {
			let request = 0;
			globalThis.fetch = async () => {
				request += 1;
				return request === 1
					? new Response("alice")
					: new Response("<html>not json</html>");
			};
			await assert.rejects(
				createAdapter().validateCredential("test-pat"),
				/invalid JSON response/,
			);
		});
		await context.test(
			"checks later pages before accepting a unique user",
			async () => {
				let request = 0;
				globalThis.fetch = async () => {
					request += 1;
					if (request === 1) return new Response("alice");
					return request === 2
						? Response.json({
								isLastPage: false,
								nextPageStart: 100,
								values: [{ active: true, id: 1, name: "alice" }],
							})
						: Response.json({
								isLastPage: true,
								values: [{ active: true, id: 2, name: "alice" }],
							});
				};
				await assert.rejects(
					createAdapter().validateCredential("test-pat"),
					(error: Error & { providerCredentialInvalid?: boolean }) =>
						error.providerCredentialInvalid === true,
				);
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Bitbucket write actions issue one reviewed Server request each", async () => {
	const requests: Array<{ init?: RequestInit; url: string }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({ init, url: String(input) });
		return init?.method === "DELETE"
			? new Response(null, { status: 204 })
			: Response.json({ ok: true });
	};
	const adapter = createAdapter();
	const credential = { accessToken: "test-personal-access-token" };
	const repository = { project: "PROJ", repository: "repo" };
	try {
		await adapter.execute({
			action: "bitbucket.create_pull_request",
			credential,
			input: {
				...repository,
				destinationBranch: "main",
				sourceBranch: "feature",
				title: "Feature",
			},
		});
		await adapter.execute({
			action: "bitbucket.merge_pull_request",
			credential,
			input: { ...repository, pullRequestId: 7, version: 3 },
		});
		await adapter.execute({
			action: "bitbucket.create_pull_request_comment",
			credential,
			input: { ...repository, content: "review", pullRequestId: 7 },
		});
		await adapter.execute({
			action: "bitbucket.approve_pull_request",
			credential,
			input: { ...repository, pullRequestId: 7 },
		});
		await adapter.execute({
			action: "bitbucket.unapprove_pull_request",
			credential,
			input: { ...repository, pullRequestId: 7 },
		});
		assert.deepEqual(
			requests.map(({ init, url }) => ({ method: init?.method, url })),
			[
				{
					method: "POST",
					url: "https://bitbucket-api.agoralab.co/rest/api/1.0/projects/PROJ/repos/repo/pull-requests",
				},
				{
					method: "POST",
					url: "https://bitbucket-api.agoralab.co/rest/api/1.0/projects/PROJ/repos/repo/pull-requests/7/merge?version=3",
				},
				{
					method: "POST",
					url: "https://bitbucket-api.agoralab.co/rest/api/1.0/projects/PROJ/repos/repo/pull-requests/7/comments",
				},
				{
					method: "POST",
					url: "https://bitbucket-api.agoralab.co/rest/api/1.0/projects/PROJ/repos/repo/pull-requests/7/approve",
				},
				{
					method: "DELETE",
					url: "https://bitbucket-api.agoralab.co/rest/api/1.0/projects/PROJ/repos/repo/pull-requests/7/approve",
				},
			],
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
