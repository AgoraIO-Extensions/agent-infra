import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const render = (...args) =>
	spawnSync("helm", ["template", "skill-test", "deploy/ack/chart", ...args], {
		encoding: "utf8",
	});

test("ACK injects the same fixed Skill Agent Version into API and Worker", () => {
	const result = render("--set-string", "agentVersion=skill-hub-v1");
	assert.equal(result.status, 0, result.stderr);
	const resources = parseAllDocuments(result.stdout).map((doc) => doc.toJSON());
	for (const name of ["agent-infra-api", "agent-infra-worker"]) {
		const workload = resources.find(
			(item) => item.kind === "Deployment" && item.metadata.name === name,
		);
		assert.equal(
			workload.spec.template.spec.containers[0].env.find(
				(item) => item.name === "AGENT_INFRA_AGENT_VERSION",
			)?.value,
			"skill-hub-v1",
			name,
		);
	}
});

test("ACK rejects a malformed Skill Agent Version before rollout", () => {
	for (const value of ["../other", "version with spaces", "x".repeat(129)]) {
		const result = render("--set-string", `agentVersion=${value}`);
		assert.notEqual(result.status, 0, value);
		assert.match(result.stderr, /agentVersion/);
	}
});

test("ACK Skill delivery requires a version and separates Worker from Runtime UID", () => {
	assert.notEqual(render("--set", "skillHub.enabled=true").status, 0);
	const result = render(
		"--set",
		"skillHub.enabled=true",
		"--set-string",
		"agentVersion=v1",
	);
	assert.equal(result.status, 0, result.stderr);
	const resources = parseAllDocuments(result.stdout).map((doc) => doc.toJSON());
	const spec = resources.find(
		(x) => x.kind === "Deployment" && x.metadata.name === "agent-infra-worker",
	).spec.template.spec;
	assert.equal(spec.securityContext.runAsUser, 1001);
	assert.deepEqual(spec.initContainers[0].volumeMounts, [
		{ name: "skill-assembly", mountPath: "/skill-assembly" },
	]);
	assert.equal(
		spec.containers[0].env.find(
			(x) => x.name === "PLATFORM_WORKER_SKILL_MATERIALIZATION_REQUIRED",
		).value,
		"true",
	);
	assert(!spec.volumes.some((x) => x.persistentVolumeClaim));
	assert.deepEqual(
		spec.volumes.find((x) => x.name === "skill-assembly").emptyDir,
		{ medium: "Memory", sizeLimit: "128Mi" },
	);
});

test("ACK Skill Hub projects the pinned scanner and namespace-local object store", () => {
	const result = render(
		"--set",
		"skillHub.enabled=true",
		"--set",
		"skillHub.objectStorage.enabled=true",
		"--set-string",
		"agentVersion=v1",
	);
	assert.equal(result.status, 0, result.stderr);
	const resources = parseAllDocuments(result.stdout).map((doc) => doc.toJSON());
	const api = resources.find(
		(x) => x.kind === "Deployment" && x.metadata.name === "agent-infra-api",
	).spec.template.spec;
	assert.equal(api.initContainers[0].name, "skill-scanner-runtime");
	assert.equal(api.initContainers[0].image, api.containers[0].image);
	assert(api.volumes.some((x) => x.name === "skill-scanner"));
	assert.equal(
		resources.find(
			(x) => x.kind === "Service" && x.metadata.name === "agent-infra-minio",
		).spec.ports[0].port,
		9000,
	);
	assert.equal(
		resources.find(
			(x) =>
				x.kind === "PersistentVolumeClaim" &&
				x.metadata.name === "agent-infra-minio",
		).spec.resources.requests.storage,
		"20Gi",
	);
});
