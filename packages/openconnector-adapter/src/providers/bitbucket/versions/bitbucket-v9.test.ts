import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bitbucketServerConnectionCatalog as previousCatalog } from "./bitbucket-server.ts";
import {
	BitbucketV9Adapter,
	bitbucketV9ConnectionCatalog,
	bitbucketV9LegacyProviderReleaseIds,
} from "./bitbucket-v9.ts";
import { bitbucketV9ExecutorDigest } from "./bitbucket-v9-integrity.ts";

test("v9 pins its delegated executor and preserves Action authorization", () => {
	const hash = createHash("sha256");
	for (const file of ["bitbucket-server.ts", "bitbucket-v9.ts"])
		hash
			.update(file)
			.update("\0")
			.update(readFileSync(new URL(file, import.meta.url)))
			.update("\0");
	assert.equal(bitbucketV9ExecutorDigest, `sha256:${hash.digest("hex")}`);
	assert.ok(
		bitbucketV9LegacyProviderReleaseIds.includes(
			previousCatalog.providerReleaseId,
		),
	);
	assert.equal(
		bitbucketV9ConnectionCatalog.actions.length,
		previousCatalog.actions.length,
	);
	for (const [
		index,
		action,
	] of bitbucketV9ConnectionCatalog.actions.entries()) {
		const old = previousCatalog.actions[index];
		assert.ok(old);
		assert.deepEqual(action, { ...old, id: old.id.replace(/@v8$/, "@v9") });
	}
});

for (const [baseRef, targetRef] of [
	["old", "new"],
	["new", "old"],
	["new", "new"],
]) {
	test(`compare ${baseRef} -> ${targetRef} uses source/destination enumeration and base/target diff`, async () => {
		const paths: string[] = [];
		let pages = 0;
		const adapter = new BitbucketV9Adapter(async (input, init) => {
			const url = new URL(String(input));
			assert.equal(url.origin, "https://bitbucket-api.agoralab.co");
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				"Bearer fixture-pat",
			);
			if (url.pathname.endsWith("/commits"))
				return Response.json({
					values: [{ id: `${url.searchParams.get("until")}-sha` }],
				});
			if (url.pathname.endsWith("/compare/changes")) {
				// An asymmetric fixture is essential: reversed enumeration on linear ancestry is empty.
				if (
					url.searchParams.get("from") !== `${targetRef}-sha` ||
					url.searchParams.get("to") !== `${baseRef}-sha`
				)
					return Response.json({ values: [], isLastPage: true });
				pages++;
				if (baseRef === targetRef)
					return Response.json({ values: [], isLastPage: true });
				if (url.searchParams.get("start") === "0")
					return Response.json({
						values: [{ path: { toString: "src/engine.cpp" }, type: "MODIFY" }],
						isLastPage: false,
						nextPageStart: 100,
					});
				assert.equal(url.searchParams.get("start"), "100");
				return Response.json({
					values: [
						{
							path: { toString: "interface/cpp/rtc_engine/IAgoraRtcEngine.h" },
							type: "MODIFY",
						},
					],
					isLastPage: true,
				});
			}
			assert.ok(url.pathname.includes("/diff/"));
			assert.equal(url.searchParams.get("since"), `${baseRef}-sha`);
			assert.equal(url.searchParams.get("until"), `${targetRef}-sha`);
			paths.push(url.pathname);
			return Response.json({
				fromHash: `${baseRef}-sha`,
				toHash: `${targetRef}-sha`,
				diffs: [
					{
						hunks: [
							{
								segments: [
									{
										type: baseRef === "old" ? "ADDED" : "REMOVED",
										lines: [{ line: "struct AudioTrackIdList {};" }],
									},
								],
							},
						],
					},
				],
			});
		});
		const result = (await adapter.execute({
			action: "bitbucket.compare_refs",
			credential: { accessToken: "fixture-pat" },
			input: {
				project: "SDK",
				repository: "rte_sdk",
				baseRef,
				targetRef,
				pathGlobs: ["**/*.h", "**/*.hpp"],
			},
		})) as {
			files: Array<{ diff: { fromHash: string; toHash: string } }>;
			truncated: boolean;
		};
		assert.equal(result.files.length, baseRef === targetRef ? 0 : 1);
		assert.equal(pages, baseRef === targetRef ? 1 : 2);
		assert.equal(paths.length, result.files.length);
		assert.equal(result.truncated, false);
		if (result.files.length)
			assert.deepEqual(
				[result.files[0]?.diff.fromHash, result.files[0]?.diff.toHash],
				[`${baseRef}-sha`, `${targetRef}-sha`],
			);
	});
}

test("ordinary Actions and identity probes remain delegated without compare rewriting", async () => {
	const adapter = new BitbucketV9Adapter(async (input) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/whoami")) return new Response("alice");
		if (url.pathname.endsWith("/users"))
			return Response.json({
				isLastPage: true,
				values: [{ name: "alice", id: 1, active: true }],
			});
		assert.ok(url.pathname.endsWith("/projects"));
		return Response.json({ values: [{ key: "SDK" }], isLastPage: true });
	});
	const identity = await adapter.validateCredential("fixture-pat");
	assert.equal(
		identity.providerReleaseId,
		bitbucketV9ConnectionCatalog.providerReleaseId,
	);
	const user = (await adapter.execute({
		action: "bitbucket.get_current_user",
		credential: { accessToken: "fixture-pat" },
		input: {},
	})) as Record<string, unknown>;
	assert.equal(user.providerReleaseId, identity.providerReleaseId);
	assert.equal("accessToken" in user, false);
	const projects = await adapter.execute({
		action: "bitbucket.list_projects",
		credential: { accessToken: "fixture-pat" },
		input: {},
	});
	assert.deepEqual(projects, { values: [{ key: "SDK" }], isLastPage: true });
});
