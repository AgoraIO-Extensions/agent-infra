import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const chart = new URL("../deploy/ack/chart/", import.meta.url).pathname;

test("ACK API and Worker keep one serving Pod during a rollout", () => {
	const output = execFileSync(
		"helm",
		["template", "ack-rollout-test", chart, "--namespace", "agent-infra"],
		{ encoding: "utf8" },
	);
	const deployments = parseAllDocuments(output)
		.map((document) => document.toJSON())
		.filter(
			(document) =>
				document?.kind === "Deployment" &&
				["agent-infra-api", "agent-infra-worker"].includes(
					document.metadata?.name,
				),
		)
		.map((document) => ({
			name: document.metadata.name,
			replicas: document.spec.replicas,
			strategy: document.spec.strategy,
		}));

	assert.deepEqual(deployments.map(({ name }) => name).sort(), [
		"agent-infra-api",
		"agent-infra-worker",
	]);
	const api = deployments.find(({ name }) => name === "agent-infra-api");
	assert.equal(api?.strategy?.type, "RollingUpdate");
	assert.equal(api?.replicas, 2);
	assert.equal(api?.strategy?.rollingUpdate?.maxUnavailable, 0);
	assert.equal(api?.strategy?.rollingUpdate?.maxSurge, 1);
	const worker = deployments.find(({ name }) => name === "agent-infra-worker");
	assert.equal(worker?.strategy?.type, "Recreate");
	assert.equal(worker?.replicas, 1);
});

test("ACK API replica count can be raised in a private values file", () => {
	const output = execFileSync(
		"helm",
		[
			"template",
			"ack-rollout-test",
			chart,
			"--namespace",
			"agent-infra",
			"--set",
			"replicas.api=3",
		],
		{ encoding: "utf8" },
	);
	const api = parseAllDocuments(output)
		.map((document) => document.toJSON())
		.find(
			(document) =>
				document?.kind === "Deployment" &&
				document?.metadata?.name === "agent-infra-api",
		);
	assert.equal(api?.spec?.replicas, 3);
});
