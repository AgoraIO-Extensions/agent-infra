import assert from "node:assert/strict";
import test from "node:test";

import {
	assertCanonicalSha,
	compareCatalogs,
	parseCatalogSource,
	providerSources,
	readCatalog,
} from "./connection-release-guard.mjs";

test("tracks the Rehoboam provider catalog", () => {
	assert.equal(
		providerSources.rehoboam,
		"packages/openconnector-adapter/src/rehoboam.ts",
	);
});

test("tracks the Manhattan provider catalog", () => {
	assert.equal(
		providerSources.manhattan,
		"packages/openconnector-adapter/src/manhattan.ts",
	);
});

test("parses action and provider release versions", () => {
	assert.deepEqual(
		parseCatalogSource('const id = "bitbucket.get@v6"; const release = "connection-v6";'),
		{
			actions: { "bitbucket.get": 6 },
			actionVersion: 6,
			providerReleaseVersion: 6,
		},
	);
});

test("rejects action and provider release downgrades", () => {
	assert.throws(
		() => compareCatalogs({ bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 6 } }, { bitbucket: { actions: { "bitbucket.get": 5 }, actionVersion: 5, providerReleaseVersion: 5 } }),
		/Action version downgrade/,
	);
});

test("accepts monotonic catalog versions", () => {
	assert.equal(
		compareCatalogs({ jira: { actions: { "jira.get": 8 }, actionVersion: 8, providerReleaseVersion: 8 } }, { jira: { actions: { "jira.get": 9 }, actionVersion: 9, providerReleaseVersion: 9 } }).length,
		1,
	);
});

test("reports a newly added provider from a zero baseline", () => {
	assert.deepEqual(
		compareCatalogs({}, {
			manhattan: {
				actions: { "manhattan.get_current_user": 1 },
				actionVersion: 1,
				providerReleaseVersion: 1,
			},
		}),
		[
			{
				provider: "manhattan",
				before: {
					actions: {},
					actionVersion: 0,
					providerReleaseVersion: null,
				},
				after: {
					actions: { "manhattan.get_current_user": 1 },
					actionVersion: 1,
					providerReleaseVersion: 1,
				},
			},
		],
	);
});

test("fails closed when the baseline ref is invalid", () => {
	assert.throws(
		() => readCatalog("definitely-not-a-valid-ref"),
		/Not a valid object name|unknown revision|bad object/i,
	);
});

test("rejects a DataLego catalog downgrade", () => {
	assert.throws(
		() =>
			compareCatalogs(
				{
					datalego: {
						actions: { "datalego.get_current_user": 3 },
						actionVersion: 3,
						providerReleaseVersion: 3,
					},
				},
				{
					datalego: {
						actions: { "datalego.get_current_user": 2 },
						actionVersion: 2,
						providerReleaseVersion: 2,
					},
				},
			),
		/Action version downgrade: datalego\.get_current_user/,
	);
});

test("requires the deployment SHA to equal canonical connection head", () => {
	assert.equal(assertCanonicalSha("abc", "abc"), "abc");
	assert.throws(() => assertCanonicalSha("stale", "current"), /does not equal/);
});

test("rejects removed providers and provider release downgrades", () => {
	assert.throws(
		() => compareCatalogs({ bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 6 } }, {}),
		/Provider removed/,
	);
	assert.throws(
		() => compareCatalogs({ bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 6 } }, { bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 5 } }),
		/Provider release downgrade/,
	);
	assert.throws(
		() => compareCatalogs({ bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: 6 } }, { bitbucket: { actions: { "bitbucket.get": 6 }, actionVersion: 6, providerReleaseVersion: null } }),
		/Provider release downgrade.*missing/,
	);
});

test("compares every action instead of only the maximum version", () => {
	const baseline = parseCatalogSource(
		'const ids = ["provider.a@v6", "provider.b@v5"]; const release = "connection-v6";',
	);
	const candidate = parseCatalogSource(
		'const ids = ["provider.a@v6", "provider.b@v4"]; const release = "connection-v6";',
	);
	assert.throws(() => compareCatalogs({ provider: baseline }, { provider: candidate }), /provider\.b v5 -> v4/);
});

test("merges explicit and generated actions and rejects ambiguous shared versions", () => {
	const source = `
		const providerId = "provider";
		const actionSpecs = [{ name: "generated" }] as const;
		const explicit = "provider.explicit@v6";
	`;
	assert.deepEqual(parseCatalogSource(source).actions, {
		"provider.explicit": 6,
		"provider.generated": 6,
	});
	assert.throws(
		() => parseCatalogSource(source.replace("@v6", "@v6 @v5")),
		/ambiguous shared action version/,
	);
});
