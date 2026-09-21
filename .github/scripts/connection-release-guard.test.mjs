import assert from "node:assert/strict";
import test from "node:test";

import {
	assertCanonicalSha,
	compareCatalogs,
	parseCatalogSource,
} from "./connection-release-guard.mjs";

test("parses action and provider release versions", () => {
	assert.deepEqual(
		parseCatalogSource('const id = "bitbucket.get@v6"; const release = "connection-v6";'),
		{ actionVersion: 6, providerReleaseVersion: 6 },
	);
});

test("rejects action and provider release downgrades", () => {
	assert.throws(
		() => compareCatalogs({ bitbucket: { actionVersion: 6, providerReleaseVersion: 6 } }, { bitbucket: { actionVersion: 5, providerReleaseVersion: 5 } }),
		/Action version downgrade/,
	);
});

test("accepts monotonic catalog versions", () => {
	assert.equal(
		compareCatalogs({ jira: { actionVersion: 8, providerReleaseVersion: 8 } }, { jira: { actionVersion: 9, providerReleaseVersion: 9 } }).length,
		1,
	);
});

test("requires the deployment SHA to equal canonical connection head", () => {
	assert.equal(assertCanonicalSha("abc", "abc"), "abc");
	assert.throws(() => assertCanonicalSha("stale", "current"), /does not equal/);
});

test("rejects removed providers and provider release downgrades", () => {
	assert.throws(
		() => compareCatalogs({ bitbucket: { actionVersion: 6, providerReleaseVersion: 6 } }, {}),
		/Provider removed/,
	);
	assert.throws(
		() => compareCatalogs({ bitbucket: { actionVersion: 6, providerReleaseVersion: 6 } }, { bitbucket: { actionVersion: 6, providerReleaseVersion: 5 } }),
		/Provider release downgrade/,
	);
});
