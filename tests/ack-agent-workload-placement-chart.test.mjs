import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderedWorkloadPlacementV1 } from "../deploy/ack/networkpolicy-enforcement.mjs";

// #4351 MUST-A: the chart is the only source of the Worker's Agent placement.
const render = (...args) =>
	spawnSync(
		"helm",
		[
			"template",
			"ack-placement-test",
			"deploy/ack/chart",
			"--namespace",
			"tenant-workloads",
			"--kube-version",
			"1.36.0",
			...args,
		],
		{ encoding: "utf8" },
	);
const workerEnv = (stdout) =>
	parseAllDocuments(stdout)
		.map((document) => document.toJSON())
		.find(
			(item) =>
				item?.kind === "Deployment" &&
				item.spec.template.metadata.labels["app.kubernetes.io/component"] ===
					"platform-worker",
		)
		.spec.template.spec.containers.find((c) => c.name === "platform-worker")
		.env.filter(
			(entry) => entry.name === "AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT",
		);

test("the chart renders no Agent placement by default", () => {
	const result = render();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(workerEnv(result.stdout), []);
});

test("an enabled value renders the exact Worker env the preflight binds", () => {
	const result = render(
		"--set",
		"agentWorkloadScheduling.enabled=true",
		"--set",
		"agentWorkloadScheduling.architecture=arm64",
		"--set",
		"agentWorkloadScheduling.legacyUnplaced=reject",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(workerEnv(result.stdout), [
		{
			name: "AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT",
			value: '{"architecture":"arm64","legacyUnplaced":"reject"}',
		},
	]);
	assert.deepEqual(
		renderedWorkloadPlacementV1(result.stdout, "tenant-workloads").placement,
		{
			architecture: "arm64",
			legacyUnplaced: "reject",
		},
	);
	// Round 2 MUST-1: Session admission keeps its own default architecture
	// (amd64); the gate reads it and rejects arm64-only evidence for this pair.
	assert.equal(
		renderedWorkloadPlacementV1(result.stdout, "tenant-workloads")
			.sessionArchitecture,
		"amd64",
	);
});

test("the chart schema rejects unsupported placement values", () => {
	for (const value of [
		"agentWorkloadScheduling.architecture=s390x",
		"agentWorkloadScheduling.legacyUnplaced=ignore",
		"agentWorkloadScheduling.runtimeClassName=runv",
	]) {
		const result = render("--set", value);
		assert.notEqual(result.status, 0, value);
	}
});

test("Helm selects ACS for Agent workloads without changing Session placement", () => {
	const result = render(
		"--set",
		"agentWorkloadScheduling.enabled=true",
		"--set",
		"agentWorkloadScheduling.compute=acs",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(workerEnv(result.stdout)[0].value), {
		architecture: "amd64",
		compute: "acs",
		legacyUnplaced: "retain-until-lifecycle",
	});
	assert.deepEqual(
		renderedWorkloadPlacementV1(result.stdout, "tenant-workloads").computes,
		{
			agent: "acs",
			session: "eci",
		},
	);
});

test("each of the four compute pairs survives Helm rendering and enforcement parsing", () => {
	for (const agent of ["eci", "acs"])
		for (const session of ["eci", "acs"]) {
			const result = render(
				"--set",
				"agentWorkloadScheduling.enabled=true",
				"--set",
				`agentWorkloadScheduling.compute=${agent}`,
				"--set",
				"sessionRuntimeScheduling.enabled=true",
				"--set",
				`sessionRuntimeScheduling.compute=${session}`,
			);
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(
				renderedWorkloadPlacementV1(result.stdout, "tenant-workloads").computes,
				{ agent, session },
			);
		}
});
