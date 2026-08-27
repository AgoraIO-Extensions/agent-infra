import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	bitbucketServerConnectionCatalog,
	githubConnectionCatalog,
} from "../src/index.ts";

const provenance = JSON.parse(
	await readFile(
		new URL("../BITBUCKET_SERVER_PROVENANCE.json", import.meta.url),
		"utf8",
	),
);
const releaseActions = bitbucketServerConnectionCatalog.actions
	.map((action) => action.name.replace("bitbucket.", ""))
	.sort();
const documentedActions = [
	...provenance.overlap.openConnectorAndServer,
	...provenance.overlap.serverOnlyForThisRelease,
].sort();

assert.equal(
	provenance.source.commit,
	bitbucketServerConnectionCatalog.sourceCommit,
);
assert.equal(
	provenance.target.apiOrigin,
	bitbucketServerConnectionCatalog.deploymentProfile.apiOrigin,
);
assert.equal(
	provenance.target.version,
	bitbucketServerConnectionCatalog.deploymentProfile.version,
);
assert.equal(
	provenance.target.executorDigest,
	bitbucketServerConnectionCatalog.executorDigest,
);
for (const [sourceFile, expected] of [
	[
		"../src/bitbucket-server.ts",
		bitbucketServerConnectionCatalog.executorDigest,
	],
	["../src/index.ts", githubConnectionCatalog.executorDigest],
]) {
	const source = await readFile(new URL(sourceFile, import.meta.url));
	assert.equal(
		`sha256:${createHash("sha256").update(source).digest("hex")}`,
		expected,
	);
}
assert.deepEqual(documentedActions, releaseActions);
assert.equal(new Set(documentedActions).size, documentedActions.length);
for (const action of provenance.atlassianCliReference.actions) {
	assert.ok(releaseActions.includes(action));
}

const license = await readFile(
	new URL("../../openconnector-kernel/LICENSE.txt", import.meta.url),
	"utf8",
);
const notice = await readFile(
	new URL("../../openconnector-kernel/NOTICE.md", import.meta.url),
	"utf8",
);
assert.match(license, /Apache License/);
assert.match(notice, /OOMOL Connect/);
assert.ok(provenance.modifications.length > 0);
