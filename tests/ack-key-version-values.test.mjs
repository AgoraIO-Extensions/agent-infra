import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

function render(...args) {
	return spawnSync(
		"helm",
		["template", "ack-key-version-test", "deploy/ack/chart", ...args],
		{ encoding: "utf8" },
	);
}

function envValue(resources, name, variable) {
	const workload = resources.find(
		(resource) =>
			resource?.kind === "Deployment" && resource?.metadata?.name === name,
	);
	return workload?.spec?.template?.spec?.containers?.[0]?.env?.find(
		(entry) => entry.name === variable,
	)?.value;
}

test("ACK chart preserves configured API and Worker key versions", () => {
	const result = render(
		"--set-string",
		"encryption.keyVersion=key-v7",
		"--set-string",
		"worker.keyVersions=key-v7\\,key-v6",
	);
	assert.equal(result.status, 0, result.stderr);
	const resources = parseAllDocuments(result.stdout).map((document) =>
		document.toJSON(),
	);
	assert.equal(
		envValue(
			resources,
			"agent-infra-api",
			"AGENT_INFRA_ENCRYPTION_KEY_VERSION",
		),
		"key-v7",
	);
	assert.equal(
		envValue(
			resources,
			"agent-infra-worker",
			"AGENT_INFRA_WORKER_KEY_VERSIONS",
		),
		"key-v7,key-v6",
	);
});

test("ACK chart rejects invalid configured key versions", () => {
	const result = render("--set", "encryption.keyVersion=key/v7");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /encryption\/keyVersion|values\.schema\.json/);
});
