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
	type V1StatefulSet,
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
async function waitForReadyPods() {
	try {
		await kubectl(
			"wait",
			"pods",
			"--all",
			"--for=condition=Ready",
			"--timeout=120s",
		);
	} catch (error) {
		const [pods, events] = await Promise.allSettled([
			kubectl("get", "pods", "-o=wide"),
			kubectl("get", "events", "--sort-by=.lastTimestamp"),
		]);
		const output = (result: PromiseSettledResult<string>) =>
			result.status === "fulfilled"
				? result.value
				: result.reason instanceof Error
					? result.reason.message
					: String(result.reason);
		throw new Error(
			`Fixture pods did not become ready: ${error instanceof Error ? error.message : String(error)}\nPods:\n${output(pods)}\nEvents:\n${output(events)}`,
		);
	}
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
		async function routeResponse(url: string) {
			try {
				return JSON.parse(await request("route-probe", url)) as {
					version: string;
					marker: string;
					secretPresent: boolean;
				};
			} catch {
				return null;
			}
		}
		async function waitForRoute(
			url: string,
			version: string,
		): Promise<{ version: string; marker: string; secretPresent: boolean }> {
			const response = await eventually(
				() => routeResponse(url),
				(response) => response?.version === version,
			);
			if (!response) throw new Error("Kubernetes route did not converge");
			return response;
		}
		async function waitForClosedRoute(url: string) {
			await eventually(
				() => routeResponse(url),
				(response) => response === null,
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
			await waitForReadyPods();
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
			const initialIdentityA = await eventually(
				() => adapter.apply(a),
				(value) => value !== "pending",
			);
			if (!initialIdentityA || initialIdentityA === "pending")
				throw new Error();
			await eventually(
				() => adapter.observe(a, initialIdentityA),
				(value) => value === "healthy",
			);
			const url = `http://${a.service.name}:${a.service.port}`;
			await waitForClosedRoute(url);
			const unsafeWorkload = await client.read<V1StatefulSet>(
				"StatefulSet",
				a.service.name,
			);
			const unsafeContainer =
				unsafeWorkload?.spec?.template.spec?.containers[0];
			if (!unsafeWorkload || !unsafeContainer) throw new Error();
			const unsafeIdentity = await client.replace({
				...unsafeWorkload,
				spec: {
					...unsafeWorkload.spec,
					template: {
						...unsafeWorkload.spec?.template,
						spec: {
							...unsafeWorkload.spec?.template.spec,
							containers: [
								{
									...unsafeContainer,
									securityContext: {
										...unsafeContainer.securityContext,
										runAsUser: 0,
									},
								},
							],
						},
					},
				},
			});
			if (!unsafeIdentity.metadata?.uid || !unsafeIdentity.metadata.generation)
				throw new Error();
			await eventually(
				() =>
					client.list<V1Pod>(
						"Pod",
						`agent-infra.agora.io/agent=${a.service.name}`,
					),
				(pods) =>
					pods[0]?.spec?.containers[0]?.securityContext?.runAsUser === 0,
			);
			expect(
				await adapter.observe(a, {
					uid: unsafeIdentity.metadata.uid,
					generation: unsafeIdentity.metadata.generation,
				}),
			).toBe("drifted");
			expect(
				await adapter.switchRoute({
					schemaVersion: 1,
					requestId: `${a.requestId}-unsafe-route`,
					traceId: a.traceId,
					agentId: a.agentId,
					fence: a.fence,
					action: "promote",
					candidateValidated: true,
					candidateRoute: {
						routeRef: a.route.name,
						workloadUid: unsafeIdentity.metadata.uid,
						workloadGeneration: unsafeIdentity.metadata.generation,
						workloadRevision: a.workloadRevision,
					},
				}),
			).toMatchObject({ status: "failed", routedWorkloads: [] });
			await waitForClosedRoute(url);
			const repairedIdentityA = await eventually(
				() => adapter.apply(a),
				(value) => value !== "pending",
			);
			if (!repairedIdentityA || repairedIdentityA === "pending")
				throw new Error();
			await waitForReadyPods();
			await eventually(
				() => adapter.observe(a, repairedIdentityA),
				(value) => value === "healthy",
			);
			await adapter.promote(a, repairedIdentityA);
			expect(await waitForRoute(url, "A")).toMatchObject({
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
			await adapter.closeAgent(a.agentId, 2, 2);
			await eventually(
				() => adapter.scaleDownAgent(a.agentId, 2, 2),
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
			expect((await waitForRoute(url, "B")).version).toBe("B");
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
			await adapter.closeAgent(a.agentId, 4, 4);
			const identityC = await eventually(
				() => adapter.apply(c),
				(value) => value !== "pending",
			);
			if (!identityC || identityC === "pending") throw new Error();
			await expect(adapter.promote(c, identityC)).rejects.toThrow();
			await waitForClosedRoute(url);
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
			expect(await waitForRoute(url, "B")).toMatchObject({
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
			await eventually(
				() => adapter.cleanupAgent(a.agentId, 6, 6, true),
				Boolean,
			);
			for (const kind of [
				"Pod",
				"StatefulSet",
				"Service",
				"ServiceAccount",
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
			expect(
				await client.list(
					"Secret",
					`agent-infra.agora.io/agent=${a.service.name}`,
				),
			).toHaveLength(1);
		}, 900_000);
	},
);
