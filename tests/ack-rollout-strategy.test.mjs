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
			strategy: document.spec.strategy,
		}));

	assert.deepEqual(
		deployments.map(({ name }) => name).sort(),
		["agent-infra-api", "agent-infra-worker"],
	);
	for (const deployment of deployments) {
		assert.equal(deployment.strategy?.type, "RollingUpdate");
		assert.equal(deployment.strategy?.rollingUpdate?.maxUnavailable, 0);
		assert.equal(deployment.strategy?.rollingUpdate?.maxSurge, 1);
	}
});
