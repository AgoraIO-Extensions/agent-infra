import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	githubConnectionCatalog,
	OpenConnectorGitHubAdapter,
} from "./github-v10.ts";
import { githubConnectionCatalog as legacyCatalog } from "./index.ts";

for (const status of [400, 401, 403, 404, 405, 409, 422, 429, 500, 502, 503]) {
	test(`GitHub v10 preserves merge HTTP status ${status} without retry`, async () => {
		let requests = 0;
		const adapter = new OpenConnectorGitHubAdapter(async (input, init) => {
			requests++;
			assert.equal(
				String(input),
				"https://api.github.com/repos/acme/widgets/pulls/7/merge",
			);
			assert.equal(init?.method, "PUT");
			return Response.json({ message: "Merge refused" }, { status });
		});
		await assert.rejects(
			adapter.execute({
				action: "github.merge_pull_request",
				credential: { accessToken: "fixture-token" },
				input: {
					owner: "acme",
					repo: "widgets",
					pullNumber: 7,
					mergeMethod: "merge",
				},
			}),
			(error: Error & { providerStatus?: number }) => {
				assert.equal(error.providerStatus, status === 422 ? 400 : status);
				assert.equal(error.message, "Merge refused");
				return true;
			},
		);
		assert.equal(requests, 1);
	});
}

test("GitHub v10 transport errors have no definite HTTP rejection", async () => {
	const adapter = new OpenConnectorGitHubAdapter(async () => {
		throw new TypeError("response lost");
	});
	await assert.rejects(
		adapter.execute({
			action: "github.merge_pull_request",
			credential: { accessToken: "fixture-token" },
			input: { owner: "acme", repo: "widgets", pullNumber: 7 },
		}),
		(error: Error & { providerStatus?: number }) => {
			assert.ok(
				error.providerStatus === undefined || error.providerStatus >= 500,
			);
			return true;
		},
	);
});

test("GitHub v10 source digest and actions are versioned independently", async () => {
	const source = await readFile(new URL("./github-v10.ts", import.meta.url));
	assert.equal(
		githubConnectionCatalog.executorDigest,
		`sha256:${createHash("sha256").update(source).digest("hex")}`,
	);
	assert.match(githubConnectionCatalog.providerReleaseId, /-connection-v10$/);
	for (const action of githubConnectionCatalog.actions)
		assert.match(action.id, /@v10$/);
	assert.deepEqual(
		githubConnectionCatalog.actions.map(({ id, ...action }) => action),
		legacyCatalog.actions.map(({ id, ...action }) => action),
	);
	assert.deepEqual(
		githubConnectionCatalog.authProfile,
		legacyCatalog.authProfile,
	);
	assert.deepEqual(
		githubConnectionCatalog.deploymentProfile,
		legacyCatalog.deploymentProfile,
	);
});
