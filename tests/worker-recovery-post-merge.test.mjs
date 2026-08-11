import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("worker recovery post-merge fixture has the expected content", async () => {
	const fixture = await readFile(
		"tests/fixtures/worker-recovery-post-merge.txt",
		"utf8",
	);

	assert.equal(fixture, "worker-recovery-post-merge\n");
});
