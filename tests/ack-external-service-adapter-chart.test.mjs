import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

function render(...args) {
	return spawnSync(
		"helm",
		["template", "adapter-test", "deploy/ack/chart", ...args],
		{ encoding: "utf8" },
	);
}

test("ACK Helm deploys the optional Sub2API Adapter from an existing config Secret", () => {
	const result = render(
		"--set",
		"externalServiceAdapter.enabled=true",
		"--set-string",
		"externalServiceAdapter.image=ghcr.io/agoraio-extensions/agent-infra/sub2api-adapter@sha256:" +
			"a".repeat(64),
		"--set-string",
		"externalServiceAdapter.configSecret=relay-adapter-config",
		"--set-string",
		"externalServiceAdapter.publicHost=relay-adapter.example.test",
		"--set-string",
		"externalServiceAdapter.tlsSecret=relay-adapter-tls",
	);
	assert.equal(result.status, 0, result.stderr);
	const resources = parseAllDocuments(result.stdout).map((document) =>
		document.toJSON(),
	);
	const deployment = resources.find(
		(resource) =>
			resource?.kind === "Deployment" &&
			resource.metadata?.name === "agent-infra-external-service-adapter",
	);
	assert.equal(
		deployment?.spec?.template?.spec?.containers?.[0]?.image.includes(
			"sub2api-adapter@sha256",
		),
		true,
	);
	assert.deepEqual(
		deployment?.spec?.template?.spec?.volumes?.find(
			(volume) => volume.name === "adapter-config",
		)?.secret,
		{
			secretName: "relay-adapter-config",
			items: [{ key: "config.json", path: "config.json" }],
		},
	);
	const ingress = resources.find(
		(resource) =>
			resource?.kind === "Ingress" &&
			resource.metadata?.name === "agent-infra-external-service-adapter",
	);
	assert.equal(ingress?.spec?.rules?.[0]?.host, "relay-adapter.example.test");
});

test("ACK Helm keeps the Adapter disabled by default", () => {
	const result = render();
	assert.equal(result.status, 0, result.stderr);
	const resources = parseAllDocuments(result.stdout).map((document) =>
		document.toJSON(),
	);
	assert.equal(
		resources.some(
			(resource) =>
				resource?.metadata?.name === "agent-infra-external-service-adapter",
		),
		false,
	);
});
