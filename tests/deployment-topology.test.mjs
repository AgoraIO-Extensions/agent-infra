import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { parseAllDocuments } from "yaml";

const chart = "deploy/helm/agent-infra";
const kindValues = "deploy/environments/kind.values.yaml";
const validDigest =
	"sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03";
const placeholderDigest =
	"sha256:0000000000000000000000000000000000000000000000000000000000000000";

function render(...args) {
	return spawnSync(
		"helm",
		[
			"template",
			"topology",
			chart,
			"--namespace",
			"agent-infra",
			"--values",
			kindValues,
			...args,
		],
		{ encoding: "utf8" },
	);
}

function objects(output) {
	return parseAllDocuments(output)
		.map((document) => document.toJSON())
		.filter(Boolean);
}

function resource(resources, kind, name) {
	return resources.find(
		(item) => item.kind === kind && item.metadata?.name === name,
	);
}

async function executable(directory, name, body) {
	const path = join(directory, name);
	await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
	await chmod(path, 0o755);
	return path;
}

test("kind values render the reviewable Kubernetes workload-plane topology", () => {
	const result = render();
	assert.equal(result.status, 0, result.stderr);
	const resources = objects(result.stdout);

	assert.equal(
		resource(resources, "Deployment", "topology-agent-infra-platform-worker")
			?.apiVersion,
		"apps/v1",
	);
	assert.equal(
		resource(resources, "Role", "topology-agent-infra-platform-worker")
			?.apiVersion,
		"rbac.authorization.k8s.io/v1",
	);
	assert.equal(
		resource(resources, "StatefulSet", "topology-agent-infra-workload")
			?.apiVersion,
		"apps/v1",
	);
	assert.equal(
		resource(resources, "NetworkPolicy", "topology-agent-infra-workload")
			?.apiVersion,
		"networking.k8s.io/v1",
	);
	assert.equal(
		resource(resources, "Deployment", "topology-agent-infra-route")?.apiVersion,
		"apps/v1",
	);
	assert.equal(
		resource(resources, "Ingress", "topology-agent-infra-workload"),
		undefined,
	);
	assert.ok(resource(resources, "Service", "topology-agent-infra-workload"));
	assert.equal(
		resource(resources, "Deployment", "topology-agent-infra-web"),
		undefined,
	);
	assert.equal(
		resource(resources, "Deployment", "topology-agent-infra-platform-api"),
		undefined,
	);

	const worker = resource(
		resources,
		"Deployment",
		"topology-agent-infra-platform-worker",
	);
	assert.equal(
		worker.spec.template.spec.serviceAccountName,
		"topology-agent-infra-platform-worker",
	);
	assert.equal(worker.spec.template.spec.securityContext.runAsUser, 1000);
	assert.equal(worker.spec.template.spec.securityContext.runAsGroup, 1000);
	assert.match(
		worker.spec.template.spec.containers[0].image,
		/@sha256:[a-f0-9]{64}$/,
	);

	const workload = resource(
		resources,
		"StatefulSet",
		"topology-agent-infra-workload",
	);
	assert.equal(workload.spec.template.spec.automountServiceAccountToken, false);
	assert.equal(
		workload.spec.volumeClaimTemplates[0].spec.accessModes[0],
		"ReadWriteOnce",
	);
	assert.equal(
		workload.spec.template.spec.containers[0].securityContext
			.readOnlyRootFilesystem,
		true,
	);
	assert.match(
		workload.spec.template.spec.containers[0].image,
		/@sha256:[a-f0-9]{64}$/,
	);

	const route = resource(resources, "Deployment", "topology-agent-infra-route");
	assert.equal(route.spec.template.spec.automountServiceAccountToken, false);
	assert.equal(
		route.spec.template.spec.volumes[0].secret.secretName,
		"agent-infra-kind-topology-tls",
	);
});

test("deployment configuration fails closed before rendering unsafe values", () => {
	const invalidConfigurations = [
		["--set-string", "images.platformWorker.digest=latest"],
		[
			"--set-string",
			"images.runtimeHost.repository=https://registry.invalid/runtime-host",
		],
		["--set-string", "images.runtimeHost.repository=node:5000"],
		["--set", "database.majorVersion=15"],
		["--set-string", "database.url=postgresql://inline.invalid/database"],
		["--set-string", "adapters.kubernetesRuntime=remote"],
		["--set-string", "adapters.workloadRoute=load-balancer"],
		["--set", "workloadTopology.service.runtimePort=80"],
		["--set", "workloadTopology.service.routePort=443"],
		[
			"--set-string",
			"workloadTopology.route.ingressNamespace=INVALID_NAMESPACE",
		],
		[
			"--set-string",
			"platformApi.externalBaseUrl=https://user:password@api.invalid",
		],
		[
			"--set-string",
			"keys.workerDecryptionKeyring.secretRef.name=agent-infra-platform-encryption-public-key",
		],
		["--set-string", "keys.encryptionPublicKey.version=missing-from-keyring"],
	];

	for (const args of invalidConfigurations) {
		const result = render(...args);
		assert.notEqual(
			result.status,
			0,
			`unexpectedly accepted ${args.join(" ")}`,
		);
	}

	const equalPorts = render(
		"--set",
		"workloadTopology.service.runtimePort=8080",
	);
	assert.notEqual(equalPorts.status, 0);
	assert.match(
		equalPorts.stderr,
		/workload runtime and route ports must be different/,
	);
});

test("Web and Platform API are rendered only for explicit in-cluster placement", () => {
	const result = render(
		"--set-string",
		`images.web.digest=${validDigest}`,
		"--set-string",
		`images.platformApi.digest=${validDigest}`,
		"--set-string",
		"web.placement=in-cluster",
		"--set-string",
		"platformApi.placement=in-cluster",
	);
	assert.equal(result.status, 0, result.stderr);
	const resources = objects(result.stdout);

	for (const component of ["web", "platform-api"]) {
		const name = `topology-agent-infra-${component}`;
		const deployment = resource(resources, "Deployment", name);
		assert.ok(deployment, `${component} Deployment is missing`);
		assert.ok(
			resource(resources, "Service", name),
			`${component} Service is missing`,
		);
		assert.match(
			deployment.spec.template.spec.containers[0].image,
			/@sha256:[a-f0-9]{64}$/,
		);
		assert.equal(
			deployment.spec.template.spec.serviceAccountName,
			undefined,
			`${component} must not receive the Worker ServiceAccount`,
		);
		assert.equal(
			deployment.spec.template.spec.automountServiceAccountToken,
			false,
		);
	}
	const web = resource(resources, "Deployment", "topology-agent-infra-web");
	assert.equal(web.spec.template.spec.securityContext.runAsUser, 101);
	assert.equal(web.spec.template.spec.securityContext.runAsGroup, 101);
	assert.deepEqual(web.spec.template.spec.volumes, [
		{ name: "tmp", emptyDir: {} },
	]);
	assert.deepEqual(web.spec.template.spec.containers[0].volumeMounts, [
		{ name: "tmp", mountPath: "/tmp" },
	]);
	const api = resource(
		resources,
		"Deployment",
		"topology-agent-infra-platform-api",
	);
	assert.equal(api.spec.template.spec.securityContext.runAsUser, 1000);
	assert.equal(api.spec.template.spec.securityContext.runAsGroup, 1000);
});

test("migration and runtime units preserve database and key separation", () => {
	const result = render(
		"--set-string",
		`images.platformApi.digest=${validDigest}`,
		"--set",
		"migration.enabled=true",
		"--set-string",
		"platformApi.placement=in-cluster",
	);
	assert.equal(result.status, 0, result.stderr);
	const resources = objects(result.stdout);
	const migration = resource(
		resources,
		"Job",
		"topology-agent-infra-platform-migration",
	);
	const api = resource(
		resources,
		"Deployment",
		"topology-agent-infra-platform-api",
	);
	const worker = resource(
		resources,
		"Deployment",
		"topology-agent-infra-platform-worker",
	);

	assert.ok(migration);
	assert.equal(
		migration.metadata.annotations["helm.sh/hook"],
		"pre-install,pre-upgrade",
	);
	assert.equal(
		migration.spec.template.spec.automountServiceAccountToken,
		false,
	);
	assert.equal(migration.spec.template.spec.securityContext.runAsUser, 1000);
	assert.equal(migration.spec.template.spec.securityContext.runAsGroup, 1000);
	assert.equal(
		migration.spec.template.spec.containers[0].image,
		api.spec.template.spec.containers[0].image,
	);
	assert.deepEqual(migration.spec.template.spec.containers[0].command, [
		"node",
		"node_modules/@agent-infra/platform-store/dist/migrate-cli.mjs",
	]);
	assert.deepEqual(
		migration.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef,
		{ name: "agent-infra-platform-database", key: "url" },
	);

	const apiSecrets = api.spec.template.spec.volumes.map(
		(volume) => volume.secret.secretName,
	);
	const workerSecrets = worker.spec.template.spec.volumes.map(
		(volume) => volume.secret.secretName,
	);
	assert.deepEqual(apiSecrets, ["agent-infra-platform-encryption-public-key"]);
	assert.deepEqual(workerSecrets, ["agent-infra-worker-decryption-keyring"]);
	assert.deepEqual(migration.spec.template.spec.volumes ?? [], []);
});

test("kind bootstrap pins its CLI and Kubernetes node image", async () => {
	const cluster = parseAllDocuments(
		await readFile("deploy/kind/cluster.yaml", "utf8"),
	)[0].toJSON();
	assert.equal(cluster.apiVersion, "kind.x-k8s.io/v1alpha4");
	assert.equal(cluster.kind, "Cluster");
	assert.deepEqual(cluster.nodes, [
		{
			role: "control-plane",
			image:
				"kindest/node:v1.33.4@sha256:25a6018e48dfcaee478f4a59af81157a437f15e6e140bf103f85a2e7cd0cbbf2",
		},
	]);

	const result = spawnSync("bash", ["deploy/kind/topology.sh", "render"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /kind v0\.30\.0/);
	assert.match(result.stdout, /kindest\/node:v1\.33\.4@sha256:/);
});

test("Adapter bindings and Worker authority stay namespace scoped", () => {
	const result = render();
	assert.equal(result.status, 0, result.stderr);
	const resources = objects(result.stdout);
	const bindings = resource(
		resources,
		"ConfigMap",
		"topology-agent-infra-adapter-bindings",
	);
	assert.deepEqual(bindings.data, {
		AGENT_INFRA_IDENTITY_ADAPTER_BINDING: "deployment-identity",
		AGENT_INFRA_IMAGE_REGISTRY_ADAPTER_BINDING: "deployment-image-registry",
		AGENT_INFRA_MODEL_CATALOG_ADAPTER_BINDING: "deployment-model-catalog",
		AGENT_INFRA_OBJECT_STORAGE_ADAPTER_BINDING: "deployment-object-storage",
		AGENT_INFRA_KUBERNETES_RUNTIME_ADAPTER_BINDING: "in-cluster",
		AGENT_INFRA_WORKLOAD_ROUTE_ADAPTER_BINDING: "deployment-adapter",
	});

	assert.equal(
		resources.some((item) => item.kind === "ClusterRole"),
		false,
	);
	assert.equal(
		resources.some((item) => item.kind === "ClusterRoleBinding"),
		false,
	);
	const role = resource(
		resources,
		"Role",
		"topology-agent-infra-platform-worker",
	);
	assert.deepEqual(
		role.rules.map((rule) => [rule.apiGroups, rule.resources, rule.verbs]),
		[
			[[""], ["pods"], ["get", "list", "watch"]],
			[
				[""],
				[
					"configmaps",
					"persistentvolumeclaims",
					"secrets",
					"serviceaccounts",
					"services",
				],
				["create", "delete", "get", "list", "patch", "update", "watch"],
			],
			[
				["apps"],
				["statefulsets"],
				["create", "delete", "get", "list", "patch", "update", "watch"],
			],
			[
				["networking.k8s.io"],
				["ingresses", "networkpolicies"],
				["create", "delete", "get", "list", "patch", "update", "watch"],
			],
		],
	);
});

test("rendered Service port names satisfy the Kubernetes IANA limit", () => {
	const result = render();
	assert.equal(result.status, 0, result.stderr);
	for (const service of objects(result.stdout).filter(
		(item) => item.kind === "Service",
	)) {
		for (const port of service.spec.ports) {
			assert.ok(
				port.name.length <= 15,
				`${service.metadata.name}/${port.name} exceeds 15 characters`,
			);
		}
	}
});

test("disabling the controlled route also removes its network access", () => {
	const result = render("--set", "workloadTopology.route.enabled=false");
	assert.equal(result.status, 0, result.stderr);
	const resources = objects(result.stdout);
	const policy = resource(
		resources,
		"NetworkPolicy",
		"topology-agent-infra-workload",
	);
	assert.equal(policy.spec.ingress.length, 1);
	assert.equal(
		resource(resources, "Ingress", "topology-agent-infra-workload"),
		undefined,
	);
	assert.equal(
		resource(resources, "Deployment", "topology-agent-infra-route"),
		undefined,
	);
});

test("the Ingress route Adapter renders a GA TLS route", () => {
	const result = render(
		"--set-string",
		"adapters.workloadRoute=ingress",
		"--set-string",
		"workloadTopology.route.ingressNamespace=custom-ingress",
	);
	assert.equal(result.status, 0, result.stderr);
	const ingress = resource(
		objects(result.stdout),
		"Ingress",
		"topology-agent-infra-workload",
	);
	assert.equal(ingress.apiVersion, "networking.k8s.io/v1");
	assert.ok(ingress.spec.tls[0].secretName);
	assert.equal(
		ingress.spec.rules[0].http.paths[0].backend.service.name,
		"topology-agent-infra-workload",
	);
	const policy = resource(
		objects(result.stdout),
		"NetworkPolicy",
		"topology-agent-infra-workload",
	);
	assert.equal(
		policy.spec.ingress[1].from[0].namespaceSelector.matchLabels[
			"kubernetes.io/metadata.name"
		],
		"custom-ingress",
	);
});

test("OCI repositories allow a registry port only before a repository path", () => {
	const result = render(
		"--set-string",
		"images.runtimeHost.repository=registry.example:5000/team/runtime-host",
	);
	assert.equal(result.status, 0, result.stderr);
	const workload = resource(
		objects(result.stdout),
		"StatefulSet",
		"topology-agent-infra-workload",
	);
	assert.equal(
		workload.spec.template.spec.containers[0].image,
		`registry.example:5000/team/runtime-host@${validDigest}`,
	);
});

test("enabled components reject placeholder image Digests", () => {
	const cases = [
		[
			"platform Worker",
			["--set-string", `images.platformWorker.digest=${placeholderDigest}`],
		],
		[
			"Runtime Host",
			["--set-string", `images.runtimeHost.digest=${placeholderDigest}`],
		],
		["Web", ["--set-string", "web.placement=in-cluster"]],
		["Platform API", ["--set-string", "platformApi.placement=in-cluster"]],
		["Platform API", ["--set", "migration.enabled=true"]],
	];
	for (const [component, args] of cases) {
		const result = render(...args);
		assert.notEqual(result.status, 0, `${component} placeholder was accepted`);
		assert.match(
			result.stderr,
			new RegExp(`${component} image digest must be replaced`, "i"),
		);
	}
});

test("component names stay distinct and valid for the longest Helm release", () => {
	const release = "a".repeat(53);
	const result = spawnSync(
		"helm",
		[
			"template",
			release,
			chart,
			"--namespace",
			"agent-infra",
			"--values",
			kindValues,
			"--set-string",
			"web.placement=in-cluster",
			"--set-string",
			"platformApi.placement=in-cluster",
			"--set-string",
			`images.web.digest=${validDigest}`,
			"--set-string",
			`images.platformApi.digest=${validDigest}`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const resources = objects(result.stdout);
	const names = resources.map((item) => item.metadata.name);
	for (const name of names) assert.ok(name.length <= 63, name);
	for (const suffix of [
		"web",
		"platform-api",
		"platform-worker",
		"workload",
		"route",
	]) {
		assert.ok(
			resources.some((item) => item.metadata.name.endsWith(`-${suffix}`)),
			`component suffix ${suffix} was truncated`,
		);
	}
});

test("kind bootstrap rejects a stale same-named cluster", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "agent-infra-kind-check-"));
	try {
		const kind = await executable(
			fixture,
			"kind",
			'case "$1 $2" in "version ") echo "kind v0.30.0" ;; "get clusters") echo agent-infra-topology ;; "get kubeconfig") echo kubeconfig ;; esac',
		);
		const docker = await executable(
			fixture,
			"docker",
			"echo kindest/node:v1.32.8@sha256:abd489f042d2b644e2d033f5c2d900bc707798d075e8186cb65e3f1367a9d5a1",
		);
		const helm = await executable(fixture, "helm", "exit 0");
		const kubectl = await executable(fixture, "kubectl", "exit 97");
		const result = spawnSync("bash", ["deploy/kind/topology.sh", "up"], {
			encoding: "utf8",
			env: {
				...process.env,
				DOCKER_BIN: docker,
				HELM_BIN: helm,
				KIND_BIN: kind,
				KUBECTL_BIN: kubectl,
			},
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /kind node image does not match cluster.yaml/);
		assert.notEqual(result.status, 97);
	} finally {
		await rm(fixture, { force: true, recursive: true });
	}
});

test("kind verification uses and removes a private kubeconfig", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "agent-infra-kind-private-"));
	const stateRoot = join(fixture, "shared-tmp");
	const record = join(fixture, "record");
	await mkdir(stateRoot, { mode: 0o777 });
	await chmod(stateRoot, 0o777);
	try {
		const kind = await executable(
			fixture,
			"kind",
			'echo "$*" >> "$KIND_RECORD"; case "$1 $2" in "version ") echo "kind v0.30.0" ;; "get clusters") echo agent-infra-topology ;; "get kubeconfig") echo kubeconfig ;; esac',
		);
		const docker = await executable(
			fixture,
			"docker",
			"echo kindest/node:v1.33.4@sha256:25a6018e48dfcaee478f4a59af81157a437f15e6e140bf103f85a2e7cd0cbbf2",
		);
		const kubectl = await executable(
			fixture,
			"kubectl",
			'previous=""; for argument in "$@"; do if [[ "$previous" == "--kubeconfig" ]]; then directory=$(dirname "$argument"); if mode=$(stat -c %a "$directory" 2>/dev/null); then :; else mode=$(stat -f %Lp "$directory"); fi; echo "$argument|$mode" >> "$STATE_RECORD"; fi; previous="$argument"; done; case "$*" in *"port-forward"*) while true; do sleep 1; done ;; *"auth can-i create statefulsets"*) echo yes ;; *"auth can-i get pods"*) echo no ;; *"get deployment/topology-agent-infra-web"*|*"get deployment/topology-agent-infra-platform-api"*) exit 1 ;; esac',
		);
		const curl = await executable(fixture, "curl", "exit 0");
		const result = spawnSync("bash", ["deploy/kind/topology.sh", "verify"], {
			encoding: "utf8",
			env: {
				...process.env,
				CURL_BIN: curl,
				DOCKER_BIN: docker,
				KIND_BIN: kind,
				KIND_RECORD: record,
				KUBECTL_BIN: kubectl,
				STATE_RECORD: record,
				TMPDIR: stateRoot,
			},
		});
		assert.equal(result.status, 0, result.stderr);
		const records = (await readFile(record, "utf8")).trim().split("\n");
		assert.ok(records.some((line) => line.startsWith("get kubeconfig ")));
		const [kubeconfig, mode] = records
			.find((line) => line.includes("|"))
			.split("|");
		assert.equal(mode, "700");
		assert.notEqual(dirname(kubeconfig), stateRoot);
		await assert.rejects(access(dirname(kubeconfig)));
	} finally {
		await rm(fixture, { force: true, recursive: true });
	}
});

test("kind down deletes only an owned topology cluster", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "agent-infra-kind-down-"));
	const record = join(fixture, "record");
	try {
		const kind = await executable(
			fixture,
			"kind",
			'echo "$*" >> "$KIND_RECORD"; case "$1 $2" in "version ") echo "kind v0.30.0" ;; "get clusters") [[ -n "$KIND_LIST_STATUS" ]] && exit "$KIND_LIST_STATUS"; [[ -n "$KIND_CLUSTERS" ]] && echo "$KIND_CLUSTERS"; exit 0 ;; esac',
		);
		const docker = await executable(
			fixture,
			"docker",
			'echo "$KIND_NODE_IMAGE"',
		);
		const run = (clusters, image, listStatus = "") =>
			spawnSync("bash", ["deploy/kind/topology.sh", "down"], {
				encoding: "utf8",
				env: {
					...process.env,
					DOCKER_BIN: docker,
					KIND_BIN: kind,
					KIND_CLUSTERS: clusters,
					KIND_LIST_STATUS: listStatus,
					KIND_NODE_IMAGE: image,
					KIND_RECORD: record,
				},
			});

		let result = run("", "");
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(await readFile(record, "utf8"), /delete cluster/);

		await writeFile(record, "");
		result = run("", "", "17");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /failed to list kind clusters/);
		assert.doesNotMatch(await readFile(record, "utf8"), /delete cluster/);

		await writeFile(record, "");
		result = run(
			"agent-infra-topology",
			"kindest/node:v1.33.4@sha256:25a6018e48dfcaee478f4a59af81157a437f15e6e140bf103f85a2e7cd0cbbf2",
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			await readFile(record, "utf8"),
			/delete cluster --name agent-infra-topology/,
		);

		await writeFile(record, "");
		result = run(
			"agent-infra-topology",
			"kindest/node:v1.32.8@sha256:abd489f042d2b644e2d033f5c2d900bc707798d075e8186cb65e3f1367a9d5a1",
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /kind node image does not match cluster.yaml/);
		assert.doesNotMatch(await readFile(record, "utf8"), /delete cluster/);
	} finally {
		await rm(fixture, { force: true, recursive: true });
	}
});
