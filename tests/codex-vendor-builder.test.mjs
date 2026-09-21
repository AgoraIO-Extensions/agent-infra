import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("vendor builder records actual jobs and seals installer-compatible modes", () => {
	const result = spawnSync(
		"python3",
		["-B", "tests/support/codex_vendor_builder.py"],
		{ encoding: "utf8", timeout: 60_000 },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
});
