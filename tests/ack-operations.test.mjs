import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

function render(...args) {
	return parseAllDocuments(
		execFileSync(
			"helm",
			[
				"template",
				"ops-test",
				"deploy/ack/chart",
				"--namespace",
				"ops-test",
				...args,
			],
			{ encoding: "utf8" },
		),
	)
		.map((document) => document.toJSON())
		.filter(Boolean);
}
test("operations cluster reads require explicit enablement and never grant API credentials", () => {
	const defaults = render();
	assert.equal(
		defaults.some(
			(resource) =>
				resource.kind === "ClusterRole" &&
				resource.metadata.name.includes("operations"),
		),
		false,
	);
	const enabled = render(
		"--set",
		"operations.enabled=true",
		"--set",
		"operations.configurationSecret=ops-config-v1",
		"--set",
		"operations.clusterReads=true",
	);
	const role = enabled.find(
		(resource) =>
			resource.kind === "ClusterRole" &&
			resource.metadata.name.includes("operations"),
	);
	assert.ok(role, "cluster reads should be explicitly rendered");
	assert.deepEqual(
		role.rules.map((rule) => [rule.apiGroups, rule.resources, rule.verbs]),
		[
			[[""], ["nodes"], ["get", "list"]],
			[["metrics.k8s.io"], ["nodes"], ["get", "list"]],
			[["eci.alibabacloud.com"], ["imagecaches"], ["get", "list"]],
		],
	);
	const binding = enabled.find(
		(resource) =>
			resource.kind === "ClusterRoleBinding" &&
			resource.roleRef.name === role.metadata.name,
	);
	assert.deepEqual(binding.subjects, [
		{
			kind: "ServiceAccount",
			name: "agent-infra-worker",
			namespace: "ops-test",
		},
	]);
	for (const name of ["agent-infra-api", "agent-infra-worker"]) {
		const pod = enabled.find(
			(resource) =>
				resource.kind === "Deployment" && resource.metadata.name === name,
		).spec.template.spec;
		assert.equal(
			pod.volumes.find((volume) => volume.name === "operations-configuration")
				.secret.secretName,
			"ops-config-v1",
		);
		assert.equal(
			pod.containers[0].env.find(
				(entry) => entry.name === "AGENT_INFRA_OPERATIONS_CONFIG_FILE",
			).value,
			"/var/run/agent-infra/operations/configuration.json",
		);
		if (name === "agent-infra-api")
			assert.equal(pod.automountServiceAccountToken, false);
	}
});
