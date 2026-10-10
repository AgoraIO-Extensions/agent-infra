import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import {
	runtimeModelInjectionV1,
	validateRuntimeModelProjectionV1,
} from "@agent-infra/model-catalog";
import type { WorkloadReconciliationStateV1 } from "@agent-infra/platform-core";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import {
	KubeConfig,
	type V1PersistentVolumeClaim,
	type V1Pod,
	type V1Secret,
	type V1StatefulSet,
} from "@kubernetes/client-node";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import { seedStandardWorkloadHostV1 } from "../../../tests/fixtures/standard-workload-host-deployment.js";
import { createPlatformApp } from "../../platform-api/src/app.js";
import { assemblePlatformApi } from "../../platform-api/src/assembly.js";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createWorkerKubernetesClientV1 } from "./kubernetes-client.js";
import {
	createKubernetesRuntimeAdapterV1,
	workloadResourceNameV1,
} from "./kubernetes-runtime-adapter.js";
import { createPlatformWorkloadWorkerV1 } from "./workload-worker.js";

const execFile = promisify(execFileCallback);
const namespace = workloadTestPolicy.namespace;
let workloadPolicy: typeof workloadTestPolicy;
function kubeArguments() {
	if (!process.env.KUBECONFIG || !process.env.WORKLOAD_KIND_CONTEXT)
		throw new Error("Explicit isolated kubeconfig/context are required");
	return [
		"--kubeconfig",
		process.env.KUBECONFIG,
		"--context",
		process.env.WORKLOAD_KIND_CONTEXT,
	];
}
async function kubectl(...args: string[]) {
	return (
		await execFile(
			"kubectl",
			[...kubeArguments(), "--namespace", namespace, ...args],
			{
				timeout: 30_000,
			},
		)
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
	const result = spawnSync(
		"kubectl",
		[...kubeArguments(), "apply", "-f", "-"],
		{
			input: JSON.stringify(object),
			encoding: "utf8",
			timeout: 30_000,
		},
	);
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
			// Only extract Worker RBAC; this fixture does not deploy its production module.
			const rendered = await execFile("helm", [
				"template",
				"workload",
				chart,
				"--namespace",
				namespace,
				"--set-string",
				`images.platformWorker.digest=${imageDigest}`,
				"--set-string",
				`images.runtimeHost.digest=${imageDigest}`,
				"--set",
				"migration.enabled=false",
				"--set",
				"workloadTopology.enabled=true",
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
			admin.setCurrentContext(process.env.WORKLOAD_KIND_CONTEXT ?? "");
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
			workloadPolicy = {
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
								image: `${workloadPolicy.imageRepository}@${imageDigest}`,
								command: ["node", "-e", "setInterval(()=>{},60000)"],
								resources: workloadPolicy.resources,
							},
						],
					},
				});
			}
			await waitForReadyPods();
			adapter = createKubernetesRuntimeAdapterV1({
				client,
				policy: workloadPolicy,
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

		it("consumes the durable trusted selector through real PG, production Worker and the default Host", async () => {
			const sourceCommit = process.env.WORKLOAD_SOURCE_COMMIT;
			const imageDigest = process.env.WORKLOAD_KIND_HOST_IMAGE;
			const evidenceDirectory = process.env.WORKLOAD_KIND_EVIDENCE_DIR;
			assert(sourceCommit && imageDigest && evidenceDirectory);
			const database = await startPostgresTestDatabase("selector-host");
			const sql = postgres(database.databaseUrl, { onnotice: () => undefined });
			let worker: ReturnType<typeof createPlatformWorkloadWorkerV1> | undefined;
			try {
				await migratePlatformDatabase(database);
				const seed = await seedStandardWorkloadHostV1(
					database.databaseUrl,
					imageDigest,
				);
				const publicKey = generateKeyPairSync("ed25519")
					.publicKey.export({ type: "spki", format: "pem" })
					.toString();
				const tokenName = "selector-host-service-token";
				apply({
					apiVersion: "v1",
					kind: "Secret",
					metadata: { name: tokenName, namespace },
					immutable: true,
					type: "Opaque",
					stringData: { token: randomBytes(32).toString("base64") },
				});
				const tokenSecret = await client.read<V1Secret>("Secret", tokenName);
				assert(tokenSecret?.data?.token, "Runtime service token is missing");
				const tokenBytes = Buffer.from(tokenSecret.data.token, "base64");
				expect(tokenBytes.byteLength).toBe(44);
				expect(tokenBytes.every((byte) => byte >= 0x20 && byte <= 0x7e)).toBe(
					true,
				);
				let probeCalls = 0;
				const rejectProbe = async () => {
					probeCalls++;
					throw new Error("Runtime probes are outside this configuration case");
				};
				worker = createPlatformWorkloadWorkerV1({
					...seed.workerOptions,
					databaseUrl: database.databaseUrl,
					client,
					workerId: "selector-host-worker",
					pollIntervalMs: 1,
					policy: {
						...workloadTestPolicy,
						imageRepository: process.env.WORKLOAD_KIND_REPOSITORY ?? "",
						routeNamespace: namespace,
						resources: {
							requests: { cpu: "100m", memory: "128Mi" },
							limits: { cpu: "1000m", memory: "512Mi" },
						},
						runtimeAuth: {
							workerId: "selector-host-worker",
							grantKeyId: "selector-host",
							grantIssuer: "selector-host-issuer",
							grantPublicKey: publicKey,
							serviceTokenSecret: { name: tokenName, key: "token" },
						},
					},
					fetch: rejectProbe,
					probeRuntime: rejectProbe,
				});
				let state: WorkloadReconciliationStateV1 | undefined;
				for (let attempt = 0; attempt < 12; attempt++) {
					await worker.tick();
					state = (
						await sql`select state from platform.workload_reconciliations where agent_id = ${seed.agentId}`
					)[0]?.state as WorkloadReconciliationStateV1 | undefined;
					if (state?.phase === "observing") break;
					expect(["preflight", "closing", "applying"]).toContain(state?.phase);
					await setTimeout(25);
				}
				assert(state?.phase === "observing" && state.identity);
				await worker.stop();
				expect(probeCalls).toBe(0);
				expect(state.verified).toBeNull();
				expect(state.candidate.configuration).toEqual(seed.configuration);
				const projection = validateRuntimeModelProjectionV1(
					state.candidate.modelProjection,
					state.candidate.configuration.schemaVersion === 2
						? state.candidate.configuration
						: undefined,
				);
				assert(seed.configuration.source.kind === "standard");
				expect(projection.standardTemplateBinding).toEqual({
					templateId: seed.configuration.source.templateId,
					imageDigest,
					driver: "pi",
					protocol: "anthropic-messages-v1",
				});
				const injection = runtimeModelInjectionV1(projection);
				const deployment = validateAgentWorkloadDesiredV1(
					state.candidate.deployment,
				);
				const name = deployment.service.name;
				const workload = await client.read<V1StatefulSet>("StatefulSet", name);
				assert(workload?.spec?.template.spec?.containers[0]);
				const container = workload.spec.template.spec.containers[0];
				expect(workload.metadata?.uid).toBe(state.identity.uid);
				expect(workload.metadata?.generation).toBe(state.identity.generation);
				expect(container.image).toBe(
					`${process.env.WORKLOAD_KIND_REPOSITORY}@${imageDigest}`,
				);
				expect(container.command).toBeUndefined();
				expect(container.args).toBeUndefined();
				const selector = container.env?.filter(
					(entry) => entry.name === "AGENT_INFRA_RUNTIME_DRIVER",
				);
				expect(selector).toEqual([
					{ name: "AGENT_INFRA_RUNTIME_DRIVER", value: "pi" },
				]);
				const modelSecret = await client.read<V1Secret>(
					"Secret",
					injection.secretName,
				);
				assert(modelSecret?.metadata?.uid && modelSecret.data?.configuration);
				expect(modelSecret.immutable).toBe(true);
				const modelBytes = Buffer.from(
					modelSecret.data.configuration,
					"base64",
				);
				expect(modelBytes.toString()).toBe(injection.configuration);
				const configVersion = JSON.parse(injection.configuration).configVersion;
				await eventually(
					() => client.read<V1Pod>("Pod", `${name}-0`),
					(pod) =>
						pod?.status?.conditions?.some(
							(condition) =>
								condition.type === "Ready" && condition.status === "True",
						) ?? false,
				);
				const pod = await client.read<V1Pod>("Pod", `${name}-0`);
				const pvc = await client.read<V1PersistentVolumeClaim>(
					"PersistentVolumeClaim",
					deployment.persistentVolume.name,
				);
				assert(pod?.metadata?.uid && pvc?.metadata?.uid);
				expect(pvc.status?.phase).toBe("Bound");
				expect(
					pod.metadata.ownerReferences?.some(
						(owner) => owner.uid === workload.metadata?.uid && owner.controller,
					),
				).toBe(true);
				expect(pod.spec?.containers[0]?.command).toBeUndefined();
				expect(pod.spec?.containers[0]?.args).toBeUndefined();
				const imageId = pod.status?.containerStatuses?.find(
					(status) => status.name === "agent",
				)?.imageID;
				expect(imageId?.endsWith(imageDigest)).toBe(true);
				const argv = (
					await kubectl("exec", `${name}-0`, "--", "cat", "/proc/1/cmdline")
				)
					.split("\0")
					.filter(Boolean);
				expect(argv).toEqual([
					"/usr/local/bin/node",
					"--disable-sigusr1",
					"dist/index.mjs",
				]);
				const readyLine = (await kubectl("logs", `${name}-0`))
					.split("\n")
					.find((line) => line.includes('"status":"ready"'));
				assert(readyLine);
				expect(JSON.parse(readyLine)).toMatchObject({
					service: "agent-runtime-host",
					status: "ready",
					configVersion,
				});
				const application = (
					await sql`select approval_revision::text from platform.agent_applications where agent_id = ${seed.agentId}`
				)[0];
				expect(application?.approval_revision).toBe("1");
				const outbox = (
					await sql`select id::text, operation from platform.outbox_items where scope_id = ${seed.agentId}`
				)[0];
				expect(outbox?.operation).toBe("agent.workload.reconcile.v1");
				assert(application && outbox);
				await writeFile(
					join(evidenceDirectory, "configuration-chain.json"),
					`${JSON.stringify(
						{
							schemaVersion: 1,
							sourceCommit,
							imageDigest,
							imageId,
							configVersion,
							kubeconfigExplicit: true,
							kubeContext: process.env.WORKLOAD_KIND_CONTEXT,
							namespace,
							agentId: seed.agentId,
							approvedRevision: application.approval_revision,
							outboxId: outbox.id,
							workerPhase: state.phase,
							verified: false,
							tuple: projection.standardTemplateBinding,
							fingerprint: projection.fingerprint,
							statefulSetUid: workload.metadata?.uid,
							podUid: pod.metadata.uid,
							pvcUid: pvc.metadata.uid,
							modelSecretUid: modelSecret.metadata.uid,
							modelSecretSha256: createHash("sha256")
								.update(modelBytes)
								.digest("hex"),
							argv,
							registryAdmissionAccepted: false,
							nativeDiscoveryExecuted: false,
							businessAcceptance: false,
							deploymentModuleExecuted: false,
							runtimeProbeCalls: probeCalls,
						},
						null,
						2,
					)}\n`,
				);
			} finally {
				try {
					await worker?.stop();
				} finally {
					await sql.end().finally(() => database.stop());
				}
			}
		}, 180_000);

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
			const secretUid = await adapter.applyImmutableSecret(
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
				() => adapter.observe(a, initialIdentityA, "closed", "activation"),
				(value) => value === "healthy",
			);
			await adapter.bindSecretFence(
				a,
				initialIdentityA,
				a.secretRefs[0]?.name ?? "",
				1,
				secretUid,
			);
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

		it("drives the same Workload through the formal API lifecycle and recovers it", async () => {
			const database = await startPostgresTestDatabase("api-workload-kind");
			const sql = postgres(database.databaseUrl, { onnotice: () => undefined });
			const token = `papi_${"K".repeat(43)}`;
			const appToken = `papi_${"A".repeat(43)}`;
			let worker: ReturnType<typeof createPlatformWorkloadWorkerV1> | undefined;
			let assembly: ReturnType<typeof assemblePlatformApi> | undefined;
			const workerLogs: string[] = [];
			try {
				await migratePlatformDatabase(database);
				const imageDigest = process.env.WORKLOAD_KIND_HOST_IMAGE;
				if (!imageDigest)
					throw new Error("WORKLOAD_KIND_HOST_IMAGE is required");
				const { publicKey } = generateKeyPairSync("ed25519");
				const grantPublicKey = publicKey
					.export({ type: "spki", format: "pem" })
					.toString();
				const tokenName = "api-workload-service-token";
				apply({
					apiVersion: "v1",
					kind: "Secret",
					metadata: { name: tokenName, namespace },
					immutable: true,
					type: "Opaque",
					stringData: { token: randomBytes(32).toString("base64") },
				});
				const tokenSecret = await client.read<V1Secret>("Secret", tokenName);
				if (!tokenSecret?.data?.token)
					throw new Error("Runtime token is missing");
				const serviceToken = Buffer.from(
					tokenSecret.data.token,
					"base64",
				).toString();
				const seed = await seedStandardWorkloadHostV1(
					database.databaseUrl,
					imageDigest,
				);
				const hash = (value: string) =>
					createHash("sha256").update(value).digest("hex");
				await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision)
					values ('api-workload-application','API Workload','selector-host-owner','app-revision')`;
				await sql`update platform.agent_applications
					set creation_channel='api', creator_principal_type='application',
						creator_principal_id='api-workload-application', approval_revision=null,
						status='available', service_availability='ready'
					where agent_id=${seed.agentId}`;
				await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes)
					values ('api-workload-user','user','selector-host-owner',${hash(token)}, '["agent:manage","agent:read"]'::jsonb),
						('api-workload-app','application','api-workload-application',${hash(appToken)}, '["agent:manage","agent:read"]'::jsonb)`;
				await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision)
					values (${seed.agentId},'user','selector-host-owner','manage','user-manage'),
						(${seed.agentId},'application','api-workload-application','manage','app-manage')`;
				const unused = async (): Promise<never> => {
					throw new Error("Unused API dependency");
				};
				const admissions = {
					authorizationAdmission: { authorize: unused },
					imageAdmission: { admitImage: unused },
					modelAdmission: { admitModels: unused },
					secretAdmission: { admitSecrets: unused },
					channelAdmission: { admitChannels: unused },
				};
				assembly = assemblePlatformApi({
					databaseUrl: database.databaseUrl,
					taskAdmissionPolicy: {
						maximumWaitingTasksPerAgent: 1,
						waitingTimeoutMs: 30_000,
					},
					identity: {
						resolve: async () => null,
						resolveUser: async (userId) => ({
							schemaVersion: 1,
							userId,
							accountStatus: "active",
							organizationIds: [],
							authorizationRevision: "directory-revision",
						}),
						hydrateUsers: async () => [],
					},
					admissions,
					allocateApplicationIds: unused,
					prepareApplicationSecrets: unused,
					prepareConfigurationSecrets: unused,
					presentAgent: unused,
				});
				const api = createPlatformApp(assembly.dependencies);
				const request = (
					command: "stop" | "restart",
					key: string,
					bearer: string,
				) =>
					api.request(`/api/v2/agents/${seed.agentId}/commands`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${bearer}`,
							"Content-Type": "application/json",
							"Idempotency-Key": key,
						},
						body: JSON.stringify({ schemaVersion: 1, command }),
					});
				const probeRuntime = async (input: {
					baseUrl: string;
					manifest: { health: { path: string } };
				}) => {
					await kubectl(
						"exec",
						"worker-probe",
						"--",
						"node",
						"-e",
						"fetch(process.argv[1],{headers:{authorization:'Bearer '+process.argv[2]},signal:AbortSignal.timeout(2500)}).then(r=>{if(!r.ok)process.exit(2)}).catch(()=>process.exit(3))",
						`${input.baseUrl}${input.manifest.health.path}`,
						serviceToken,
					);
					return { core: "passed" as const, capabilities: {} };
				};
				const fetchViaProbe = async (input: Parameters<typeof fetch>[0]) => {
					const url = String(input);
					try {
						await kubectl(
							"exec",
							"worker-probe",
							"--",
							"node",
							"-e",
							"fetch(process.argv[1],{headers:{authorization:'Bearer '+process.argv[2]},signal:AbortSignal.timeout(2500)}).then(r=>{if(!r.ok)process.exit(2)}).catch(()=>process.exit(3))",
							url,
							serviceToken,
						);
						return new Response(null, { status: 200 });
					} catch {
						return new Response(null, { status: 503 });
					}
				};
				const workerClient = {
					...client,
					async create(object: Parameters<typeof client.create>[0]) {
						try {
							return await client.create(object);
						} catch (error) {
							workerLogs.push(
								JSON.stringify({
									op: "create",
									kind: object.kind,
									name: object.metadata?.name,
									code: error instanceof Error ? error.message : String(error),
								}),
							);
							throw error;
						}
					},
					async replace(object: Parameters<typeof client.replace>[0]) {
						try {
							return await client.replace(object);
						} catch (error) {
							workerLogs.push(
								JSON.stringify({
									op: "replace",
									kind: object.kind,
									name: object.metadata?.name,
									code: error instanceof Error ? error.message : String(error),
								}),
							);
							throw error;
						}
					},
				} as unknown as typeof client;
				worker = createPlatformWorkloadWorkerV1({
					...seed.workerOptions,
					client: workerClient,
					workerId: "api-workload-worker",
					pollIntervalMs: 1,
					policy: {
						...workloadPolicy,
						runtimeAuth: {
							workerId: "api-workload-worker",
							grantKeyId: "api-workload-grant",
							grantIssuer: "api-workload-issuer",
							grantPublicKey,
							serviceTokenSecret: { name: tokenName, key: "token" },
						},
					},
					registry: seed.workerOptions.registry,
					fetch: fetchViaProbe,
					log: (message) => workerLogs.push(message),
					probeRuntime,
				});
				async function tickUntil(
					predicate: (row: {
						status: string;
						service_availability: string | null;
					}) => boolean,
				) {
					for (let attempt = 0; attempt < 240; attempt++) {
						await worker?.tick();
						const [row] = await sql<
							{ status: string; service_availability: string | null }[]
						>`
							select status, service_availability from platform.agent_applications where agent_id=${seed.agentId}`;
						if (row && predicate(row)) return row;
						await setTimeout(500);
					}
					const [state] = await sql<{ state: unknown }[]>`
						select state from platform.workload_reconciliations where agent_id=${seed.agentId}`;
					const [outbox] = await sql<{ status: string; operation: string }[]>`
						select status, operation from platform.outbox_items where scope_id=${seed.agentId}`;
					const statefulSet = await client.read<V1StatefulSet>(
						"StatefulSet",
						workloadResourceNameV1(seed.agentId),
					);
					const pods = await client.list<V1Pod>("Pod", "");
					throw new Error(
						`API Workload lifecycle did not converge: ${JSON.stringify({ state, outbox, statefulSet, pods, workerLogs: workerLogs.slice(-8) })}`,
					);
				}
				await tickUntil(
					(row) =>
						row.status === "available" && row.service_availability === "ready",
				);
				const [initial] = await sql<
					{ workload_revision: number; fence: number }[]
				>`select workload_revision, fence from platform.agent_applications where agent_id=${seed.agentId}`;
				const workloadSelector = `agent-infra.agora.io/agent=${workloadResourceNameV1(seed.agentId)}`;
				const stopped = await request("stop", "api-workload-stop", token);
				expect(stopped.status).toBe(202);
				await tickUntil(
					(row) =>
						row.status === "stopped" && row.service_availability === null,
				);
				for (let attempt = 0; attempt < 120; attempt++) {
					const stoppedWorkloads = await client.list<V1StatefulSet>(
						"StatefulSet",
						workloadSelector,
					);
					const stoppedPods = await client.list<V1Pod>("Pod", workloadSelector);
					if (
						stoppedWorkloads.every(
							(workload) => workload.spec?.replicas === 0,
						) &&
						stoppedPods.length === 0
					)
						break;
					await worker?.tick();
					await setTimeout(500);
				}
				const [stoppedBaseline] = await sql<
					{ workload_revision: number; fence: number }[]
				>`select workload_revision, fence from platform.agent_applications where agent_id=${seed.agentId}`;
				const stoppedWorkloads = await client.list<V1StatefulSet>(
					"StatefulSet",
					workloadSelector,
				);
				const stoppedPods = await client.list<V1Pod>("Pod", workloadSelector);
				if (
					!stoppedWorkloads.every(
						(workload) => workload.spec?.replicas === 0,
					) ||
					stoppedPods.length !== 0
				) {
					const outbox = await sql`
							select status, operation, payload from platform.outbox_items where scope_id=${seed.agentId} order by created_at`;
					throw new Error(
						`API Workload stop resources did not converge: ${JSON.stringify({ workloads: stoppedWorkloads.map((workload) => ({ name: workload.metadata?.name, replicas: workload.spec?.replicas })), podCount: stoppedPods.length, stoppedBaseline, outbox })}`,
					);
				}
				const restarted = await request(
					"restart",
					"api-workload-restart",
					appToken,
				);
				expect(restarted.status).toBe(202);
				await tickUntil(
					(row) =>
						row.status === "available" && row.service_availability === "ready",
				);
				const [recovered] = await sql<
					{ workload_revision: number; fence: number }[]
				>`
					select workload_revision, fence from platform.agent_applications where agent_id=${seed.agentId}`;
				expect(Number(recovered?.workload_revision)).toBeGreaterThan(
					Number(
						stoppedBaseline?.workload_revision ?? initial?.workload_revision,
					),
				);
				expect(Number(recovered?.fence)).toBeGreaterThan(
					Number(stoppedBaseline?.fence ?? initial?.fence),
				);
			} finally {
				await worker?.stop();
				await assembly?.close();
				await sql.end();
				await database.stop();
			}
		}, 900_000);
	},
);
