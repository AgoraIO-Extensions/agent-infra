import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const options = [
	"nativeMetadata.enabled=true",
	"platformApi.placement=in-cluster",
	"nativeMetadata.apiConfigurationSecretRef.name=api-metadata",
	"nativeMetadata.workerConfigurationSecretRef.name=worker-metadata",
	"nativeMetadata.apiPeer.namespace=agent-infra",
	"nativeMetadata.apiPeer.podLabels.app=api-instance",
	"nativeMetadata.hostPeer.namespace=agent-infra",
	"nativeMetadata.hostPeer.podLabels.app=host-instance",
];
function render(...overrides) {
	return spawnSync(
		"helm",
		[
			"template",
			"metadata",
			"deploy/helm/agent-infra",
			"--namespace",
			"agent-infra",
			"--values",
			"deploy/local/platform-worker.values.example.yaml",
			...options.flatMap((value) => ["--set", value]),
			...overrides,
		],
		{ encoding: "utf8" },
	);
}

test("metadata deployment mounts role-specific configuration, fixes one instance and limits listener peers", () => {
	const result = render();
	assert.equal(result.status, 0, result.stderr);
	const resources = parseAllDocuments(result.stdout)
		.map((document) => document.toJSON())
		.filter(Boolean);
	const deployment = (role) =>
		resources.find(
			(value) =>
				value.kind === "Deployment" &&
				value.metadata.labels["app.kubernetes.io/component"] === role,
		);
	const worker = deployment("platform-worker");
	const api = deployment("platform-api");
	assert.equal(worker.spec.replicas, 1);
	assert.equal(api.spec.replicas, 1);
	for (const [value, secret, variable] of [
		[
			worker,
			"worker-metadata",
			"PLATFORM_WORKER_NATIVE_METADATA_CONFIGURATION_MODULE",
		],
		[api, "api-metadata", "PLATFORM_API_NATIVE_METADATA_CONFIGURATION_MODULE"],
	]) {
		assert.equal(value.spec.strategy.type, "Recreate");
		const pod = value.spec.template.spec;
		assert.equal(pod.securityContext.runAsUser, 1000);
		assert.equal(pod.securityContext.runAsGroup, 1000);
		assert.equal(pod.securityContext.fsGroup, 1000);
		assert.equal(
			pod.volumes.find((volume) => volume.name === "native-metadata").secret
				.defaultMode,
			0o440,
		);
		assert.equal(
			pod.volumes.find((volume) => volume.name === "native-metadata").secret
				.secretName,
			secret,
		);
		assert.ok(
			pod.containers[0].env.some(
				(env) =>
					env.name === variable &&
					env.value.startsWith("file:///var/run/agent-infra/native-metadata/"),
			),
		);
	}
	assert.ok(
		!api.spec.template.spec.volumes.some(
			(volume) => volume.secret?.secretName === "worker-metadata",
		),
	);
	const service = resources.find(
		(value) =>
			value.kind === "Service" &&
			value.metadata.name === "metadata-agent-infra-metadata-worker",
	);
	assert.deepEqual(service.spec.ports, [
		{ name: "native-metadata", port: 3010, targetPort: 3010, protocol: "TCP" },
	]);
	const policy = resources.find(
		(value) =>
			value.kind === "NetworkPolicy" &&
			value.metadata.name === service.metadata.name,
	);
	assert.deepEqual(policy.spec.policyTypes, ["Ingress"]);
	assert.deepEqual(
		policy.spec.ingress.map((rule) => rule.from[0].podSelector.matchLabels),
		[{ app: "api-instance" }, { app: "host-instance" }],
	);
	assert.ok(
		policy.spec.ingress.every(
			(rule) =>
				rule.ports[0].port === 3010 &&
				rule.from[0].namespaceSelector.matchLabels[
					"kubernetes.io/metadata.name"
				] === "agent-infra",
		),
	);
});

test("metadata deployment rejects ambiguous replicas, broad peers and cross-role Secret reuse", () => {
	for (const overrides of [
		["--set", "platformWorker.replicas=2"],
		["--set", "workloadTopology.enabled=true"],
		["--set", "nativeMetadata.workerConfigurationSecretRef.name=api-metadata"],
		[
			"--set",
			"nativeMetadata.workerConfigurationSecretRef.name=platform-worker-runtime-auth",
		],
		[
			"--set",
			"nativeMetadata.apiConfigurationSecretRef.name=platform-worker-runtime-auth",
		],
		[
			"--set",
			"nativeMetadata.apiConfigurationSecretRef.name=worker-decryption-keyring",
		],
		[
			"--set",
			"nativeMetadata.workerConfigurationSecretRef.name=worker-decryption-keyring",
		],
		[
			"--set",
			"nativeMetadata.apiConfigurationSecretRef.name=platform-worker-configuration",
		],
		[
			"--set",
			"nativeMetadata.workerConfigurationSecretRef.name=platform-worker-configuration",
		],
		["--set", "nativeMetadata.workerPort=80"],
		["--set", "nativeMetadata.apiPeer.ip=0.0.0.0/0"],
		["--set-json", "nativeMetadata.hostPeer.podLabels={}"],
	]) {
		const result = render(...overrides);
		assert.notEqual(result.status, 0, result.stdout);
	}
});
