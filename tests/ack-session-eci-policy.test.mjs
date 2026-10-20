import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

function render(version, ...args) {
	return spawnSync(
		"helm",
		[
			"template",
			"ack-session-test",
			"deploy/ack/chart",
			"--namespace",
			"tenant-workloads",
			"--kube-version",
			version,
			...args,
		],
		{ encoding: "utf8" },
	);
}

const policies = (result) =>
	parseAllDocuments(result.stdout)
		.map((document) => document.toJSON())
		.filter((value) => value?.kind?.startsWith("MutatingAdmissionPolicy"));

test("ACK ECI Session placement is opt-in on existing Kubernetes versions", () => {
	const result = render("1.35.0");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(policies(result), []);
});

test("ACK rejects ECI Session admission on Kubernetes before its GA API", () => {
	const result = render(
		"1.35.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
	);
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/sessionRuntimeScheduling requires Kubernetes 1\.36/,
	);
});

test("ACK scopes both Session admission objects to one namespace and managed Pods", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set",
		"sessionRuntimeScheduling.architecture=arm64",
	);
	assert.equal(result.status, 0, result.stderr);
	const resources = policies(result);
	assert.equal(resources.length, 2);
	const policy = resources.find((x) => x.kind === "MutatingAdmissionPolicy");
	const binding = resources.find(
		(x) => x.kind === "MutatingAdmissionPolicyBinding",
	);
	assert.equal(binding.spec.policyName, policy.metadata.name);
	for (const match of [
		policy.spec.matchConstraints,
		binding.spec.matchResources,
	]) {
		assert.deepEqual(match.namespaceSelector.matchLabels, {
			"kubernetes.io/metadata.name": "tenant-workloads",
		});
		assert.deepEqual(match.objectSelector.matchLabels, {
			"agent-infra.agora.io/managed": "session-sandbox-v1",
		});
	}
	assert.deepEqual(policy.spec.matchConstraints.resourceRules, [
		{
			apiGroups: [""],
			apiVersions: ["v1"],
			operations: ["CREATE"],
			resources: ["pods"],
		},
	]);
	assert.equal(policy.spec.failurePolicy, "Fail");
	assert.match(policy.spec.mutations[0].jsonPatch.expression, /value:"arm64"/);
});

test("ACK rejects an unsupported Session architecture", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set",
		"sessionRuntimeScheduling.architecture=invalid",
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /architecture/);
});

test("ACK can keep the control Worker on ordinary nodes while Sessions use ECI", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set-json",
		"scheduling.worker.nodeSelector=null",
		"--set-json",
		"scheduling.worker.tolerations=[]",
	);
	assert.equal(result.status, 0, result.stderr);
	const worker = parseAllDocuments(result.stdout)
		.map((document) => document.toJSON())
		.find(
			(resource) =>
				resource?.kind === "Deployment" &&
				resource.metadata.name === "agent-infra-worker",
		);
	assert.equal(worker.spec.template.spec.nodeSelector, undefined);
	assert.equal(worker.spec.template.spec.tolerations, undefined);
	assert.equal(policies(result).length, 2);
});
