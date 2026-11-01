import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readReserveApi } from "../deploy/ack/session-reserve-inputs.ts";
import { sessionSandboxReserveDigestV1 } from "../packages/platform-core/src/session-sandbox-reserves.ts";

function fixture(scenario = "ok") {
	const sourceSha = "a".repeat(40);
	const namespace = "agent-infra";
	const secretName = "agent-infra-api-configuration";
	const marker = "agent-infra.agora.io/runtime-inputs-hash";
	const reserve = {
		schemaVersion: 1,
		sourceSha,
		enabled: false,
		revision: 3,
		namespace,
		totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
		resourceCosts: [],
		profiles: [],
		maximumReserves: 0,
		maximumConcurrentCreates: 0,
		ttlMs: 1000,
		cooldownMs: 1000,
		failureBackoffMs: 1000,
	};
	const { sourceSha: _source, ...configuration } = reserve;
	const data = {
		"configuration.mjs": "c3ludGhldGlj",
		"session-reserves.json": Buffer.from(JSON.stringify(reserve)).toString(
			"base64",
		),
	};
	const hash = createHash("sha256")
		.update(
			JSON.stringify(
				Object.entries(data).sort(([a], [b]) => a.localeCompare(b)),
			),
		)
		.digest("hex");
	const annotations = { [marker]: hash };
	const deployment = {
		metadata: { uid: "deployment-uid", resourceVersion: "1", generation: 1 },
		spec: { replicas: 2, template: { metadata: { annotations } } },
		status: {
			observedGeneration: 1,
			updatedReplicas: 2,
			readyReplicas: 2,
			availableReplicas: 2,
		},
	};
	const replicaSet = {
		metadata: {
			uid: "rs-uid",
			ownerReferences: [
				{ kind: "Deployment", uid: "deployment-uid", controller: true },
			],
		},
		spec: { template: { metadata: { annotations } } },
	};
	const pods = ["api-a", "api-b"].map((name) => ({
		metadata: {
			name,
			uid: `${name}-uid`,
			namespace,
			annotations,
			ownerReferences: [
				{ kind: "ReplicaSet", name: "api-rs", uid: "rs-uid", controller: true },
			],
		},
		status: {
			phase: "Running",
			startTime: "2026-11-01T00:00:00Z",
			containerStatuses: [{ name: "platform-api", ready: true, restartCount: 0 }],
		},
		spec: {
			containers: [
				{
					name: "platform-api",
					env: [
						{
							name: "PLATFORM_API_CONFIGURATION_MODULE",
							value: "file:///app/deployment/configuration.mjs",
						},
						{
							name: "PLATFORM_API_DEPLOYMENT_MODULE",
							value: "file:///app/dist/deployment.mjs",
						},
					],
					volumeMounts: [
						{ name: "config", mountPath: "/app/deployment", readOnly: true },
					],
				},
			],
			volumes: [{ name: "config", secret: { secretName } }],
		},
	}));
	const secret = {
		metadata: {
			uid: "secret-uid",
			name: secretName,
			namespace,
			resourceVersion: "2",
			labels: { "agent-infra.agora.io/bootstrap-id": "owner" },
		},
		type: "Opaque",
		data,
	};
	const ns = {
		metadata: {
			uid: "namespace-uid",
			labels: { "agent-infra.agora.io/bootstrap-id": "owner" },
		},
	};
	const actual = {
		source: "file",
		sourceSha,
		configuration,
		configurationHash: sessionSandboxReserveDigestV1(reserve),
	};
	const execs = [];
	if (scenario === "replica-missing") pods.pop();
	if (scenario === "unready") pods[1].status.containerStatuses[0].ready = false;
	if (scenario === "foreign-mount")
		pods[1].spec.volumes[0].secret.secretName = "foreign";
	if (scenario === "wrong-path")
		pods[1].spec.containers[0].env.push({
			name: "PLATFORM_API_SESSION_RESERVES_FILE",
			value: "/elsewhere/session-reserves.json",
		});
	if (scenario === "stale-pod-hash")
		pods[1].metadata.annotations = { [marker]: "stale" };
	if (scenario === "foreign-owner")
		pods[1].metadata.ownerReferences[0].uid = "foreign-rs";
	if (scenario === "missing-file") delete secret.data["session-reserves.json"];
	const kube = (args) => {
		assert.deepEqual(args.slice(0, 2), ["-n", namespace]);
		if (args[2] === "exec") {
			execs.push(args[3]);
			const value = structuredClone(actual);
			if (args[3] === "api-b") {
				if (scenario === "stale-source") value.sourceSha = "b".repeat(40);
				if (scenario === "stale-config") value.configuration.revision = 2;
				if (scenario === "stale-hash") value.configurationHash = "b".repeat(64);
				if (scenario === "module-shadow") value.source = "module";
			}
			return JSON.stringify(value);
		}
		const kind = args[3];
		const name = args[4];
		if (kind === "namespace")
			return JSON.stringify(
				name === "kube-system"
					? { metadata: { uid: "cluster-uid" } }
					: scenario === "namespace-drift" && execs.length
						? { metadata: { ...ns.metadata, uid: "replacement" } }
						: ns,
			);
		if (kind === "deployment")
			return JSON.stringify(
				scenario === "deployment-drift" && execs.length
					? {
							...deployment,
							metadata: { ...deployment.metadata, resourceVersion: "changed" },
						}
					: deployment,
			);
		if (kind === "secret")
			return JSON.stringify(
				scenario === "secret-drift" && execs.length
					? {
							...secret,
							metadata: { ...secret.metadata, resourceVersion: "changed" },
						}
					: secret,
			);
		if (kind === "replicaset") return JSON.stringify(replicaSet);
		if (kind === "pods") return JSON.stringify({ items: pods });
		if (kind === "pod") {
			const pod = structuredClone(pods.find((p) => p.metadata.name === name));
			if (scenario === "pod-drift" && execs.length)
				pod.metadata.uid = "replacement";
			if (scenario === "post-exec-owner" && execs.length)
				pod.metadata.ownerReferences[0].uid = "foreign-rs";
			if (scenario === "post-exec-restart" && execs.length)
				pod.status.containerStatuses[0].restartCount = 1;
			if (scenario === "post-exec-ready" && execs.length)
				pod.status.containerStatuses[0].ready = false;
			return JSON.stringify(pod);
		}
		throw new Error("UNEXPECTED_KUBE_READ");
	};
	return {
		environment: { ACK_NAMESPACE: namespace, ACK_SOURCE_SHA: sourceSha },
		bootstrap: { clusterUid: "cluster-uid", installationId: "owner" },
		secretName,
		kube,
		execs,
		reserve,
	};
}

test("reserve readback proves every serving API replica and its Secret adoption", () => {
	const f = fixture();
	const result = readReserveApi(
		f.environment,
		f.bootstrap,
		f.secretName,
		f.kube,
	);
	assert.equal(result.replicas, 2);
	assert.deepEqual(f.execs, ["api-a", "api-b"]);
	assert.equal(
		result.configurationHash,
		sessionSandboxReserveDigestV1(f.reserve),
	);
	assert.equal(result.configuration.revision, 3);
});

for (const scenario of [
	"replica-missing",
	"unready",
	"foreign-mount",
	"wrong-path",
	"stale-pod-hash",
	"foreign-owner",
	"missing-file",
	"stale-source",
	"stale-config",
	"stale-hash",
	"module-shadow",
	"namespace-drift",
	"deployment-drift",
	"secret-drift",
	"pod-drift",
	"post-exec-owner",
	"post-exec-restart",
	"post-exec-ready",
]) {
	test(`API reserve adoption rejects ${scenario}`, () => {
		const f = fixture(scenario);
		assert.throws(
			() => readReserveApi(f.environment, f.bootstrap, f.secretName, f.kube),
			/CAPSULE_RESERVE/,
		);
	});
}
