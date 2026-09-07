import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import {
	KubeConfig,
	type V1PersistentVolumeClaim,
	type V1Pod,
} from "@kubernetes/client-node";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createWorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

const execFile = promisify(execFileCallback);
const namespace = workloadTestPolicy.namespace;
async function kubectl(...args: string[]) {
	return (
		await execFile("kubectl", ["--namespace", namespace, ...args], {
			timeout: 30_000,
		})
	).stdout.trim();
}
function apply(object: unknown) {
	const result = spawnSync("kubectl", ["apply", "-f", "-"], {
		input: JSON.stringify(object),
		encoding: "utf8",
		timeout: 30_000,
	});
	if (result.status !== 0)
		throw new Error(`Fixture apply failed: ${result.stderr}`);
}
async function eventually<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
): Promise<T> {
	for (let attempt = 0; attempt < 120; attempt++) {
		const value = await read();
		if (done(value)) return value;
		await setTimeout(1000);
	}
	throw new Error("Kubernetes lifecycle did not converge");
}

describe.skipIf(process.env.WORKLOAD_KIND_TEST !== "1")(
	"kind Workload lifecycle and isolation",
	() => {
		let adapter: ReturnType<typeof createKubernetesRuntimeAdapterV1>;
		let client: ReturnType<typeof createWorkerKubernetesClientV1>;
		let a: AgentWorkloadDesiredV1;
		const workerAccount = "workload-agent-infra-platform-worker";
		async function request(pod: string, url: string): Promise<string> {
			return kubectl(
				"exec",
				pod,
				"--",
				"node",
				"-e",
				"fetch(process.argv[1],{signal:AbortSignal.timeout(2500)}).then(async r=>{if(!r.ok)process.exit(2);console.log(await r.text())}).catch(()=>process.exit(3))",
				url,
			);
		}
		async function connect(pod: string, host: string, port: string) {
			return kubectl(
				"exec",
				pod,
				"--",
				"node",
				"-e",
				"const s=require('net').connect(Number(process.argv[2]),process.argv[1]);s.setTimeout(2500);s.on('connect',()=>{s.destroy();process.exit(0)});s.on('timeout',()=>process.exit(2));s.on('error',()=>process.exit(3))",
				host,
				port,
			);
		}
		beforeAll(async () => {
			if (
				!process.env.KUBECONFIG ||
				!(await kubectl("config", "current-context")).startsWith(
					"kind-workload-",
				)
			)
				throw new Error("An isolated workload kind cluster is required");
			const imageDigest = process.env.WORKLOAD_KIND_IMAGE_A;
			if (!imageDigest) throw new Error("A fixture image digest is required");
			apply({
				apiVersion: "v1",
				kind: "Namespace",
				metadata: { name: namespace },
			});
			const chart = new URL("../../../deploy/helm/agent-infra", import.meta.url)
				.pathname;
			const rendered = await execFile("helm", [
				"template",
				"workload",
				chart,
				"--namespace",
				namespace,
				"--set-string",
				`images.platformWorker.digest=${imageDigest}`,
				"--set",
				"migration.enabled=false",
			]);
			for (const document of parseAllDocuments(rendered.stdout)) {
				const value = document.toJSON();
				if (
					["ServiceAccount", "Role", "RoleBinding"].includes(value?.kind) &&
					value?.metadata?.name === workerAccount
				)
					apply({ ...value, metadata: { ...value.metadata, namespace } });
			}
			const admin = new KubeConfig();
			admin.loadFromFile(process.env.KUBECONFIG);
			const config = new KubeConfig();
			config.loadFromOptions({
				clusters: admin.getClusters(),
				users: [
					{
						name: "worker",
						token: await kubectl("create", "token", workerAccount),
					},
				],
				contexts: [
					{
						name: "worker",
						cluster: admin.getCurrentCluster()?.name ?? "",
						user: "worker",
						namespace,
					},
				],
				currentContext: "worker",
			});
			client = createWorkerKubernetesClientV1(namespace, config);
			const policy = {
				...workloadTestPolicy,
				imageRepository: process.env.WORKLOAD_KIND_REPOSITORY ?? "",
				routeNamespace: namespace,
				resources: {
					requests: { cpu: "25m", memory: "64Mi" },
					limits: { cpu: "500m", memory: "256Mi" },
				},
			};
			const base = workloadDesiredFixture();
			a = validateAgentWorkloadDesiredV1({
				...base,
				imageDigest,
				registryAdmission: {
					...base.registryAdmission,
					immutableDigest: imageDigest,
					policyEvidence: {
						...base.registryAdmission.policyEvidence,
						imageDigest,
					},
				},
				secretRefs: [
					{
						schemaVersion: 1,
						ownerType: "agent-owner",
						ownerId: "owner-a",
						agentId: base.agentId,
						secretId: "fixture",
						secretVersion: 1,
						configRevision: 1,
						algorithmVersion: "aes-256-gcm:v1",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						wrappingKeyVersion: "fixture",
						name: "fixture-secret-v1-r1",
					},
				],
			});
			for (const [name, component] of [
				["worker-probe", "worker"],
				["route-probe", "gateway"],
				["untrusted-probe", "untrusted"],
			]) {
				apply({
					apiVersion: "v1",
					kind: "Pod",
					metadata: { name, namespace, labels: { component } },
					spec: {
						automountServiceAccountToken: false,
						containers: [
							{
								name: "probe",
								image: `${policy.imageRepository}@${imageDigest}`,
								command: ["node", "-e", "setInterval(()=>{},60000)"],
								resources: policy.resources,
							},
						],
					},
				});
			}
			await kubectl(
				"wait",
				"pods",
				"--all",
				"--for=condition=Ready",
				"--timeout=120s",
			);
			adapter = createKubernetesRuntimeAdapterV1({
				client,
				policy,
				probe: async ({ desired, serviceOrigin }) => {
					try {
						await request(
							"worker-probe",
							`${serviceOrigin}${desired.health.path}`,
						);
						return true;
					} catch {
						return false;
					}
				},
			});
		}, 240_000);

		it("proves GA RBAC, candidate routing, NetworkPolicy, immutable Secrets, PVC reuse, rollback and cleanup", async () => {
			expect(
				await kubectl(
					"auth",
					"can-i",
					"create",
					"statefulsets",
					`--as=system:serviceaccount:${namespace}:${workerAccount}`,
				),
			).toBe("yes");
			await expect(
				kubectl(
					"auth",
					"can-i",
					"create",
					"clusterroles",
					`--as=system:serviceaccount:${namespace}:${workerAccount}`,
				),
			).rejects.toThrow();
			await expect(
				kubectl(
					"auth",
					"can-i",
					"get",
					"secrets",
					"--namespace=default",
					`--as=system:serviceaccount:${namespace}:${workerAccount}`,
				),
			).rejects.toThrow();
			await adapter.applyImmutableSecret(
				a,
				a.secretRefs[0]?.name ?? "",
				"FIXTURE_VALUE",
				new TextEncoder().encode("synthetic-workload-proof"),
			);
			const identityA = await eventually(
				() => adapter.apply(a),
				(value) => value !== "pending",
			);
			if (!identityA || identityA === "pending") throw new Error();
			await eventually(
				() => adapter.observe(a, identityA),
				(value) => value === "healthy",
			);
			const url = `http://${a.service.name}:${a.service.port}`;
			await expect(request("route-probe", url)).rejects.toThrow();
			await adapter.promote(a, identityA);
			expect(JSON.parse(await request("route-probe", url))).toMatchObject({
				version: "A",
				marker: "retained",
				secretPresent: true,
			});
			const pvc = await client.read<V1PersistentVolumeClaim>(
				"PersistentVolumeClaim",
				a.persistentVolume.name,
			);
			const pod = (
				await client.list<V1Pod>(
					"Pod",
					`agent-infra.agora.io/agent=${a.service.name}`,
				)
			)[0];
			expect(pod?.spec?.automountServiceAccountToken).toBe(false);
			await expect(
				kubectl(
					"auth",
					"can-i",
					"get",
					"secrets",
					`--as=system:serviceaccount:${namespace}:${a.serviceAccount.name}`,
				),
			).rejects.toThrow();
			await expect(request("untrusted-probe", url)).rejects.toThrow();
			await expect(
				request("untrusted-probe", `http://${pod?.status?.podIP}:8080`),
			).rejects.toThrow();
			const kubeAddress = await kubectl(
				"get",
				"service",
				"kubernetes",
				"--namespace=default",
				"-o=jsonpath={.spec.clusterIP}",
			);
			await connect("worker-probe", kubeAddress, "443");
			await expect(
				connect(pod?.metadata?.name ?? "", kubeAddress, "443"),
			).rejects.toThrow();
			await expect(
				kubectl(
					"exec",
					pod?.metadata?.name ?? "",
					"--",
					"test",
					"-f",
					"/var/run/secrets/kubernetes.io/serviceaccount/token",
				),
			).rejects.toThrow();
			await adapter.closeAgent(a.agentId, 2);
			await eventually(
				() => adapter.scaleDownAgent(a.agentId, 2),
				(value) => value !== "pending",
			);
			expect(
				await client.list(
					"Pod",
					`agent-infra.agora.io/agent=${a.service.name}`,
				),
			).toHaveLength(0);
			const imageB = process.env.WORKLOAD_KIND_IMAGE_B;
			const b = validateAgentWorkloadDesiredV1({
				...a,
				workloadRevision: 3,
				fence: 3,
				imageDigest: imageB,
				registryAdmission: {
					...a.registryAdmission,
					immutableDigest: imageB,
					policyEvidence: {
						...a.registryAdmission.policyEvidence,
						imageDigest: imageB,
					},
				},
			});
			const identityB = await eventually(
				() => adapter.apply(b),
				(value) => value !== "pending",
			);
			if (!identityB || identityB === "pending") throw new Error();
			await eventually(
				() => adapter.observe(b, identityB),
				(value) => value === "healthy",
			);
			await adapter.promote(b, identityB);
			expect(JSON.parse(await request("route-probe", url)).version).toBe("B");
			await expect(adapter.apply(a)).rejects.toThrow();
			const badManifest = {
				...b.runtimeManifest,
				health: { path: "/invalid-health" },
			};
			const c = validateAgentWorkloadDesiredV1({
				...b,
				workloadRevision: 4,
				fence: 4,
				runtimeManifest: badManifest,
				registryAdmission: {
					...b.registryAdmission,
					runtimeManifest: badManifest,
				},
				health: { ...b.health, path: "/invalid-health" },
			});
			await adapter.closeAgent(a.agentId, 4);
			const identityC = await eventually(
				() => adapter.apply(c),
				(value) => value !== "pending",
			);
			if (!identityC || identityC === "pending") throw new Error();
			await expect(adapter.promote(c, identityC)).rejects.toThrow();
			await expect(request("route-probe", url)).rejects.toThrow();
			const rollback = { ...b, workloadRevision: 5, fence: 5 };
			const restored = await eventually(
				() => adapter.apply(rollback),
				(value) => value !== "pending",
			);
			if (!restored || restored === "pending") throw new Error();
			await eventually(
				() => adapter.observe(rollback, restored),
				(value) => value === "healthy",
			);
			await adapter.promote(rollback, restored);
			expect(JSON.parse(await request("route-probe", url))).toMatchObject({
				version: "B",
				marker: "retained",
				secretPresent: true,
			});
			expect(
				(await client.read("PersistentVolumeClaim", a.persistentVolume.name))
					?.metadata?.uid,
			).toBe(pvc?.metadata?.uid);
			expect(
				await client.list(
					"Ingress",
					`agent-infra.agora.io/agent=${a.service.name}`,
				),
			).toHaveLength(1);
			await eventually(() => adapter.cleanupAgent(a.agentId, 6, true), Boolean);
			for (const kind of [
				"Pod",
				"StatefulSet",
				"Service",
				"ServiceAccount",
				"Secret",
				"PersistentVolumeClaim",
				"NetworkPolicy",
				"Ingress",
			] as const)
				expect(
					await client.list(
						kind,
						`agent-infra.agora.io/agent=${a.service.name}`,
					),
				).toHaveLength(0);
		}, 900_000);
	},
);
