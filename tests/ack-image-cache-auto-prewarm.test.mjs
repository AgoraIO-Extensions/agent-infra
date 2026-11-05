import assert from "node:assert/strict";
import test from "node:test";
import {
	selectLatestPlanRun,
	validatePlanArtifact,
	validatePlanWorkflowRun,
} from "../deploy/ack/image-cache-auto-prewarm.ts";

const run = (id, createdAt, overrides = {}) => ({
	databaseId: id,
	headSha: "a".repeat(40),
	attempt: 1,
	status: "completed",
	conclusion: "success",
	event: "workflow_dispatch",
	createdAt,
	...overrides,
});

test("requires the plan workflow run to be successful and trusted", () => {
	const trusted = {
		head_sha: "a".repeat(40),
		status: "completed",
		conclusion: "success",
		path: ".github/workflows/ack-image-cache.yml",
		repository: { full_name: "AgoraIO-Extensions/agent-infra" },
		head_repository: { full_name: "AgoraIO-Extensions/agent-infra" },
		event: "workflow_dispatch",
	};
	assert.doesNotThrow(() => validatePlanWorkflowRun(trusted, "a".repeat(40)));
	for (const change of [
		{ path: ".github/workflows/ci.yml" },
		{ head_repository: { full_name: "fork/agent-infra" } },
		{ conclusion: "failure" },
		{ head_sha: "b".repeat(40) },
	])
		assert.throws(() =>
			validatePlanWorkflowRun({ ...trusted, ...change }, "a".repeat(40)),
		);
});

test("selects only the latest successful plan on the trusted default head", () => {
	const selected = selectLatestPlanRun(
		[
			run(1, "2026-11-05T00:00:00Z"),
			run(2, "2026-11-05T01:00:00Z"),
			run(3, "2026-11-05T02:00:00Z", { conclusion: "failure" }),
			run(4, "2026-11-05T03:00:00Z", { headSha: "b".repeat(40) }),
		],
		"a".repeat(40),
	);
	assert.equal(selected.databaseId, 2);
});

test("rejects stale, expired, empty and oversized plan artifacts", () => {
	assert.doesNotThrow(() =>
		validatePlanArtifact(
			{ id: 1, name: "ack-cache-plan-2", sizeInBytes: 647, expired: false },
			"ack-cache-plan-2",
		),
	);
	for (const artifact of [
		{ id: 1, name: "ack-cache-plan-1", sizeInBytes: 0, expired: false },
		{ id: 1, name: "ack-cache-plan-1", sizeInBytes: 647, expired: true },
		{ id: 1, name: "ack-cache-plan-1", sizeInBytes: 1_000_000, expired: false },
		{ id: 1, name: "ack-cache-plan-2", sizeInBytes: 647, expired: false },
	])
		assert.throws(() => validatePlanArtifact(artifact, "ack-cache-plan-1"));
});
