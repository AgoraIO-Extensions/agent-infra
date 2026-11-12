import assert from "node:assert/strict";
import test from "node:test";
import { validatePrMaterial } from "../scripts/poc-pr-material-preflight.mjs";

const metadata = {
	id: 15078,
	title: "Enable Apple LLVM coverage on release/4.6",
	fromRef: { latestCommit: "c153145ae2c579a45e6dcdf15056b0da93d81e60" },
	toRef: { latestCommit: "1c797547540a99412d0dc4f9db6b4bee2316965b" },
};
const diff = {
	files: [
		{
			path: "webrtc/build/config/coverage/coverage.gni",
			hunks: [
				{
					source_start: 1,
					destination_start: 1,
					lines: [
						{ type: "CONTEXT", text: "declare_args()" },
						{ type: "ADDED", text: "use_llvm_coverage = false" },
					],
				},
			],
		},
	],
};

test("PR material validator accepts a fixed snapshot shape", () => {
	assert.deepEqual(
		validatePrMaterial({
			metadata,
			diff,
			ci: { overall_state: "FAILED" },
			comments: [],
		}),
		{
			status: "passed",
			code: "PR_MATERIAL_FIXED_SNAPSHOT_SHAPE_READY",
			prId: 15078,
			sourceHead: metadata.fromRef.latestCommit,
			targetHead: metadata.toRef.latestCommit,
			fileCount: 1,
			commentCount: 0,
			ciState: "FAILED",
			freshness: "operator-frozen-not-current-proof",
		},
	);
});

test("PR material validator rejects a stale or malformed head before review", () => {
	assert.equal(
		validatePrMaterial({
			metadata: { ...metadata, fromRef: { latestCommit: "old" } },
			diff,
			ci: { overall_state: "SUCCESS" },
			comments: [],
		}).code,
		"PR_MATERIAL_HEAD_INVALID",
	);
});

test("PR material validator rejects incomplete hunk evidence", () => {
	assert.equal(
		validatePrMaterial({
			metadata,
			diff: { files: [{ path: "x", hunks: [] }] },
			ci: { overall_state: "UNKNOWN" },
			comments: [],
		}).code,
		"PR_MATERIAL_DIFF_HUNKS_MISSING",
	);
});
