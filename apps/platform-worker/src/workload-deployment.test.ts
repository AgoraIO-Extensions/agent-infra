import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeBrowserCapabilityAssemblyV1 } from "@agent-infra/agent-runtime";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import type {
	BrowserCapabilityDeclarationV1,
	RuntimeBrowserCapabilityProbeEvidenceV1,
} from "@agent-infra/contracts/runtime";
import { KubeConfig } from "@kubernetes/client-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionGrantVerifier } from "../../../packages/agent-runtime/src/grant.js";
import { createWorkloadReadinessVerifierV1 } from "../../../packages/agent-runtime/src/readiness.js";
import { catalogFixture } from "../../../packages/model-catalog/src/catalog.fixture.js";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import {
	createProductionWorkloadWorkerOptionsV1,
	createWorkloadReadinessAuthorizationV1,
	createWorkloadRuntimeProbeV1,
	type ProductionWorkloadWorkerInputV1,
	type WorkloadRuntimeProbeAuthorizationV1,
} from "./workload-deployment.js";
import {
	validateWorkloadRuntimeAuthV1,
	workloadRuntimeAuthEnvironmentV1,
} from "./workload-runtime-auth.js";

const keys = generateKeyPairSync("ed25519");
const wrapping = generateKeyPairSync("rsa", { modulusLength: 3072 });
const runtimeAuth = {
	workerId: "worker-a",
	grantKeyId: "probe-key",
	grantIssuer: "agent-platform",
	grantPublicKey: keys.publicKey
		.export({ format: "pem", type: "spki" })
		.toString(),
	serviceTokenSecret: { name: "runtime-transport", key: "token" },
};
const directories: string[] = [];
async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "worker-deployment-"));
	directories.push(directory);
	return directory;
}
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function authorize(
	mutate?: (claims: Record<string, unknown>) => void,
): WorkloadRuntimeProbeAuthorizationV1 {
	const signer = createWorkloadReadinessAuthorizationV1({
		workerId: "worker-a",
		issuer: "agent-platform",
		keyId: runtimeAuth.grantKeyId,
		privateKey: keys.privateKey,
		serviceToken: "synthetic-runtime-transport",
	});
	if (!mutate) return signer;
	return {
		async authorize(input, signal) {
			const result = await signer.authorize(input, signal);
			const [header] = result.grant.token.split(".");
			const claims = JSON.parse(
				Buffer.from(
					result.grant.token.split(".")[1] ?? "",
					"base64url",
				).toString(),
			);
			mutate(claims);
			const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
			const unsigned = `${header}.${payload}`;
			return {
				...result,
				grant: {
					...result.grant,
					token: `${unsigned}.${sign(null, Buffer.from(unsigned), keys.privateKey).toString("base64url")}`,
				},
			};
		},
	};
}

function probeInput(signal = new AbortController().signal) {
	const desired = workloadDesiredFixture(2, "agent-a", "internal-only");
	return {
		agentId: desired.agentId,
		workloadRevision: desired.workloadRevision,
		fence: desired.fence,
		imageDigest: desired.imageDigest,
		baseUrl: `http://${workloadResourceNameV1(desired.agentId)}-probe.${workloadTestPolicy.namespace}.svc:${desired.service.port}`,
		manifest: desired.runtimeManifest,
		signal,
	};
}

describe("production Worker deployment", () => {
	async function input(
		server = "http://127.0.0.1:1",
	): Promise<ProductionWorkloadWorkerInputV1> {
		const directory = await temporaryDirectory();
		const config = new KubeConfig();
		config.loadFromOptions({
			clusters: [
				{ name: "owned", server, skipTLSVerify: true },
				{ name: "foreign", server: "https://foreign.invalid" },
			],
			users: [{ name: "worker", token: "synthetic-kubernetes-token" }],
			contexts: [
				{
					name: "kind-owned",
					cluster: "owned",
					user: "worker",
					namespace: workloadTestPolicy.namespace,
				},
				{ name: "foreign", cluster: "foreign", user: "worker" },
			],
			currentContext: "foreign",
		});
		const path = join(directory, "kubeconfig");
		await writeFile(path, config.exportConfig(), { mode: 0o600 });
		return {
			databaseUrl: "postgresql://worker:synthetic@127.0.0.1/platform",
			workerId: "worker-a",
			kubernetes: {
				mode: "kubeconfig",
				path,
				context: "kind-owned",
				expectedServer: server,
			},
			policy: { ...workloadTestPolicy, runtimeAuth },
			registry: {
				endpoint: "https://registry.example.test",
				imageReferencePrefix: "registry.example.test",
				policy: { authorize: async () => ({ status: "rejected" }) },
			},
			admissionPolicyRef: "policy-a",
			registrySubjectRef: "worker-subject",
			keyring: {
				keys: [
					{
						keyVersion: "key-a",
						privateKeyPkcs8DerBase64: wrapping.privateKey
							.export({ format: "der", type: "pkcs8" })
							.toString("base64"),
					},
				],
			},
			modelCatalog: { load: async () => catalogFixture() },
			templateModelBindings: [],
			runtimeProbe: authorize(),
			runtimeFetch: fetch,
		};
	}
	it.each([
		[
			{
				templateId: "template-a",
				imageDigest: `sha256:${"a".repeat(64)}`,
				protocol: "openai-responses-v1",
			},
		],
		[
			{
				templateId: "template-a",
				imageDigest: `sha256:${"a".repeat(64)}`,
				driver: "fake",
				protocol: "openai-responses-v1",
			},
		],
		[
			{
				templateId: "template-a",
				imageDigest: `sha256:${"a".repeat(64)}`,
				driver: "claude",
				protocol: "openai-responses-v1",
			},
		],
	])(
		"rejects bad trusted Driver bindings before reading Kubernetes credentials (%#)",
		async (templateModelBindings) => {
			const deployment = await input();
			Object.defineProperty(deployment, "templateModelBindings", {
				value: templateModelBindings,
			});
			Object.defineProperty(deployment, "kubernetes", {
				get() {
					throw new Error("Kubernetes credentials must not be read");
				},
			});
			await expect(
				createProductionWorkloadWorkerOptionsV1(deployment),
			).rejects.toThrow("WORKER_CONFIGURATION_INVALID");
		},
	);
	it("passes a validated deployment-owned file reconciliation adapter", async () => {
		const deployment = await input();
		const files = {
			storage: {
				scan: async () => ({ objects: [], cursor: null }),
				remove: async () => {},
			},
			batchSize: 10,
			orphanGraceMs: 60_000,
		} satisfies NonNullable<ProductionWorkloadWorkerInputV1["files"]>;
		const options = await createProductionWorkloadWorkerOptionsV1({
			...deployment,
			files,
		});
		expect(options.files).toBe(files);
	});
	it("rejects malformed file reconciliation configuration before Kubernetes access", async () => {
		const deployment = await input();
		Object.defineProperty(deployment, "files", {
			value: { storage: {}, batchSize: 0, orphanGraceMs: 0 },
		});
		Object.defineProperty(deployment, "kubernetes", {
			get() {
				throw new Error("Kubernetes credentials must not be read");
			},
		});
		await expect(
			createProductionWorkloadWorkerOptionsV1(deployment),
		).rejects.toThrow("WORKER_CONFIGURATION_INVALID");
	});

	it("uses the explicitly selected namespace client rather than kubeconfig current-context", async () => {
		const requests: { url?: string; authorization?: string }[] = [];
		const server = createServer((request, response) => {
			requests.push({
				url: request.url,
				authorization: request.headers.authorization,
			});
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify(
					request.url === "/api/v1"
						? {
								apiVersion: "v1",
								kind: "APIResourceList",
								groupVersion: "v1",
								resources: [
									{
										name: "pods",
										singularName: "pod",
										namespaced: true,
										kind: "Pod",
										verbs: ["list"],
									},
								],
							}
						: {
								apiVersion: "v1",
								kind: "PodList",
								metadata: {},
								items: [],
							},
				),
			);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error();
			const options = await createProductionWorkloadWorkerOptionsV1(
				await input(`http://127.0.0.1:${address.port}`),
			);
			await expect(
				options.client.list("Pod", "component=agent"),
			).resolves.toEqual([]);
			expect(requests).toEqual([
				{ url: "/api/v1", authorization: "Bearer synthetic-kubernetes-token" },
				{
					url: "/api/v1/namespaces/workload-test/pods?labelSelector=component%3Dagent",
					authorization: "Bearer synthetic-kubernetes-token",
				},
			]);
			expect(options).not.toHaveProperty("keyring");
			expect(JSON.stringify(options.policy)).not.toContain("PRIVATE KEY");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
	it("assembles the real catalog and model preflight with a separate credential transport", async () => {
		const deployment = await input();
		const modelFetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", model: body.model, reasoning: body.reasoning, output: [{ type: "function_call", name: "agent_infra_conformance", arguments: "{}", status: "completed" }] } })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		);
		const bindings = [
			{
				templateId: "template-a",
				imageDigest: `sha256:${"a".repeat(64)}`,
				driver: "codex" as const,
				protocol: "openai-responses-v1" as const,
			},
		];
		const registryFetch = vi.fn();
		const options = await createProductionWorkloadWorkerOptionsV1({
			...deployment,
			templateModelBindings: bindings,
			registry: { ...deployment.registry, fetch: registryFetch },
			modelFetch,
		});
		const binding = bindings[0];
		if (!binding) throw new Error("Expected trusted binding fixture");
		Object.assign(binding, { driver: "fake" });
		bindings.length = 0;
		expect(options.templateModelBindings[0]?.driver).toBe("codex");
		expect(Object.isFrozen(options.templateModelBindings)).toBe(true);
		expect(Object.isFrozen(options.templateModelBindings[0])).toBe(true);
		const signal = AbortSignal.timeout(1000);
		if (!options.modelCatalog || !options.modelAccess) throw new Error();
		const endpoint = await options.modelCatalog.resolve(
			{ endpointId: "endpoint-a", catalogRevision: "catalog-a" },
			{ signal },
		);
		await expect(
			options.modelAccess.validate(
				{
					endpoint,
					modelId: "model-a",
					reasoningLevels: ["medium"],
					credential: Buffer.from("synthetic-model-credential"),
				},
				{ signal },
			),
		).resolves.toBeUndefined();
		expect(modelFetch.mock.calls[0]?.[0]).toBe(
			"https://models.example.test/team-a/v1/responses",
		);
		expect(
			new Headers(modelFetch.mock.calls[0]?.[1]?.headers).get("authorization"),
		).toBe("Bearer synthetic-model-credential");
		expect(registryFetch).not.toHaveBeenCalled();
	});
	it.each([
		"context",
		"server",
		"namespace",
		"registry",
		"keyring",
		"probe",
		"aborted",
	])("rejects invalid %s with sanitized diagnostics", async (failure) => {
		const deployment = await input();
		if (deployment.kubernetes.mode !== "kubeconfig") throw new Error();
		const changed =
			failure === "context"
				? {
						...deployment,
						kubernetes: { ...deployment.kubernetes, context: "missing" },
					}
				: failure === "server"
					? {
							...deployment,
							kubernetes: {
								...deployment.kubernetes,
								expectedServer: "https://foreign.invalid",
							},
						}
					: failure === "namespace"
						? {
								...deployment,
								policy: {
									...deployment.policy,
									namespace: "another-namespace",
								},
							}
						: failure === "registry"
							? {
									...deployment,
									registry: {
										...deployment.registry,
										endpoint: "http://synthetic-credential@registry.invalid",
									},
								}
							: failure === "keyring"
								? {
										...deployment,
										keyring: {
											keys: [
												{
													keyVersion: "key-a",
													privateKeyPkcs8DerBase64: "synthetic-private-key",
												},
											],
										},
									}
								: failure === "probe"
									? {
											...deployment,
											runtimeProbe:
												undefined as unknown as WorkloadRuntimeProbeAuthorizationV1,
										}
									: deployment;
		await expect(
			createProductionWorkloadWorkerOptionsV1(
				changed,
				failure === "aborted" ? AbortSignal.abort() : undefined,
			),
		).rejects.toThrow(/^WORKER_[A-Z_]+$/);
	});
	it.each([
		"http://kubernetes.example",
		"https://worker:secret@kubernetes.example",
	])("rejects unsafe kubeconfig server URL %s", async (server) => {
		await expect(
			createProductionWorkloadWorkerOptionsV1(await input(server)),
		).rejects.toThrow("WORKER_KUBERNETES_CONFIGURATION_INVALID");
	});
});

describe("authenticated Workload Runtime probe", () => {
	it("passes the admitted Browser declaration and local probe evidence to Host assembly", async () => {
		const directory = await temporaryDirectory();
		const base = probeInput();
		const browserDeclaration: BrowserCapabilityDeclarationV1 = {
			schemaVersion: 1,
			capabilityVersion: 1,
			operations: ["navigate", "observe"],
			policy: {
				allowedOrigins: ["https://example.test/"],
				maxContexts: 1,
				maxTabs: 1,
				maxPages: 1,
				maxViewportWidth: 1280,
				maxViewportHeight: 720,
				maxConcurrentActions: 1,
				maxDownloads: 0,
				maxDownloadBytes: 0,
				maxUploadBytes: 0,
				maxScreenshotBytes: 1024,
				maxBrowserDurationMs: 60_000,
				maxRetainedProfileBytes: 100_000,
				navigationTimeoutMs: 15_000,
				actionTimeoutMs: 5_000,
				requireSideEffectConfirmation: true,
				allowUserHandoff: false,
			},
		};
		const browserProbe: RuntimeBrowserCapabilityProbeEvidenceV1 = {
			capabilityVersion: 1,
			operations: ["navigate", "observe"],
			provenance: {
				browser: "chromium",
				chromiumVersion: "153.0.8010.12",
				playwrightVersion: "1.63.0",
				imageDigest: base.imageDigest,
			},
			conformance: {
				schemaVersion: 1,
				receiptId: "browser-receipt",
				probeVersion: "browser-probe",
				verifiedAt: new Date().toISOString(),
				manifestDigest: base.imageDigest,
				evidenceHash: "b".repeat(64),
				operations: ["navigate", "observe"],
			},
			binding: {
				agentId: base.agentId,
				sessionId: "session-a",
				sessionGeneration: 1,
				resourceFence: base.fence,
				workloadRevision: base.workloadRevision,
				imageDigest: base.imageDigest,
			},
		};
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		Object.assign(driver, {
			probeReadiness: async () => ({
				...(await driver.getCapabilities()),
				browser: browserProbe,
			}),
		});
		let assembled: RuntimeBrowserCapabilityAssemblyV1 | undefined;
		const host = await RuntimeHost.open({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: { expectedIssuer: runtimeAuth.grantIssuer },
			readinessVerifier: createWorkloadReadinessVerifierV1({
				binding: {
					workerId: runtimeAuth.workerId,
					agentId: base.agentId,
					workloadRevision: base.workloadRevision,
					fence: base.fence,
					imageDigest: base.imageDigest,
				},
				publicKeys: new Map([[runtimeAuth.grantKeyId, keys.publicKey]]),
				expectedIssuer: runtimeAuth.grantIssuer,
			}),
			onBrowserCapabilityAssembly: (input) => {
				assembled = input;
			},
		});
		const app = createRuntimeHostApp({
			host,
			readinessWorkerId: runtimeAuth.workerId,
			serviceToken: "synthetic-runtime-transport",
			verifyGrant: createExecutionGrantVerifier(
				new Map([[runtimeAuth.grantKeyId, keys.publicKey]]),
			),
		});
		const probe = createWorkloadRuntimeProbeV1({
			namespace: workloadTestPolicy.namespace,
			workerId: runtimeAuth.workerId,
			authorization: authorize(),
			fetch: async (url, init) => app.request(String(url), init),
		});
		await expect(
			probe({
				...base,
				browserBinding: browserProbe.binding,
				manifest: {
					...base.manifest,
					capabilities: {
						modelSelection: false,
						attachments: false,
						resultFiles: false,
						connection: false,
						supplementaryInstruction: false,
						browser: browserDeclaration,
					},
				},
			}),
		).resolves.toMatchObject({ capabilities: { browser: browserProbe } });
		expect(assembled).toEqual({
			declaration: browserDeclaration,
			binding: browserProbe.binding,
			manifestDigest: base.imageDigest,
			probe: browserProbe,
		});
		await host.close();
	});
	it("checks the real RuntimeHost endpoint using the Worker readiness signer without business side effects", async () => {
		const directory = await temporaryDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const coreProbe = vi.fn(async () => driver.getCapabilities());
		const execute = vi.spyOn(driver, "execute");
		const target = probeInput();
		const host = await RuntimeHost.open({
			readinessVerifier: createWorkloadReadinessVerifierV1({
				binding: {
					workerId: "worker-a",
					agentId: target.agentId,
					workloadRevision: target.workloadRevision,
					fence: target.fence,
					imageDigest: target.imageDigest,
				},
				publicKeys: new Map([[runtimeAuth.grantKeyId, keys.publicKey]]),
				expectedIssuer: runtimeAuth.grantIssuer,
			}),
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver: Object.assign(driver, { probeReadiness: coreProbe }),
			grantValidation: { expectedIssuer: runtimeAuth.grantIssuer },
		});
		const app = createRuntimeHostApp({
			host,
			readinessWorkerId: "worker-a",
			serviceToken: "synthetic-runtime-transport",
			verifyGrant: createExecutionGrantVerifier(
				new Map([[runtimeAuth.grantKeyId, keys.publicKey]]),
			),
		});
		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) =>
				app.request(String(url), init),
		);
		const probe = createWorkloadRuntimeProbeV1({
			namespace: workloadTestPolicy.namespace,
			workerId: "worker-a",
			authorization: authorize(),
			fetch: fetcher,
		});
		await expect(probe(probeInput())).resolves.toEqual({
			core: "passed",
			capabilities: {
				modelSelection: true,
				attachments: true,
				resultFiles: true,
				connection: true,
				supplementaryInstruction: true,
			},
		});
		expect(coreProbe).toHaveBeenCalledOnce();
		expect(execute).not.toHaveBeenCalled();
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
		const denied = createWorkloadRuntimeProbeV1({
			namespace: workloadTestPolicy.namespace,
			workerId: "worker-a",
			authorization: {
				authorize: async (input, signal) => ({
					...(await authorize().authorize(input, signal)),
					serviceToken: "wrong-token",
				}),
			},
			fetch: fetcher,
		});
		await expect(denied(probeInput())).rejects.toThrow(
			"WORKER_RUNTIME_PROBE_FAILED",
		);
	});
	it.each(["scope", "agent", "audience", "attachments"])(
		"rejects a probe grant with a foreign %s before transport",
		async (failure) => {
			const fetcher = vi.fn();
			const authorization = authorize((claims) => {
				if (failure === "scope") claims.purpose = "turn.submit";
				if (failure === "agent") claims.agentId = "agent-b";
				if (failure === "audience") claims.audience = "connection_api";
				if (failure === "attachments")
					claims.attachments = [
						{ attachmentId: "other", operations: ["read"] },
					];
			});
			const probe = createWorkloadRuntimeProbeV1({
				namespace: workloadTestPolicy.namespace,
				workerId: "worker-a",
				authorization,
				fetch: fetcher,
			});
			await expect(probe(probeInput())).rejects.toThrow(
				"WORKER_RUNTIME_PROBE_FAILED",
			);
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
	it("rejects an alternate Agent service before acquiring transport credentials", async () => {
		const authorization = { authorize: vi.fn() };
		const probe = createWorkloadRuntimeProbeV1({
			namespace: workloadTestPolicy.namespace,
			workerId: "worker-a",
			authorization,
		});
		await expect(
			probe({
				...probeInput(),
				baseUrl: "http://another-agent.workload-test.svc:8080",
			}),
		).rejects.toThrow("WORKER_RUNTIME_PROBE_FAILED");
		expect(authorization.authorize).not.toHaveBeenCalled();
	});
	it.each([
		"oversize",
		"malformed",
		"redirect",
		"authorization-stall",
		"body-stall",
	])("fails closed for %s", async (failure) => {
		const abort = new AbortController();
		const authorization =
			failure === "authorization-stall"
				? { authorize: () => new Promise<never>(() => {}) }
				: authorize();
		const fetcher = async () =>
			failure === "redirect"
				? new Response(null, {
						status: 302,
						headers: { location: "https://foreign.invalid" },
					})
				: failure === "oversize"
					? new Response("x".repeat(65_537))
					: failure === "body-stall"
						? new Response(new ReadableStream())
						: new Response('{"schemaVersion":1,"capabilities":{}}');
		const probe = createWorkloadRuntimeProbeV1({
			namespace: workloadTestPolicy.namespace,
			workerId: "worker-a",
			authorization,
			fetch: fetcher,
		});
		const pending = probe(probeInput(abort.signal));
		const expectation = expect(pending).rejects.toThrow(
			"WORKER_RUNTIME_PROBE_FAILED",
		);
		if (failure.endsWith("stall")) setTimeout(() => abort.abort(), 10);
		await expectation;
	});
});

describe("deployment Runtime authentication material", () => {
	it("injects only public verification material and the token Secret reference with exact Agent/PVC binding", () => {
		validateWorkloadRuntimeAuthV1(runtimeAuth);
		const desired = workloadDesiredFixture();
		const env = workloadRuntimeAuthEnvironmentV1(runtimeAuth, desired);
		expect(
			env.find((entry) => entry.name === "AGENT_INFRA_RUNTIME_SERVICE_TOKEN"),
		).toEqual({
			name: "AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
			valueFrom: {
				secretKeyRef: {
					name: "runtime-transport",
					key: "token",
					optional: false,
				},
			},
		});
		expect(
			env.find((entry) => entry.name === "AGENT_INFRA_RUNTIME_AGENT_ID")?.value,
		).toBe(desired.agentId);
		expect(
			env.find((entry) => entry.name === "AGENT_INFRA_RUNTIME_DATA_DIR")?.value,
		).toBe("/workspace/runtime");
		expect(JSON.stringify(env)).not.toContain("PRIVATE KEY");
	});
	it("rejects private keys and arbitrary extra deployment fields", () => {
		expect(() =>
			validateWorkloadRuntimeAuthV1({
				...runtimeAuth,
				grantPublicKey: `${runtimeAuth.grantPublicKey}\n${keys.privateKey.export({ format: "pem", type: "pkcs8" })}`,
			}),
		).toThrow();
		expect(() =>
			validateWorkloadRuntimeAuthV1({
				...runtimeAuth,
				grantPublicKey: keys.privateKey
					.export({ format: "pem", type: "pkcs8" })
					.toString(),
			}),
		).toThrow();
		expect(() =>
			validateWorkloadRuntimeAuthV1({
				...runtimeAuth,
				privateKey: "synthetic-private-key",
			} as typeof runtimeAuth),
		).toThrow();
	});
});
