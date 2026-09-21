import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("frozen vendor fragments preserve input bytes and reject invalid inventories", () => {
	const result = spawnSync(
		"python3",
		["-B", "tests/support/codex_vendor_inputs.py"],
		{ encoding: "utf8", timeout: 60_000 },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
});
