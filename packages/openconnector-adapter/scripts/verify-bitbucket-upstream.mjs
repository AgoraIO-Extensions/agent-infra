import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const provenance = JSON.parse(
	await readFile(
		new URL("../BITBUCKET_SERVER_PROVENANCE.json", import.meta.url),
		"utf8",
	),
);
const base = `https://raw.githubusercontent.com/oomol-lab/open-connector/${provenance.source.commit}`;
for (const [path, expected] of [
	[provenance.source.referenceFile, provenance.source.referenceFileSha256],
	["LICENSE.txt", provenance.source.licenseSha256],
	["NOTICE.md", provenance.source.noticeSha256],
]) {
	const response = await fetch(`${base}/${path}`, {
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(response.status, 200);
	const digest = createHash("sha256")
		.update(new Uint8Array(await response.arrayBuffer()))
		.digest("hex");
	assert.equal(digest, expected);
}
