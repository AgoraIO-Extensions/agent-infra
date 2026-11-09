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

test("ACK can select a cluster-provided RuntimeClass instead of ECI placement", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set",
		"sessionRuntimeScheduling.runtimeClassName=runv",
	);
	assert.equal(result.status, 0, result.stderr);
	const policy = policies(result).find(
		(x) => x.kind === "MutatingAdmissionPolicy",
	);
	const expression = policy.spec.mutations[0].jsonPatch.expression;
	assert.match(expression, /runtimeClassName/);
	assert.match(expression, /runv/);
	assert.match(expression, /kubernetes\.io~1arch/);
	assert.doesNotMatch(expression, /virtual-kubelet/);
	assert.doesNotMatch(expression, /alibabacloud/);
});

test("ACK rejects ECI image-cache admission when a RuntimeClass is selected", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set",
		"sessionRuntimeScheduling.runtimeClassName=runv",
		"--set",
		"sessionRuntimeScheduling.imageCache.required=true",
	);
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/required image cache needs ECI Session scheduling/,
	);
});

test("ACK rejects the ECI protected profile when a RuntimeClass is selected", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set",
		"sessionRuntimeScheduling.runtimeClassName=runv",
		"--set",
		"sessionRuntimeScheduling.protectedRuntime.enabled=true",
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /protectedRuntime requires ECI placement/);
});

test("ACK rejects malformed RuntimeClass names", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set",
		"sessionRuntimeScheduling.runtimeClassName=RunV",
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /runtimeClassName/);
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

test("ACK keeps the protected Runtime profile disabled by default", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
	);
	assert.equal(result.status, 0, result.stderr);
	const policy = policies(result).find(
		(x) => x.kind === "MutatingAdmissionPolicy",
	);
	assert.doesNotMatch(
		policy.spec.mutations[0].jsonPatch.expression,
		/eci-host-sysctls/,
	);
});

test("ACK scopes the protected Runtime sysctl annotation to Session Pods", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set",
		"sessionRuntimeScheduling.protectedRuntime.enabled=true",
		"--set-string",
		"sessionRuntimeScheduling.protectedRuntime.yamaPtraceScope=2",
	);
	assert.equal(result.status, 0, result.stderr);
	const all = parseAllDocuments(result.stdout).map((document) =>
		document.toJSON(),
	);
	const policy = all.find((x) => x?.kind === "MutatingAdmissionPolicy");
	const worker = all.find(
		(x) =>
			x?.kind === "Deployment" && x.metadata?.name === "agent-infra-worker",
	);
	assert.match(
		policy.spec.mutations[0].jsonPatch.expression,
		/eci-host-sysctls/,
	);
	assert.match(
		policy.spec.mutations[0].jsonPatch.expression,
		/kernel\.yama\.ptrace_scope=2/,
	);
	assert.equal(
		worker.spec.template.metadata?.annotations?.[
			"k8s.aliyun.com/eci-host-sysctls"
		],
		undefined,
	);
});

test("ACK rejects a protected Runtime profile without ECI Session admission", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.protectedRuntime.enabled=true",
	);
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		/protectedRuntime requires sessionRuntimeScheduling\.enabled=true/,
	);
});

test("ACK rejects a protected Runtime sysctl outside the supported Yama values", () => {
	const result = render(
		"1.36.0",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set",
		"sessionRuntimeScheduling.protectedRuntime.enabled=true",
		"--set",
		"sessionRuntimeScheduling.protectedRuntime.yamaPtraceScope=1",
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /yamaPtraceScope/);
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

test("required cache admission covers every container and denies unknown image groups only on Session CREATE", () => {
	const entry = {
		images: [
			`ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@sha256:${"a".repeat(64)}`,
		],
		cacheId: "imc-test123",
	};
	const result = render(
		"1.36.1",
		"--set",
		"sessionRuntimeScheduling.enabled=true",
		"--set",
		"sessionRuntimeScheduling.imageCache.required=true",
		"--set-json",
		`sessionRuntimeScheduling.imageCache.entries=${JSON.stringify([entry])}`,
	);
	assert.equal(result.status, 0, result.stderr);
	const all = parseAllDocuments(result.stdout).map((d) => d.toJSON());
	const validate = all.find((r) => r?.kind === "ValidatingAdmissionPolicy");
	const binding = all.find(
		(r) => r?.kind === "ValidatingAdmissionPolicyBinding",
	);
	assert.deepEqual(binding.spec.validationActions, ["Deny"]);
	assert.equal(
		validate.spec.matchConstraints.namespaceSelector.matchLabels[
			"kubernetes.io/metadata.name"
		],
		"tenant-workloads",
	);
	assert.equal(
		validate.spec.matchConstraints.objectSelector.matchLabels[
			"agent-infra.agora.io/managed"
		],
		"session-sandbox-v1",
	);
	assert.deepEqual(validate.spec.matchConstraints.resourceRules[0].operations, [
		"CREATE",
	]);
	assert.match(validate.spec.variables[0].expression, /initContainers/);
	assert.match(validate.spec.validations[0].expression, /eci-imc-id/);
	assert.match(validate.spec.validations[0].expression, /variables.images.all/);
	assert.equal(
		validate.spec.validations[0].message,
		"ACK_IMAGE_CACHE_NOT_PREPARED",
	);
	assert.notEqual(
		render(
			"1.36.1",
			"--set",
			"sessionRuntimeScheduling.imageCache.required=true",
		).status,
		0,
	);
});
