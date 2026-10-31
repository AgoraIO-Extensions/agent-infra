import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readReserveWorker } from "../deploy/ack/session-reserve-inputs.ts";
import { sessionSandboxReserveDigestV1 } from "../packages/platform-core/src/session-sandbox-reserves.ts";

const sourceSha = "a".repeat(40);
const namespace = "agent-infra";
const installationId = "11111111-1111-1111-1111-111111111111";
const secretName = "agent-infra-worker-configuration";
const podStart = "2026-11-01T00:00:00Z";
const reserve = {
	schemaVersion: 1,
	sourceSha,
	enabled: true,
	revision: 2,
	namespace,
	totalBudget: { cpuMillis: 1000, memoryBytes: 1024, storageBytes: 1024 },
	resourceCosts: [
		{
			resourceConfigurationHash: "b".repeat(64),
			resources: { cpuMillis: 1000, memoryBytes: 1024, storageBytes: 1024 },
		},
	],
	maximumReserves: 1,
	maximumConcurrentCreates: 1,
	ttlMs: 1000,
	cooldownMs: 1000,
	failureBackoffMs: 1000,
	profiles: [],
};

async function fixture(t, scenario = "ok") {
	const dir = await mkdtemp(join(tmpdir(), "ack-reserve-readback-"));
	t.after(() => t.mock?.restore?.());
	const stateFile = join(dir, "state.json");
	await writeFile(
		stateFile,
		JSON.stringify({ namespaceReads: 0, secretReads: 0 }),
		{ mode: 0o600 },
	);
	const deploymentEntrypoint = scenario === "deployment-entrypoint";
	const configurationKey = deploymentEntrypoint
		? "configuration.mjs"
		: "custom.mjs";
	const secretData = {
		[configurationKey]: Buffer.from(
			"export const configuration = {};\n",
		).toString("base64"),
		"session-reserves.json": Buffer.from(JSON.stringify(reserve)).toString(
			"base64",
		),
	};
	const hash = await (async () => {
		const { createHash } = await import("node:crypto");
		return createHash("sha256")
			.update(
				JSON.stringify(
					Object.entries(secretData).sort(([a], [b]) => a.localeCompare(b)),
				),
			)
			.digest("hex");
	})();
	const actual = {
		sourceSha,
		configuration: reserve,
		configurationHash: sessionSandboxReserveDigestV1(reserve),
		policy: {
			namespace,
			resourceProfileRef: "small",
			resources: {
				requests: { cpu: "100m", memory: "1Ki" },
				limits: { cpu: "1", memory: "1Ki" },
			},
			storageSize: "1Ki",
		},
		resourceCosts: { cpuMillis: 1000, memoryBytes: 1024, storageBytes: 1024 },
	};
	if (scenario === "missing-source") delete actual.sourceSha;
	const pod = {
		metadata: {
			name: "worker-0",
			uid: "pod-uid",
			namespace,
			annotations: { "agent-infra.agora.io/runtime-inputs-hash": hash },
			ownerReferences: [
				{ kind: "ReplicaSet", uid: "rs-uid", controller: true },
			],
		},
		status: {
			phase: "Running",
			startTime: podStart,
			containerStatuses: [{ name: "platform-worker", ready: true }],
		},
		spec: {
			containers: [
				{
					name: "platform-worker",
					env: [
						{
							name: "PLATFORM_WORKER_DEPLOYMENT_MODULE",
							value: deploymentEntrypoint
								? "file:///app/dist/deployment.mjs"
								: "file:///app/dist/custom.mjs",
						},
					],
					volumeMounts: [
						{
							name: "worker-config",
							mountPath: deploymentEntrypoint
								? "/app/dist/configuration.mjs"
								: "/app/dist/custom.mjs",
							subPath: configurationKey,
							readOnly: true,
						},
						{
							name: "worker-config",
							mountPath: "/var/run/agent-infra/deployment",
							readOnly: true,
						},
					],
				},
			],
			volumes: [{ name: "worker-config", secret: { secretName } }],
		},
	};
	const deployment = {
		metadata: {
			name: "agent-infra-worker",
			uid: "deployment-uid",
			generation: 1,
		},
		status: {
			observedGeneration: 1,
			updatedReplicas: 1,
			availableReplicas: 1,
			readyReplicas: 1,
		},
		spec: {
			template: {
				metadata: {
					annotations: { "agent-infra.agora.io/runtime-inputs-hash": hash },
				},
			},
		},
	};
	const replicaSet = {
		metadata: {
			name: "worker-rs",
			uid: "rs-uid",
			ownerReferences: [
				{ kind: "Deployment", uid: "deployment-uid", controller: true },
			],
		},
		spec: {
			template: {
				metadata: {
					annotations: { "agent-infra.agora.io/runtime-inputs-hash": hash },
				},
			},
		},
	};
	const cluster = {
		metadata: {
			uid: scenario === "cluster-mismatch" ? "cluster-other" : "cluster-uid",
		},
	};
	const namespaceObject = {
		metadata: {
			uid: "namespace-uid",
			labels: { "agent-infra.agora.io/bootstrap-id": installationId },
		},
	};
	const secret = {
		metadata: {
			name: secretName,
			namespace,
			uid: "secret-uid",
			resourceVersion: "7",
			labels: { "agent-infra.agora.io/bootstrap-id": installationId },
		},
		type: "Opaque",
		data: secretData,
	};
	if (scenario === "stale-pod-hash")
		pod.metadata.annotations["agent-infra.agora.io/runtime-inputs-hash"] =
			"c".repeat(64);
	const fixturePath = join(dir, "fixture.json");
	await writeFile(
		fixturePath,
		JSON.stringify({
			scenario,
			stateFile,
			cluster,
			namespaceObject,
			deployment,
			replicaSet,
			pod,
			secret,
			actual,
		}),
		{ mode: 0o600 },
	);
	const kubectl = join(dir, "kubectl");
	await writeFile(
		kubectl,
		`#!/usr/bin/env node
const fs=require('node:fs');
const f=JSON.parse(fs.readFileSync(process.env.FAKE_FIXTURE,'utf8'));
const state=JSON.parse(fs.readFileSync(f.stateFile,'utf8'));
const a=process.argv.slice(2), get=a.indexOf('get'), kind=a[get+1], name=a[get+2];
const out=(v)=>process.stdout.write(JSON.stringify(v));
if (a.includes('exec')) { out(f.actual); process.exit(0); }
if (kind==='namespace') { if(name==='kube-system') out(f.cluster); else { state.namespaceReads++; fs.writeFileSync(f.stateFile,JSON.stringify(state)); out(f.scenario==='namespace-replaced' && state.namespaceReads>1 ? {...f.namespaceObject,metadata:{...f.namespaceObject.metadata,uid:'namespace-replaced'}} : f.namespaceObject); } process.exit(0); }
if (kind==='deployment') { out(f.deployment); process.exit(0); }
if (kind==='replicaset') { out(f.replicaSet); process.exit(0); }
if (kind==='pods') { out({items:[f.pod]}); process.exit(0); }
if (kind==='pod') { out(f.pod); process.exit(0); }
if (kind==='secret') { state.secretReads++; fs.writeFileSync(f.stateFile,JSON.stringify(state)); if(f.scenario==='secret-replaced' && state.secretReads>1) out({...f.secret,metadata:{...f.secret.metadata,uid:'secret-replaced',resourceVersion:'9'}}); else out(f.secret); process.exit(0); }
process.exit(1);
`,
		{ mode: 0o700 },
	);
	await chmod(kubectl, 0o700);
	return { dir, fixturePath, kubectl };
}

async function runReadback(t, scenario = "ok") {
	const f = await fixture(t, scenario);
	const previousPath = process.env.PATH;
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: fake kubectl fixture outside Turbo.
	const previousFixture = process.env.FAKE_FIXTURE;
	process.env.PATH = `${f.dir}:${previousPath}`;
	process.env.FAKE_FIXTURE = f.fixturePath;
	t.after(() => {
		process.env.PATH = previousPath;
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: fake kubectl fixture outside Turbo.
		if (previousFixture === undefined) delete process.env.FAKE_FIXTURE;
		else process.env.FAKE_FIXTURE = previousFixture;
	});
	return readReserveWorker(
		{
			ACK_KUBECONFIG: join(f.dir, "kubeconfig"),
			ACK_NAMESPACE: namespace,
			ACK_SOURCE_SHA: sourceSha,
		},
		{ clusterUid: "cluster-uid", installationId },
		secretName,
	);
}

test("production readback accepts the full Secret hash and dynamic configuration subPath", async (t) => {
	const actual = await runReadback(t);
	assert.equal(actual.configuration?.revision, 2);
	assert.equal(actual.sourceSha, sourceSha);
	assert(actual.storedReserveBytes instanceof Uint8Array);
});

test("production readback accepts the ACK chart deployment entrypoint", async (t) => {
	const actual = await runReadback(t, "deployment-entrypoint");
	assert.equal(actual.configuration?.revision, 2);
	assert.equal(actual.sourceSha, sourceSha);
});

for (const scenario of [
	"cluster-mismatch",
	"namespace-replaced",
	"stale-pod-hash",
	"secret-replaced",
	"missing-source",
]) {
	test(`production readback rejects ${scenario}`, async (t) => {
		await assert.rejects(runReadback(t, scenario));
	});
}
