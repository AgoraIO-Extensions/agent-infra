import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
import type {
	AgentConfigurationRecordV2,
	WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
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
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import {
	workloadDesiredFixture,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createWorkerKubernetesClientV1 } from "./kubernetes-client.js";
import {
	createKubernetesRuntimeAdapterV1,
	workloadResourceNameV1,
} from "./kubernetes-runtime-adapter.js";
import { createProductionWorkloadWorkerOptionsV1 } from "./workload-deployment.js";
import { createPlatformWorkloadWorkerV1 } from "./workload-worker.js";

const execFile = promisify(execFileCallback);
const namespace = workloadTestPolicy.namespace;
if (
	process.env.WORKLOAD_KIND_FORMAL_CHAIN === "1" &&
	process.env.WORKLOAD_KIND_TEST !== "1"
)
	throw new Error(
		"The formal config chain requires the isolated Workload kind entrypoint",
	);
const sha256 = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
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

		it.skipIf(process.env.WORKLOAD_KIND_FORMAL_CHAIN !== "1")(
			"binds a real DB revision through the production Worker to the same-head default Host configVersion",
			async () => {
				const required = (name: string) => {
					const value = process.env[name];
					if (!value) throw new Error(`Formal config chain requires ${name}`);
					return value;
				};
				const sourceCommit = required("SOURCE_COMMIT");
				const imageDigest = required("WORKLOAD_KIND_RUNTIME_IMAGE");
				const repository = required("WORKLOAD_KIND_RUNTIME_REPOSITORY");
				const evidenceDirectory = required("WORKLOAD_KIND_EVIDENCE_DIR");
				const kubeconfigPath = required("KUBECONFIG");
				expect(sourceCommit).toMatch(/^[a-f0-9]{40}$/);
				expect(imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
				if (!isAbsolute(evidenceDirectory) || !isAbsolute(kubeconfigPath))
					throw new Error("Formal chain paths must be absolute");
				expect(
					(await execFile("git", ["rev-parse", "HEAD"])).stdout.trim(),
				).toBe(sourceCommit);
				const imageMetadata = JSON.parse(
					await readFile(join(evidenceDirectory, "runtime-image.json"), "utf8"),
				) as {
					sourceCommit: string;
					repository: string;
					manifestDigest: string;
					resolvedManifestDigest: string;
					configDigest: string;
					imageId: string;
					labels: Record<string, string>;
					command: string[];
					entrypoint: string[] | null;
					workingDirectory: string;
					user: string;
					raw: Record<string, { path: string; sha256: string }>;
					scan: { passed: boolean; gatePassed: boolean; blocked: number };
					registryAdmissionAccepted: false;
				};
				expect(imageMetadata.sourceCommit).toBe(sourceCommit);
				expect(imageMetadata.repository).toBe(repository);
				expect(imageMetadata.manifestDigest).toBe(imageDigest);
				expect(imageMetadata.imageId).toBe(imageMetadata.configDigest);
				expect(imageMetadata.labels["org.opencontainers.image.revision"]).toBe(
					sourceCommit,
				);
				expect(imageMetadata.labels["agent-infra.lockfile-sha256"]).toBe(
					sha256(
						await readFile(new URL("../../../pnpm-lock.yaml", import.meta.url)),
					),
				);
				expect(imageMetadata.command).toEqual([
					"/bin/sh",
					"./start-runtime-host.sh",
				]);
				expect(imageMetadata.workingDirectory).toBe("/app");
				expect(imageMetadata.user).toBe("node");
				expect(imageMetadata.scan.gatePassed).toBe(true);
				expect(typeof imageMetadata.scan.passed).toBe("boolean");
				expect(imageMetadata.scan.blocked).toBeGreaterThanOrEqual(0);
				expect(imageMetadata.registryAdmissionAccepted).toBe(false);
				const configBlob = imageMetadata.raw["runtime-config.json"];
				if (!configBlob)
					throw new Error("Original OCI config receipt is absent");
				const rawConfig = await readFile(
					isAbsolute(configBlob.path)
						? configBlob.path
						: join(evidenceDirectory, configBlob.path),
				);
				expect(sha256(rawConfig)).toBe(configBlob.sha256);
				expect(`sha256:${sha256(rawConfig)}`).toBe(imageMetadata.configDigest);
				const ociConfig = JSON.parse(rawConfig.toString()) as {
					config: {
						Labels: Record<string, string>;
						Cmd: string[];
						Entrypoint?: string[] | null;
						WorkingDir: string;
						User: string;
						Env?: string[];
					};
				};
				expect(
					ociConfig.config.Labels["org.opencontainers.image.revision"],
				).toBe(sourceCommit);
				expect(ociConfig.config.Cmd).toEqual(imageMetadata.command);
				expect(ociConfig.config.Entrypoint ?? null).toEqual(
					imageMetadata.entrypoint ?? null,
				);
				expect(ociConfig.config.WorkingDir).toBe(
					imageMetadata.workingDirectory,
				);
				expect(ociConfig.config.User).toBe(imageMetadata.user);
				expect(
					ociConfig.config.Env?.some((entry) =>
						/^AGENT_INFRA_RUNTIME_(DRIVER|MODEL_CONFIG)=/.test(entry),
					) ?? false,
				).toBe(false);
				const runtimeImageReceiptHash = sha256(
					await readFile(join(evidenceDirectory, "runtime-image.json")),
				);
				const receiptPath = join(evidenceDirectory, "formal-chain.json");
				const phases: string[] = [];
				const evidence: Record<string, unknown> = {
					schemaVersion: 1,
					status: "started",
					sourceCommit,
					workerSourceCommit: sourceCommit,
					runtimeSourceCommit: sourceCommit,
					harnessSourceCommit: sourceCommit,
					runtimeImageReceiptHash,
					imageScan: imageMetadata.scan,
					imageDigest,
					registryAdmissionAccepted: false,
					controlledBoundaries: [
						"Registry verdict",
						"deployment model catalog",
						"model validation transport",
						"initial approved DB revision",
					],
					businessAcceptance: false,
					nativeDiscoveryExecuted: false,
					readinessProbeExecuted: false,
					phases,
				};
				const saveEvidence = () =>
					writeFile(receiptPath, `${JSON.stringify(evidence, null, 2)}\n`);
				await saveEvidence();
				const temporaryDirectory = await mkdtemp(
					join(tmpdir(), "workload-formal-config-"),
				);
				let database:
					| Awaited<ReturnType<typeof startPostgresTestDatabase>>
					| undefined;
				let sql: ReturnType<typeof postgres> | undefined;
				let worker:
					| ReturnType<typeof createPlatformWorkloadWorkerV1>
					| undefined;
				const agentId = `formal-${sourceCommit.slice(0, 12)}`;
				const workerId = `formal-worker-${sourceCommit.slice(0, 12)}`;
				let modelValidationRequests = 0;
				let runtimeProtocolRequests = 0;
				let readinessAuthorizations = 0;
				try {
					const admin = new KubeConfig();
					admin.loadFromFile(kubeconfigPath);
					const context = admin.getCurrentContext();
					const server = admin.getCurrentCluster()?.server;
					if (!context.startsWith("kind-workload-") || !server)
						throw new Error("Formal chain requires the isolated kind target");
					const namespaceObject = JSON.parse(
						await kubectl("get", "namespace", namespace, "-o=json"),
					) as { metadata?: { uid?: string } };
					if (!namespaceObject.metadata?.uid)
						throw new Error("Namespace UID is absent");
					evidence.target = {
						context,
						server,
						namespace,
						namespaceUid: namespaceObject.metadata.uid,
						kubeconfigSha256: sha256(await readFile(kubeconfigPath)),
					};
					const workerConfig = new KubeConfig();
					workerConfig.loadFromOptions({
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
					const workerConfigPath = join(
						temporaryDirectory,
						"worker-kubeconfig",
					);
					await writeFile(workerConfigPath, workerConfig.exportConfig(), {
						mode: 0o600,
					});
					database = await startPostgresTestDatabase("workload-formal-config");
					await migratePlatformDatabase(database);
					sql = postgres(database.databaseUrl, { max: 2, onnotice: () => {} });
					const [databaseIdentity] = await sql<
						{ oid: string; version: string }[]
					>`
						select oid::text, current_setting('server_version') as version from pg_database where datname = current_database()`;
					if (!databaseIdentity)
						throw new Error("Actual PostgreSQL identity is absent");
					evidence.database = databaseIdentity;
					const grantKeys = generateKeyPairSync("ed25519");
					const wrappingKeys = generateKeyPairSync("rsa", {
						modulusLength: 3072,
					});
					const publicWrappingKey = wrappingKeys.publicKey.export({
						type: "spki",
						format: "der",
					});
					const encryptor = createSecretEncryptorV1({
						encryptionKeys: {
							schemaVersion: 1,
							activeWrappingKeyVersion: "formal-key",
							keys: [
								{
									schemaVersion: 1,
									keyVersion: "formal-key",
									wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
									publicKeySpkiDerBase64: publicWrappingKey.toString("base64"),
									publicKeyFingerprint: sha256(publicWrappingKey),
									rsaModulusBits: 3072,
									status: "active",
								},
							],
						},
					});
					const modelCredential =
						"controlled-model-credential-not-an-external-secret";
					const secret = encryptor.encrypt({
						schemaVersion: 1,
						secretId: "formal-model-key",
						ownerType: "agent-owner",
						ownerId: "formal-owner",
						agentId,
						name: "model:formal-model",
						secretVersion: 1,
						configRevision: 1,
						plaintext: modelCredential,
						occurredAt: new Date().toISOString(),
					});
					const configuration: AgentConfigurationRecordV2 = {
						schemaVersion: 2,
						agentId,
						revision: 1,
						environment: [],
						secrets: [],
						channels: [],
						channelRevision: "channels_1",
						source: {
							kind: "standard",
							templateId: "formal-pi",
							imageDigest,
							admissionRevision: "controlled-registry-boundary",
							allowedEnvironmentKeys: [],
							allowedSecretKeys: [],
							platformManagedKeys: [],
							connectionEnabled: false,
						},
						modelConfiguration: {
							catalogRevision: "formal-catalog",
							options: [
								{
									optionId: "formal-model",
									endpointId: "formal-endpoint",
									modelId: "model-a",
									reasoningLevels: ["medium"],
									credential: {
										secretId: secret.secretId,
										version: 1,
										isSet: true,
									},
								},
							],
							defaultOptionId: "formal-model",
							defaultReasoningLevel: "medium",
						},
					};
					await sql.begin(async (transaction) => {
						// Controlled already-approved input. No copied Store/state-machine or
						// precomputed candidate/model projection/Secret/Pod is persisted here.
						await transaction`insert into platform.agents(id, current_configuration_revision, authorization_revision)
							values (${agentId}, 1, 'formal-authorization')`;
						await transaction`insert into platform.agent_applications
							(id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at,
							management_revision, approval_revision, desired_state, workload_revision, fence)
							values (${`${agentId}-application`}, ${agentId}, 'formal-owner', 'Formal config chain', 'Bounded metadata fixture',
							'creating', 'formal-trace', 'formal-request', now(), 1, 1, 'running', 1, 1)`;
						await transaction`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at)
							values (${agentId}, 1, 'formal-pi', ${transaction.json(configuration as unknown as postgres.JSONValue)}, now())`;
						await transaction`insert into platform.agent_owners(agent_id, owner_id, created_at) values (${agentId}, 'formal-owner', now())`;
						await transaction`insert into platform.secret_records
							(agent_id, secret_id, secret_version, configuration_revision, owner_type, owner_id, name, lifecycle_state,
							dek_fingerprint, wrapping_key_version, record, created_at, updated_at)
							values (${agentId}, ${secret.secretId}, 1, 1, 'agent-owner', 'formal-owner', ${secret.name}, 'pending',
							${secret.crypto.dekFingerprint}, 'formal-key', ${transaction.json(secret)}, now(), now())`;
						await transaction`insert into platform.outbox_items(id, scope_type, scope_id, operation, payload, trace_id, request_id)
							values (${`${agentId}-reconcile`}, 'agent', ${agentId}, 'agent.workload.reconcile.v1',
							${transaction.json({ schemaVersion: 1, agentId, revision: 1, workloadRevision: 1, fence: 1, desiredState: "running" })},
							'formal-trace', 'formal-request')`;
					});
					const tokenSecretName = `${agentId}-transport`;
					apply({
						apiVersion: "v1",
						kind: "Secret",
						metadata: { name: tokenSecretName, namespace },
						immutable: true,
						type: "Opaque",
						data: {
							token: Buffer.from("controlled-runtime-transport-token").toString(
								"base64",
							),
						},
					});
					const modelFetch: typeof fetch = async (input, init) => {
						const request = new Request(input, init);
						const url = new URL(request.url);
						if (
							url.origin !== "https://models.example.test" ||
							request.method !== "POST"
						)
							throw new Error(
								"External model requests are outside this scenario",
							);
						modelValidationRequests++;
						if (url.pathname === "/formal/v1/messages/count_tokens")
							return Response.json({ input_tokens: 1 });
						if (url.pathname !== "/formal/v1/messages")
							throw new Error("Unexpected controlled model request");
						const events = [
							{
								type: "message_start",
								message: {
									id: "controlled-model-validation",
									type: "message",
									role: "assistant",
									model: "model-a",
									content: [],
									usage: { input_tokens: 1, output_tokens: 1 },
								},
							},
							{
								type: "content_block_start",
								index: 0,
								content_block: {
									type: "tool_use",
									id: "controlled-call",
									name: "agent_infra_conformance",
									input: {},
								},
							},
							{
								type: "content_block_delta",
								index: 0,
								delta: { type: "input_json_delta", partial_json: "{}" },
							},
							{ type: "content_block_stop", index: 0 },
							{ type: "message_delta", delta: { stop_reason: "tool_use" } },
							{ type: "message_stop" },
						];
						return new Response(
							events
								.map(
									(event) =>
										`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
								)
								.join(""),
							{
								headers: { "content-type": "text/event-stream" },
							},
						);
					};
					const options = await createProductionWorkloadWorkerOptionsV1({
						databaseUrl: database.databaseUrl,
						workerId,
						kubernetes: {
							mode: "kubeconfig",
							path: workerConfigPath,
							context: "worker",
							expectedServer: server,
						},
						policy: {
							...workloadTestPolicy,
							imageRepository: repository,
							routeNamespace: namespace,
							resources: {
								requests: { cpu: "50m", memory: "128Mi" },
								limits: { cpu: "1000m", memory: "512Mi" },
							},
							runtimeAuth: {
								workerId,
								grantKeyId: "formal-grant",
								grantIssuer: "agent-platform",
								grantPublicKey: grantKeys.publicKey
									.export({ type: "spki", format: "pem" })
									.toString(),
								serviceTokenSecret: { name: tokenSecretName, key: "token" },
							},
						},
						registry: {
							endpoint: "https://registry.example.test",
							imageReferencePrefix: "registry.example.test",
							fetch: async () => {
								throw new Error(
									"Real Registry admission is outside this scenario",
								);
							},
							policy: { authorize: async () => ({ status: "rejected" }) },
						},
						admissionPolicyRef: "controlled-registry-policy",
						registrySubjectRef: "formal-worker",
						keyring: {
							keys: [
								{
									keyVersion: "formal-key",
									privateKeyPkcs8DerBase64: wrappingKeys.privateKey
										.export({ type: "pkcs8", format: "der" })
										.toString("base64"),
								},
							],
						},
						modelCatalog: {
							load: async () => ({
								schemaVersion: 1,
								revision: "formal-catalog",
								validUntil: Date.now() + 600_000,
								endpoints: [
									{
										endpointId: "formal-endpoint",
										baseUrl: "https://models.example.test/formal",
										origin: "https://models.example.test",
										protocol: "anthropic-messages-v1",
										authentication: "bearer",
										security: { tls: "verify-peer", redirects: "reject" },
										capabilities: {
											streaming: true,
											tools: true,
											reasoningLevels: ["medium"],
										},
										allowedModels: ["model-a"],
										available: true,
									},
								],
							}),
						},
						modelFetch,
						templateModelBindings: [
							{
								templateId: "formal-pi",
								imageDigest,
								driver: "pi",
								protocol: "anthropic-messages-v1",
							},
						],
						runtimeProbe: {
							authorize: async () => {
								readinessAuthorizations++;
								throw new Error(
									"Runtime readiness is outside the bounded observing phase",
								);
							},
						},
						runtimeFetch: async () => {
							runtimeProtocolRequests++;
							throw new Error(
								"Runtime protocol calls are outside the bounded observing phase",
							);
						},
						pollIntervalMs: 1,
						log: () => {},
					});
					// This source image has no formal manifest label. Only the existing
					// controlled Registry verdict is substituted; deployment validation,
					// PostgreSQL Store, crypto, model validator/projection and renderer stay real.
					worker = createPlatformWorkloadWorkerV1({
						...options,
						registry: workloadRegistryFixture({
							schemaVersion: 1,
							interactionMode: "platform-adapter",
							protocol: "acp",
							service: { port: 3003 },
							health: { path: "/healthz" },
						}),
					});
					const connection = sql;
					const readState = async () => {
						const [row] = await connection<
							{ state: WorkloadReconciliationStateV1 }[]
						>`
							select state from platform.workload_reconciliations where agent_id = ${agentId}`;
						return row?.state;
					};
					let state: WorkloadReconciliationStateV1 | undefined;
					for (let attempt = 0; attempt < 40; attempt++) {
						await worker.tick();
						state = await readState();
						if (state && phases.at(-1) !== state.phase)
							phases.push(state.phase);
						await saveEvidence();
						if (state?.phase === "observing") break;
						if (state && ["rejected", "failed"].includes(state.phase))
							throw new Error("Formal Worker candidate was rejected");
						await setTimeout(250);
					}
					if (state?.phase !== "observing")
						throw new Error(
							"Production Worker did not reach bounded observing phase",
						);
					await worker.stop();
					worker = undefined;
					expect(state.sourceConfigurationRevision).toBe(1);
					expect(state.candidate.configuration).toEqual(configuration);
					const desired = validateAgentWorkloadDesiredV1(
						state.candidate.deployment,
					);
					expect(desired.imageDigest).toBe(imageDigest);
					expect(desired.configRevision).toBe(1);
					const projection = validateRuntimeModelProjectionV1(
						state.candidate.modelProjection,
						state.candidate.configuration,
					);
					const injection = runtimeModelInjectionV1(projection);
					evidence.store = {
						agentId,
						sourceConfigurationRevision: state.sourceConfigurationRevision,
						configurationSha256: sha256(
							JSON.stringify(state.candidate.configuration),
						),
						modelProjectionFingerprint: projection.fingerprint,
						candidateSha256: sha256(JSON.stringify(state.candidate)),
						phase: state.phase,
						workloadRevision: state.revision,
						fence: state.fence,
						modelValidationRequests,
					};
					expect(modelValidationRequests).toBe(2);
					expect(runtimeProtocolRequests).toBe(0);
					expect(readinessAuthorizations).toBe(0);
					evidence.runtimeProtocolRequests = runtimeProtocolRequests;
					evidence.readinessAuthorizations = readinessAuthorizations;
					const liveSecret = await options.client.read<V1Secret>(
						"Secret",
						injection.secretName,
					);
					if (!liveSecret?.metadata?.uid || !liveSecret.data?.configuration)
						throw new Error("Actual generated model Secret is absent");
					expect(liveSecret.immutable).toBe(true);
					const configurationBytes = Buffer.from(
						liveSecret.data.configuration,
						"base64",
					);
					expect(sha256(configurationBytes)).toBe(
						sha256(injection.configuration),
					);
					const runtimeConfiguration = JSON.parse(
						configurationBytes.toString(),
					) as { schemaVersion: number; configVersion: string };
					expect(runtimeConfiguration.schemaVersion).toBe(3);
					const configVersion = runtimeConfiguration.configVersion;
					evidence.modelSecret = {
						name: injection.secretName,
						uid: liveSecret.metadata.uid,
						immutable: true,
						configurationSha256: sha256(configurationBytes),
						schemaVersion: runtimeConfiguration.schemaVersion,
						configVersion,
					};
					const name = workloadResourceNameV1(agentId);
					const workload = await options.client.read<V1StatefulSet>(
						"StatefulSet",
						name,
					);
					if (!workload?.spec?.template.spec)
						throw new Error("Actual production StatefulSet is absent");
					const template = workload.spec.template.spec;
					const container = template.containers.find(
						(entry) => entry.name === "agent",
					);
					if (!container)
						throw new Error("Original generated container is absent");
					expect(container.command).toBeUndefined();
					expect(container.args).toBeUndefined();
					expect(container.image).toBe(`${repository}@${imageDigest}`);
					expect(
						container.env?.find(
							(entry) => entry.name === "AGENT_INFRA_RUNTIME_DRIVER",
						),
					).toEqual({ name: "AGENT_INFRA_RUNTIME_DRIVER", value: "pi" });
					expect(
						container.env?.find(
							(entry) => entry.name === "AGENT_INFRA_RUNTIME_MODEL_CONFIG",
						)?.valueFrom?.secretKeyRef?.name,
					).toBe(injection.secretName);
					const pod = await eventually(
						() => options.client.read<V1Pod>("Pod", `${name}-0`),
						(value) =>
							value?.status?.containerStatuses?.some(
								(entry) => entry.name === "agent" && entry.ready,
							) ?? false,
					);
					const pvc = await options.client.read<V1PersistentVolumeClaim>(
						"PersistentVolumeClaim",
						desired.persistentVolume.name,
					);
					const status = pod?.status?.containerStatuses?.find(
						(entry) => entry.name === "agent",
					);
					if (!pod?.metadata?.uid || !status?.imageID || !pvc?.metadata?.uid)
						throw new Error("Current Pod/image/PVC identity is absent");
					expect(status.ready).toBe(true);
					const currentContainer = pod.spec?.containers.find(
						(entry) => entry.name === "agent",
					);
					expect(currentContainer?.image).toBe(container.image);
					expect(currentContainer?.command).toBeUndefined();
					expect(currentContainer?.args).toBeUndefined();
					const processArgv = JSON.parse(
						await kubectl(
							"exec",
							`${name}-0`,
							"-c=agent",
							"--",
							"node",
							"-e",
							"console.log(JSON.stringify(require('fs').readFileSync('/proc/1/cmdline','utf8').split(String.fromCharCode(0)).filter(Boolean)))",
						),
					) as string[];
					expect(processArgv).toEqual([
						"/usr/local/bin/node",
						"--disable-sigusr1",
						"dist/index.mjs",
					]);
					const actualImageDigest =
						status.imageID.match(/sha256:[a-f0-9]{64}$/)?.[0];
					expect([
						imageDigest,
						imageMetadata.resolvedManifestDigest,
						imageMetadata.configDigest,
					]).toContain(actualImageDigest);
					const startupLogs = await kubectl("logs", `${name}-0`, "-c=agent");
					const startup = startupLogs
						.split("\n")
						.flatMap((line) => {
							try {
								const value = JSON.parse(line);
								return value?.service === "agent-runtime-host" ? [value] : [];
							} catch {
								return [];
							}
						})
						.find(
							(value) =>
								value.status === "ready" &&
								value.configVersion === configVersion,
						);
					if (!startup)
						throw new Error(
							"Original default index did not report the generated configVersion",
						);
					evidence.runtime = {
						podName: pod.metadata.name,
						podUid: pod.metadata.uid,
						statefulSetUid: workload.metadata?.uid,
						pvcName: pvc.metadata.name,
						pvcUid: pvc.metadata.uid,
						image: container.image,
						imageId: status.imageID,
						resolvedImageDigest: actualImageDigest,
						generatedSelector: "pi",
						defaultCommand: imageMetadata.command,
						actualProcessArgv: processArgv,
						commandOverridden: false,
						argsOverridden: false,
						startup: {
							service: startup.service,
							status: startup.status,
							configVersion: startup.configVersion,
							port: startup.port,
						},
					};
					await saveEvidence();
					const rejectionEvidence: unknown[] = [];
					for (const rejection of ["missing-selector", "bad-config"] as const) {
						const negativeName = `${agentId}-${rejection}`;
						const negativeSpec = structuredClone(template);
						negativeSpec.restartPolicy = "Never";
						negativeSpec.nodeName = pod.spec?.nodeName;
						const negativeContainer = negativeSpec.containers.find(
							(entry) => entry.name === "agent",
						);
						if (!negativeContainer)
							throw new Error("Original negative container is absent");
						if (rejection === "missing-selector")
							negativeContainer.env = negativeContainer.env?.filter(
								(entry) => entry.name !== "AGENT_INFRA_RUNTIME_DRIVER",
							);
						else {
							const badSecretName = `${agentId}-bad-config`;
							apply({
								apiVersion: "v1",
								kind: "Secret",
								metadata: { name: badSecretName, namespace },
								immutable: true,
								type: "Opaque",
								data: {
									configuration: Buffer.from(
										JSON.stringify({
											...JSON.parse(injection.configuration),
											schemaVersion: 0,
										}),
									).toString("base64"),
								},
							});
							const slot = negativeContainer.env?.find(
								(entry) => entry.name === "AGENT_INFRA_RUNTIME_MODEL_CONFIG",
							);
							if (!slot?.valueFrom?.secretKeyRef)
								throw new Error(
									"Original model config env reference is absent",
								);
							slot.valueFrom.secretKeyRef.name = badSecretName;
						}
						// Deliberately manipulated negative Pod only; positive generated env,
						// immutable Secret and default startup remain unchanged.
						apply({
							apiVersion: "v1",
							kind: "Pod",
							metadata: { name: negativeName, namespace },
							spec: negativeSpec,
						});
						const terminal = await eventually(
							() => options.client.read<V1Pod>("Pod", negativeName),
							(value) =>
								value?.status?.containerStatuses?.some(
									(entry) =>
										entry.name === "agent" &&
										entry.state?.terminated !== undefined,
								) ?? false,
						);
						const terminated = terminal?.status?.containerStatuses?.find(
							(entry) => entry.name === "agent",
						)?.state?.terminated;
						expect(terminated?.exitCode).toBe(1);
						const logs = await kubectl("logs", negativeName, "-c=agent");
						expect(logs).toContain('"code":"RUNTIME_CONFIGURATION_INVALID"');
						expect(logs).not.toContain('"status":"ready"');
						rejectionEvidence.push({
							case: rejection,
							podUid: terminal?.metadata?.uid,
							exitCode: terminated?.exitCode,
							code: "RUNTIME_CONFIGURATION_INVALID",
							defaultCommandPreserved: true,
						});
						await kubectl(
							"delete",
							"pod",
							negativeName,
							"--wait=true",
							"--timeout=30s",
						);
					}
					evidence.rejections = rejectionEvidence;
					evidence.status = "passed";
					evidence.executedScenarios = 3;
					evidence.skippedScenarios = 0;
					evidence.observedAt = new Date().toISOString();
					await saveEvidence();
				} catch (error) {
					evidence.status = "failed";
					await saveEvidence();
					throw error;
				} finally {
					try {
						await worker?.stop();
					} finally {
						try {
							await sql?.end();
						} finally {
							try {
								await database?.stop();
							} finally {
								await rm(temporaryDirectory, { recursive: true, force: true });
							}
						}
					}
				}
			},
			600_000,
		);
	},
);
