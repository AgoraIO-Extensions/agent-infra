import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { jiraServerConnectionCatalog } from "../src/jira-server.ts";

const provenance = JSON.parse(
	await readFile(
		new URL("../JIRA_SERVER_PROVENANCE.json", import.meta.url),
		"utf8",
	),
);
const releaseActions = jiraServerConnectionCatalog.actions
	.map((action) => action.name.replace("jira.", ""))
	.sort();
const documentedActions = [
	...provenance.overlap.openConnectorAndServer,
	...provenance.overlap.serverOnlyForThisRelease,
].sort();

assert.equal(
	provenance.source.commit,
	jiraServerConnectionCatalog.sourceCommit,
);
assert.equal(
	provenance.target.apiOrigin,
	jiraServerConnectionCatalog.deploymentProfile.apiOrigin,
);
assert.equal(
	provenance.target.version,
	jiraServerConnectionCatalog.deploymentProfile.version,
);
assert.equal(
	provenance.target.executorDigest,
	jiraServerConnectionCatalog.executorDigest,
);
assert.equal(
	`sha256:${createHash("sha256")
		.update(await readFile(new URL("../src/jira-server.ts", import.meta.url)))
		.digest("hex")}`,
	jiraServerConnectionCatalog.executorDigest,
);
assert.deepEqual(documentedActions, releaseActions);
assert.equal(new Set(documentedActions).size, documentedActions.length);
for (const action of provenance.openConnectorActions) {
	assert.ok(releaseActions.includes(action));
}
for (const action of provenance.atlassianCliReference.actions) {
	assert.ok(
		releaseActions.includes(action) ||
			provenance.overlap.cliOnlyExcluded.includes(action),
	);
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
