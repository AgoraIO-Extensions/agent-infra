import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { confluenceServerConnectionCatalog } from "../src/confluence-server.ts";

const provenance = JSON.parse(
	await readFile(
		new URL("../CONFLUENCE_SERVER_PROVENANCE.json", import.meta.url),
		"utf8",
	),
);
const releaseActions = confluenceServerConnectionCatalog.actions
	.map((action) => action.name.replace("confluence.", ""))
	.sort();
const documentedActions = [
	...provenance.overlap.openConnectorAndServer,
	...provenance.overlap.serverOnlyForThisRelease,
].sort();

assert.equal(
	provenance.source.commit,
	confluenceServerConnectionCatalog.sourceCommit,
);
assert.equal(
	provenance.target.apiOrigin,
	confluenceServerConnectionCatalog.deploymentProfile.apiOrigin,
);
assert.equal(
	provenance.target.version,
	confluenceServerConnectionCatalog.deploymentProfile.version,
);
assert.equal(
	provenance.target.executorDigest,
	confluenceServerConnectionCatalog.executorDigest,
);
assert.equal(
	`sha256:${createHash("sha256")
		.update(
			await readFile(new URL("../src/confluence-server.ts", import.meta.url)),
		)
		.digest("hex")}`,
	confluenceServerConnectionCatalog.executorDigest,
);
assert.deepEqual(documentedActions, releaseActions);
assert.equal(new Set(documentedActions).size, documentedActions.length);
for (const action of provenance.openConnectorActions)
	assert.ok(releaseActions.includes(action));
const cliActionMappings = {
	get_page_children: "list_page_children",
	get_page_tree: "list_page_tree",
	reply_to_comment: "reply_comment",
	search_pages: "search_content",
};
for (const action of provenance.atlassianCliReference.actions) {
	const mapped = cliActionMappings[action] ?? action;
	assert.ok(
		releaseActions.includes(mapped) ||
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
