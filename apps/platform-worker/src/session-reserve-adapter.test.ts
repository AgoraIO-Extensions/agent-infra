import {
	createHash,
	createPrivateKey,
	generateKeyPairSync,
	randomUUID,
	sign,
} from "node:crypto";
import { RuntimeSkillHubBindingV1Schema } from "@agent-infra/contracts/runtime";
import {
	standardTemplateDefinitionsV1,
	validateRuntimeModelProjectionV4,
} from "@agent-infra/model-catalog";
import {
	type SessionSandboxReserveOperationV1,
	type SessionSandboxResourceIdentityV1,
	sessionSandboxReserveDigestV1,
	transitionExecutorInstanceV2,
} from "@agent-infra/platform-core";
import type { SessionSandboxReserveWorkerClaimV1 } from "@agent-infra/platform-store";
import type { KubernetesObject, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { createProductionSessionSandboxReceiverV1 } from "./conversation-deployment.js";
import {
	workloadDesiredFixture,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-comparison.js";
import {
	createSessionSandboxExecutorReservePreparationAdapterV1,
	createSessionSandboxReserveAdapterV1,
	createSessionSandboxReserveResourceInputV1,
} from "./session-reserve-adapter.js";
import {
	sessionSandboxReserveResourcesV1,
	sessionSandboxResourcesV1,
} from "./session-workload-adapter.js";
import {
	sessionSandboxDeploymentTokenFixture,
	sessionSandboxModelProjectionFixture,
	sessionSandboxRuntimeAuthFixture,
} from "./test-support/session-sandbox-v4.js";
import type { WorkloadRuntimeOptionsV1 } from "./workload-runtime.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";

const executorPolicy = {
	resources: {
		requests: { cpu: "100m", memory: "64Mi" },
		limits: { cpu: "500m", memory: "128Mi" },
	},
};

function fixture(
	driver: "codex" | "claude" | "acp" | "pi" = "codex",
	overrides: {
		readonly policy?: Partial<WorkloadRuntimeOptionsV1["policy"]>;
		readonly connectionDeliveryCurrent?: WorkloadRuntimeOptionsV1["connectionDeliveryCurrent"];
	} = {},
) {
	const deployment = workloadDesiredFixture(
		1,
		"reserve-agent",
		"internal-only",
	);
	const initialProjection = sessionSandboxModelProjectionFixture({
		agentId: deployment.agentId,
		driver,
		configurationRevision: 1,
		imageDigest: deployment.imageDigest,
	});
	const { fingerprint: _fingerprint, ...content } = initialProjection;
	content.standardTemplateBinding = {
		templateId: required(
			standardTemplateDefinitionsV1.find((entry) => entry.driver === driver),
		).templateId,
		imageDigest: content.standardTemplateBinding.imageDigest,
		imageRepository: `registry.example.test/templates/${driver}`,
		driver: content.standardTemplateBinding.driver,
		protocol: content.standardTemplateBinding.protocol,
	};
	const projection = validateRuntimeModelProjectionV4({
		...content,
		fingerprint: createHash("sha256")
			.update(JSON.stringify(content))
			.digest("hex"),
	});
	const policy = {
		...workloadTestPolicy,
		runtimeAuth: sessionSandboxRuntimeAuthFixture,
		...overrides.policy,
	};
	const objects = new Map<string, KubernetesObject>();
	const key = (object: KubernetesObject) =>
		`${object.kind}/${object.metadata?.name}`;
	const create = vi.fn(async (object: KubernetesObject) => {
		const value = {
			...structuredClone(object),
			metadata: { ...object.metadata, uid: randomUUID(), resourceVersion: "1" },
		};
		objects.set(key(value), value);
		return structuredClone(value);
	});
	const remove = vi.fn(async (object: KubernetesObject) => {
		objects.delete(key(object));
		return "acknowledged" as const;
	});
	const client = {
		namespace: policy.namespace,
		read: vi.fn(async (kind: string, name: string) =>
			structuredClone(objects.get(`${kind}/${name}`) ?? null),
		),
		readMetadata: vi.fn(async (kind: string, name: string) => {
			const object = objects.get(`${kind}/${name}`);
			return object
				? {
						apiVersion: object.apiVersion,
						kind: object.kind,
						metadata: structuredClone(object.metadata),
					}
				: null;
		}),
		list: vi.fn(async () => []),
		create,
		replace: vi.fn(async () => {
			throw new Error("must not replace");
		}),
		delete: remove,
		deleteResult: remove,
	} as unknown as WorkerKubernetesClientV1;
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				JSON.stringify({ service: "agent-runtime-host", status: "ok" }),
				{ status: 200 },
			),
	);
	const options = {
		workload: {
			policy,
			client,
			templateModelBindings: [projection.standardTemplateBinding],
			...(overrides.connectionDeliveryCurrent
				? { connectionDeliveryCurrent: overrides.connectionDeliveryCurrent }
				: {}),
		},
		serviceToken: sessionSandboxDeploymentTokenFixture,
		fetch: fetch as typeof globalThis.fetch,
	};
	const claim: SessionSandboxReserveWorkerClaimV1 = {
		sandboxId: randomUUID(),
		sessionId: randomUUID(),
		agentId: deployment.agentId,
		generation: 1,
		resourceFence: 1,
		leaseOwner: "worker",
		deliveryFence: 1,
		expiresAt: new Date(Date.now() + 60000),
		status: "preparing",
		operations: [],
		deployment,
		modelProjection: projection,
		profile: {
			schemaVersion: 1,
			agentId: deployment.agentId,
			configurationRevision: 1,
			digest: "a".repeat(64),
			deploymentDigest: sessionSandboxReserveDigestV1(deployment),
			modelProjectionDigest: sessionSandboxReserveDigestV1(projection),
			environmentDigest: sessionSandboxReserveDigestV1(deployment.env),
			skillsDigest: sessionSandboxReserveDigestV1([]),
			connectionConfigurationVersion: "c1",
			networkPolicyVersion: "n1",
			signingConfigurationVersion: "s1",
			transportConfigurationVersion: "t1",
			storageConfigurationVersion: "v1",
			resources: {
				cpuMillis: 100,
				memoryBytes: 128 * 1024 ** 2,
				storageBytes: 64 * 1024 ** 2,
			},
			policy: {
				namespace: policy.namespace,
				resourceConfigurationHash: workloadResourceConfigurationHashV1(policy),
				configurationRevision: 1,
				workloadRevision: 1,
				managementFence: 1,
				imageDigest: deployment.imageDigest,
			},
		},
	};
	const adapter = createSessionSandboxReserveAdapterV1(options);
	const identity = (
		object: KubernetesObject,
	): SessionSandboxResourceIdentityV1 => ({
		kind: object.kind as SessionSandboxResourceIdentityV1["kind"],
		name: required(required(object.metadata).name),
		namespace: policy.namespace,
		uid: required(required(object.metadata).uid),
		resourceVersion: required(required(object.metadata).resourceVersion),
	});
	const ready = async () => {
		const desired = await adapter.render(claim);
		const observed: KubernetesObject[] = [];
		for (const object of desired) {
			const current = await adapter.create(claim, object);
			observed.push(current);
			(claim.operations as SessionSandboxReserveOperationV1[]).push({
				attemptId: randomUUID(),
				operation: "create",
				kind: object.kind as SessionSandboxReserveOperationV1["kind"],
				name: required(required(current.metadata).name),
				status: "confirmed",
				writeCompletion: "response",
				writer: { owner: "worker", fence: 1 },
				resource: identity(current),
				absent: false,
			});
		}
		const pod = required(
			objects.get(`Pod/sandbox-${claim.sandboxId}`),
		) as V1Pod;
		pod.status = {
			phase: "Running",
			podIP: "10.0.0.1",
			conditions: [{ type: "Ready", status: "True" }],
			containerStatuses: [
				{
					name: "runtime",
					ready: true,
					restartCount: 0,
					image: required(required(required(pod.spec).containers[0]).image),
					imageID: `docker-pullable://${policy.imageRepository}@${deployment.imageDigest}`,
				},
			],
		};
		objects.set(`Endpoints/sandbox-${claim.sandboxId}`, {
			apiVersion: "v1",
			kind: "Endpoints",
			metadata: {
				name: `sandbox-${claim.sandboxId}`,
				namespace: policy.namespace,
				uid: randomUUID(),
				resourceVersion: "1",
			},
			subsets: [
				{
					addresses: [
						{
							ip: "10.0.0.1",
							targetRef: {
								kind: "Pod",
								name: required(pod.metadata).name,
								namespace: policy.namespace,
								uid: required(pod.metadata).uid,
							},
						},
					],
					ports: [{ port: deployment.service.port, protocol: "TCP" }],
				},
			],
		} as KubernetesObject);
		return observed;
	};
	return {
		options,
		claim,
		adapter,
		objects,
		create,
		remove,
		fetch,
		ready,
		identity,
	};
}
describe("Session reserve resource adapter", () => {
	it("uses the deployment pull Secret for reserves and rejects changed references before bootstrap", async () => {
		const f = fixture();
		Object.assign(f.options.workload.policy, {
			imagePullSecretName: "registry-pull",
		});
		const objects = await f.ready();
		const pod = required(
			f.objects.get(`Pod/sandbox-${f.claim.sandboxId}`),
		) as V1Pod;
		const spec = required(pod.spec);
		expect(spec.imagePullSecrets).toEqual([{ name: "registry-pull" }]);
		expect((await f.adapter.bootstrap(f.claim, objects)).bootstrapReady).toBe(
			true,
		);
		for (const changed of [
			[],
			[{ name: "foreign-pull" }],
			[{ name: "registry-pull" }, { name: "registry-pull" }],
		]) {
			spec.imagePullSecrets = changed;
			f.fetch.mockClear();
			await expect(f.adapter.bootstrap(f.claim, objects)).rejects.toMatchObject(
				{ code: "conflict" },
			);
			expect(f.fetch).not.toHaveBeenCalled();
		}
	});

	it("renders the identical six resource contract without a principal or channel", async () => {
		const f = fixture();
		const input = createSessionSandboxReserveResourceInputV1(
			f.options,
			f.claim,
		);
		expect(input).not.toHaveProperty("principal");
		expect(input).not.toHaveProperty("channelId");
		const expected = sessionSandboxResourcesV1({
			...input,
			principal: { kind: "user", id: "real-user" },
			channelId: "web",
		});
		expect(await f.adapter.render(f.claim)).toEqual(expected);
		expect(JSON.stringify(expected)).not.toContain(
			sessionSandboxDeploymentTokenFixture,
		);
		expect(expected).toHaveLength(6);
	});
	it.each(["codex", "claude", "acp", "pi"] as const)(
		"matches the actual normal Session receiver for %s",
		async (driver) => {
			await compareNormalSession(fixture(driver));
		},
	);
	it.each(["claude", "acp", "pi"] as const)(
		"prepares and adopts a %s reserve when independent Codex execution is enabled",
		async (driver) => {
			const f = fixture(driver, {
				policy: { codexSessionExecutor: executorPolicy },
			});
			const resources = await f.ready();
			expect(resources).toHaveLength(6);
			expect(await f.adapter.bootstrap(f.claim, resources)).toEqual({
				bootstrapReady: true,
				businessStateAbsent: true,
			});
			const identities = resources.map(f.identity);
			f.create.mockClear();
			expect(await prepareNormalSession(f, identities)).toEqual({
				status: "ready",
				resources: expect.arrayContaining(identities),
			});
			expect(f.create).not.toHaveBeenCalled();
			await expect(
				f.adapter.remove(
					{ ...f.claim, status: "claimed" },
					f.identity(required(resources[0])),
				),
			).rejects.toMatchObject({ code: "policy" });
			expect(f.remove).not.toHaveBeenCalled();
		},
	);
	it("preserves the verified read-only Skill generation used by normal Sessions", async () => {
		const f = fixture();
		addSkill(f);
		await compareNormalSession(f);
	});
	it("rejects a missing or foreign Skill source PVC before creating a reserve", async () => {
		const f = fixture();
		const key = addSkill(f);
		const source = required(f.objects.get(key));
		f.objects.delete(key);
		await expect(f.adapter.render(f.claim)).rejects.toThrow();
		f.objects.set(key, {
			...source,
			metadata: {
				...source.metadata,
				annotations: { "agent-infra.agora.io/agent-id": "other-agent" },
			},
		});
		await expect(f.adapter.render(f.claim)).rejects.toThrow();
		expect(f.create).not.toHaveBeenCalled();
	});

	it("inspects a ready reserve using a lease-free Store snapshot", async () => {
		const f = fixture();
		const objects = await f.ready();
		const {
			leaseOwner: _owner,
			deliveryFence: _fence,
			...observation
		} = f.claim;
		expect(
			await f.adapter.bootstrap({ ...observation, status: "ready" }, objects),
		).toEqual({ bootstrapReady: true, businessStateAbsent: true });
	});

	it("rejects fake principal/channel and custom or static-secret input before writes", async () => {
		const f = fixture();
		const input = createSessionSandboxReserveResourceInputV1(
			f.options,
			f.claim,
		);
		expect(() =>
			sessionSandboxReserveResourcesV1({
				...input,
				principal: { kind: "user", id: "fake" },
			} as typeof input),
		).toThrow();
		expect(() =>
			sessionSandboxReserveResourcesV1({
				...input,
				channelId: "fake",
			} as typeof input),
		).toThrow();
		expect(() =>
			sessionSandboxReserveResourcesV1({
				...input,
				runtime: { ...required(input.runtime), custom: { secretRefs: [] } },
			}),
		).toThrow();
		await expect(
			f.adapter.render({ ...f.claim, modelProjection: null }),
		).rejects.toThrow();
		await expect(
			f.adapter.render({
				...f.claim,
				modelProjection: {
					...required(f.claim.modelProjection),
					key: "secret",
				} as never,
			}),
		).rejects.toThrow();
		expect(f.create).not.toHaveBeenCalled();
	});
	it("rejects changed image, configuration and deployment digest before writes", async () => {
		const f = fixture("claude", {
			policy: { codexSessionExecutor: executorPolicy },
		});
		for (const profile of [
			{ ...f.claim.profile, deploymentDigest: "b".repeat(64) },
			{
				...f.claim.profile,
				policy: {
					...f.claim.profile.policy,
					configurationRevision:
						f.claim.profile.policy.configurationRevision + 1,
				},
			},
			{
				...f.claim.profile,
				policy: {
					...f.claim.profile.policy,
					imageDigest: `sha256:${"b".repeat(64)}`,
				},
			},
			{ ...f.claim.profile, modelProjectionDigest: "c".repeat(64) },
		])
			await expect(f.adapter.render({ ...f.claim, profile })).rejects.toThrow();
		expect(f.create).not.toHaveBeenCalled();
	});
	it("rejects Codex reserve input when independent execution is enabled, even with a current policy hash", () => {
		const f = fixture("codex", {
			policy: { codexSessionExecutor: executorPolicy },
		});
		expect(() =>
			createSessionSandboxReserveResourceInputV1(f.options, f.claim),
		).toThrow(expect.objectContaining({ code: "policy" }));
	});
	it("rejects a previous layout hash, untrusted template and business subject before reserve writes", async () => {
		const f = fixture("claude", {
			policy: { codexSessionExecutor: executorPolicy },
		});
		const oldLayout = {
			...f.claim,
			profile: {
				...f.claim.profile,
				policy: {
					...f.claim.profile.policy,
					resourceConfigurationHash:
						fixture("claude").claim.profile.policy.resourceConfigurationHash,
				},
			},
		};
		await expect(f.adapter.render(oldLayout)).rejects.toMatchObject({
			code: "policy",
		});
		await expect(
			f.adapter.render({
				...f.claim,
				principal: { kind: "user", id: "foreign-user" },
			} as SessionSandboxReserveWorkerClaimV1),
		).rejects.toMatchObject({ code: "policy" });
		f.options.workload.templateModelBindings.length = 0;
		await expect(f.adapter.render(f.claim)).rejects.toMatchObject({
			code: "policy",
		});
		expect(f.create).not.toHaveBeenCalled();
	});
	it.each(["cpuMillis", "memoryBytes", "storageBytes"] as const)(
		"rejects an approved profile that undercounts actual %s resources",
		async (field) => {
			const f = fixture();
			await expect(
				f.adapter.render({
					...f.claim,
					profile: {
						...f.claim.profile,
						resources: { ...f.claim.profile.resources, [field]: 1 },
					},
				}),
			).rejects.toThrow();
			expect(f.create).not.toHaveBeenCalled();
		},
	);
	it("uses bootstrap health only after six original create responses and exact Pod image", async () => {
		const f = fixture("claude", {
			policy: { codexSessionExecutor: executorPolicy },
		});
		const objects = await f.ready();
		expect(await f.adapter.bootstrap(f.claim, objects)).toEqual({
			bootstrapReady: true,
			businessStateAbsent: true,
		});
		expect(f.fetch).toHaveBeenCalledTimes(1);
		expect(f.fetch.mock.calls[0]?.[0]).toMatch(/\/healthz$/);
		const pending = {
			...f.claim,
			operations: f.claim.operations.map((o, i) =>
				i === 0 ? { ...o, writeCompletion: "pending" as const } : o,
			),
		};
		f.fetch.mockClear();
		expect((await f.adapter.bootstrap(pending, objects)).bootstrapReady).toBe(
			false,
		);
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("rejects foreign UID and wrong endpoint before probing", async () => {
		const f = fixture();
		const objects = await f.ready();
		const endpoints = f.objects.get(
			`Endpoints/sandbox-${f.claim.sandboxId}`,
		) as {
			subsets: {
				addresses: {
					targetRef: {
						uid: string;
					};
				}[];
			}[];
		};
		required(required(endpoints.subsets[0]).addresses[0]).targetRef.uid =
			randomUUID();
		expect((await f.adapter.bootstrap(f.claim, objects)).bootstrapReady).toBe(
			false,
		);
		expect(f.fetch).not.toHaveBeenCalled();
		const pod = required(f.objects.get(`Pod/sandbox-${f.claim.sandboxId}`));
		required(pod.metadata).uid = randomUUID();
		await expect(f.adapter.read(f.claim, "Pod")).rejects.toThrow();
	});
	it.each(["claude", "acp", "pi"] as const)(
		"conditionally deletes the six original %s resources after retirement",
		async (driver) => {
			const f = fixture(driver, {
				policy: { codexSessionExecutor: executorPolicy },
			});
			const objects = await f.ready();
			const retiring = {
				...f.claim,
				status: "retiring" as const,
				deployment: null,
				modelProjection: null,
			};
			for (const object of objects) {
				const identity = f.identity(object);
				await expect(f.adapter.remove(f.claim, identity)).rejects.toThrow();
				const current = required(
					f.objects.get(`${identity.kind}/${identity.name}`),
				);
				required(current.metadata).resourceVersion = "2";
				const currentIdentity = f.identity(current);
				await expect(
					f.adapter.remove(retiring, { ...currentIdentity, uid: randomUUID() }),
				).rejects.toMatchObject({ code: "conflict" });
				await expect(
					f.adapter.remove(retiring, identity),
				).rejects.toMatchObject({
					code: "conflict",
				});
				expect(await f.adapter.remove(retiring, currentIdentity)).toBe(
					"acknowledged",
				);
				expect(f.remove).toHaveBeenLastCalledWith(current);
				expect(await f.adapter.remove(retiring, currentIdentity)).toBe(
					"absent",
				);
			}
			expect(f.remove).toHaveBeenCalledTimes(6);
		},
	);
});

function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null)
		throw new Error("Fixture value missing");
	return value;
}

async function prepareNormalSession(
	f: ReturnType<typeof fixture>,
	resources?: SessionSandboxResourceIdentityV1[],
) {
	const workload: WorkloadRuntimeOptionsV1 = {
		...f.options.workload,
		workerId: "worker-a",
		registry: workloadRegistryFixture(),
		admissionPolicyRef: "policy-a",
		registrySubjectRef: "subject-a",
		decryptor: {
			decrypt: async () => ({
				outcome: "failed",
				code: "SECRET_KEY_UNAVAILABLE",
			}),
		},
		probeRuntime: async () => {
			throw new Error("reserve must not call native readiness");
		},
	};
	const receive = createProductionSessionSandboxReceiverV1(workload, {
		serviceToken: sessionSandboxDeploymentTokenFixture,
	});
	return receive(
		{
			schemaVersion: 1,
			operation: "conversation.sandbox.reconcile.v1",
			execution: null,
			itemId: "fixture-prepare",
			leaseOwner: "worker",
			deliveryFence: 1,
			resourceFence: 1,
			resourceStatus: "applying",
			desiredState: "running",
			authorization: null,
			purpose: "prepare",
			drainComputeAllowed: false,
			lifecycle: null,
			sandbox: {
				schemaVersion: 1,
				agentId: f.claim.agentId,
				sessionId: f.claim.sessionId,
				sandboxId: f.claim.sandboxId,
				generation: 1,
				principal: { kind: "user", id: "fixture-real-principal" },
				channelId: "web",
				resourceName: `sandbox-${f.claim.sandboxId}`,
				workspaceScope: f.claim.sandboxId,
			},
			policy: f.claim.profile.policy,
			deployment: f.claim.deployment,
			modelProjection: f.claim.modelProjection,
			previousObservation: resources ? { status: "observed", resources } : null,
		},
		new AbortController().signal,
	);
}

async function compareNormalSession(f: ReturnType<typeof fixture>) {
	const expected = await f.adapter.render(f.claim);
	await prepareNormalSession(f);
	expect(
		f.create.mock.calls
			.map(([object]) => object)
			.sort((a, b) => String(a.kind).localeCompare(String(b.kind))),
	).toEqual(
		[...expected].sort((a, b) => String(a.kind).localeCompare(String(b.kind))),
	);
}

function addSkill(f: ReturnType<typeof fixture>) {
	const projection = {
		schemaVersion: 1,
		agentId: f.claim.agentId,
		agentVersion: "agent-version-1",
		skillVersion: {
			schemaVersion: 1,
			skillId: "skill-a",
			skillVersionId: "skill-version-a",
			provider: "my_library",
			version: "1.0.0",
			packageObjectVersion: "object-a",
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			signatureDigest: "c".repeat(64),
		},
		manifest: {
			schemaVersion: 1,
			name: "session-notes",
			version: "1.0.0",
			entryPath: "SKILL.md",
			files: [
				{
					path: "SKILL.md",
					sizeBytes: 1,
					sha256: createHash("sha256").update("x").digest("hex"),
				},
			],
			packageDigest: "a".repeat(64),
		},
		targetPath: ".agents/skills/session-notes",
		readOnly: true,
		grant: {
			schemaVersion: 1,
			tools: [],
			connections: [],
			fileRoots: [],
			networkOrigins: [],
			scripts: false,
		},
	};
	const binding = RuntimeSkillHubBindingV1Schema.parse({
		schemaVersion: 1,
		agentId: projection.agentId,
		agentVersion: projection.agentVersion,
		configurationRevision: 1,
		generationId: "e".repeat(64),
		projections: [projection],
		appliedBindings: [
			{
				schemaVersion: 1,
				agentId: projection.agentId,
				agentVersion: projection.agentVersion,
				skillName: projection.manifest.name,
				skillVersion: projection.skillVersion,
				grant: projection.grant,
				configurationRevision: 1,
				syncRevision: 1,
				state: "synced",
				failureReason: null,
				appliedReceipt: {
					schemaVersion: 1,
					agentId: projection.agentId,
					agentVersion: projection.agentVersion,
					skillName: projection.manifest.name,
					configurationRevision: 1,
					syncRevision: 1,
					skillVersionId: projection.skillVersion.skillVersionId,
					generationId: "e".repeat(64),
					packageDigest: projection.skillVersion.packageDigest,
					manifestDigest: projection.skillVersion.manifestDigest,
					targetPath: projection.targetPath,
					readOnly: true,
				},
			},
		],
	});
	const deployment = {
		...required(f.claim.deployment),
		skills: binding.projections,
		skillAppliedBindings: JSON.stringify(binding.appliedBindings),
		skillGenerationId: binding.generationId,
	};
	Object.assign(f.claim, {
		deployment,
		profile: {
			...f.claim.profile,
			deploymentDigest: sessionSandboxReserveDigestV1(deployment),
			skillsDigest: sessionSandboxReserveDigestV1(deployment.skills),
		},
	});
	const owner = workloadResourceNameV1(f.claim.agentId);
	const key = `PersistentVolumeClaim/${owner}-data`;
	f.objects.set(key, {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata: {
			name: `${owner}-data`,
			namespace: f.options.workload.policy.namespace,
			uid: randomUUID(),
			resourceVersion: "1",
			labels: { "agent-infra.agora.io/agent": owner },
			annotations: { "agent-infra.agora.io/agent-id": f.claim.agentId },
		},
	});
	return key;
}

describe("Session reserve Connection delivery (#4157)", () => {
	it.each(["shared", "per-Agent"] as const)(
		"never creates or readies a %s startup Consumer reserve after the Agent is associated",
		async (mode) => {
			const { startPostgresTestDatabase } = await import(
				"../../../packages/platform-store/src/postgres-test.js"
			);
			const { migratePlatformDatabase } = await import(
				"../../../packages/platform-store/src/migrate.js"
			);
			const { PostgresConnectionAssociationSourceV1 } = await import(
				"@agent-infra/platform-store"
			);
			const { createStartupConnectionSelectionGuardV1 } = await import(
				"./connection-registration-bindings.js"
			);
			const { connectionConsumerProfileFingerprintV1 } = await import(
				"@agent-infra/contracts/connection-consumer-profile"
			);
			const {
				createRuntimeConnectionConsumerSnapshotV1,
				runtimeConnectionConsumerAnnotation,
			} = await import("./connection-consumer-projection.js");
			const { default: postgres } = await import("postgres");
			const database = await startPostgresTestDatabase(
				`reserve-connection-${mode === "shared" ? "shared" : "agent"}`,
			);
			const sql = postgres(database.databaseUrl, {
				max: 1,
				onnotice: () => {},
			});
			const source = new PostgresConnectionAssociationSourceV1({
				databaseUrl: database.databaseUrl,
			});
			try {
				await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
				const agentId = "reserve-agent";
				await sql`insert into platform.agents (id) values (${agentId})`;
				const profile = {
					schemaVersion: 1 as const,
					publicOrigin: "https://connection.example.test",
					mcpPath: "/mcp",
					consumerId: "startup-platform-consumer",
					audience: "connection-api",
					egressProfile: { ref: "egress", revision: "r1" },
				};
				const snapshot = createRuntimeConnectionConsumerSnapshotV1(profile, {
					schemaVersion: 1,
					configFingerprint: connectionConsumerProfileFingerprintV1(profile),
					egressEnforced: true,
					source: { ref: "platform-deployment", revision: "r1" },
				});
				if (!snapshot) throw new Error("Missing approved snapshot");
				const policy =
					mode === "shared"
						? {
								connectionConsumerSnapshot: snapshot,
								connectionInstallationRevision: '["startup","r1"]',
							}
						: {
								connectionConsumerSnapshotsByAgent: { [agentId]: snapshot },
								connectionInstallationRevisionsByAgent: {
									[agentId]: '["startup","r1"]',
								},
							};
				// Same production guard as the Worker entry: shared startup selection checks every
				// Agent, a per-Agent startup selection checks its legacy Agents.
				const guard = createStartupConnectionSelectionGuardV1({
					source,
					...(mode === "per-Agent"
						? { startupLegacyAgentIds: new Set([agentId]) }
						: {}),
				});
				const make = (
					current: WorkloadRuntimeOptionsV1["connectionDeliveryCurrent"] = guard,
				) => {
					const f = fixture("codex", {
						policy,
						connectionDeliveryCurrent: current,
					});
					return f;
				};

				// Before association the startup Consumer is still delivered and the reserve is ready.
				const before = make();
				const objects = await before.ready();
				const pod = objects.find((object) => object.kind === "Pod") as V1Pod;
				expect(
					pod.metadata?.annotations?.[runtimeConnectionConsumerAnnotation],
				).toBe(snapshot);
				expect(await before.adapter.bootstrap(before.claim, objects)).toEqual({
					bootstrapReady: true,
					businessStateAbsent: true,
				});

				// The Owner associates the Agent after Worker start.
				await sql`insert into platform.connection_association_generations(agent_id,last_revision) values (${agentId},1)`;
				const after = make();
				expect(await after.adapter.deliverable(after.claim)).toBe(false);
				for (const object of await after.adapter.render(after.claim))
					await expect(
						after.adapter.create(after.claim, object),
					).rejects.toThrow();
				expect(after.create).not.toHaveBeenCalled();
				expect(after.objects.size).toBe(0);
				// The reserve prepared before association is no longer ready ...
				expect(await before.adapter.deliverable(before.claim)).toBe(false);
				expect(await before.adapter.bootstrap(before.claim, objects)).toEqual({
					bootstrapReady: false,
					businessStateAbsent: false,
				});
				// ... but its identity reads and removal keep working.
				expect(await before.adapter.read(before.claim, "Pod")).not.toBeNull();
				const retiring = {
					...before.claim,
					status: "retiring" as const,
					deployment: null,
					modelProjection: null,
				};
				for (const object of objects)
					expect(
						await before.adapter.remove(retiring, before.identity(object)),
					).toBe("acknowledged");
				expect(before.objects.size).toBe(1); // only the fixture Endpoints remain

				// Disconnect keeps the generation row: the startup Consumer stays closed.
				await sql`update platform.connection_association_generations set last_revision=2 where agent_id=${agentId}`;
				const disconnected = make();
				expect(await disconnected.adapter.deliverable(disconnected.claim)).toBe(
					false,
				);

				// A source error fails closed: no write and no readiness.
				const broken = make(async () => {
					throw new Error("source down");
				});
				await expect(
					broken.adapter.deliverable(broken.claim),
				).rejects.toThrow();
				const desired = await broken.adapter.render(broken.claim);
				await expect(
					broken.adapter.create(broken.claim, required(desired[0])),
				).rejects.toThrow();
				expect(broken.create).not.toHaveBeenCalled();
				expect(
					(await broken.adapter.bootstrap(broken.claim, objects))
						.bootstrapReady,
				).toBe(false);

				// Agents without a startup-selected Consumer never consult the source.
				const unselected = fixture("codex", {
					connectionDeliveryCurrent: async () => {
						throw new Error("must not be consulted");
					},
				});
				expect(await unselected.adapter.deliverable(unselected.claim)).toBe(
					true,
				);
				await unselected.ready();
				expect(unselected.create).toHaveBeenCalledTimes(6);
			} finally {
				await source.close();
				await sql.end();
				await database.stop();
			}
		},
		180_000,
	);
});

it("prepares only an approved V2 executor layout at the full resource cost, retaining production Codex rejection (#4248 B3b)", async () => {
	const issuer = generateKeyPairSync("ed25519");
	const imageDigest = `sha256:${"1".repeat(64)}`;
	const f = fixture("codex", {
		policy: {
			codexSessionExecutor: executorPolicy,
			runtimeAuth: {
				...sessionSandboxRuntimeAuthFixture,
				grantPublicKey: issuer.publicKey
					.export({ format: "pem", type: "spki" })
					.toString(),
			},
			executorInstanceStartupApprovals: [
				{
					schemaVersion: 2,
					imageDigest: `registry.example.test/templates/codex@${imageDigest}`,
					verificationRef: "verified-v2-consumer",
				},
			],
		},
	});
	Object.assign(f.claim.profile.resources, {
		cpuMillis: 1000,
		memoryBytes: 512 * 1024 ** 2,
	});
	const adapter = createSessionSandboxExecutorReservePreparationAdapterV1({
		...f.options,
		executorIdentityIssuer: issuer.privateKey,
		executorDrainStartupTimeoutMs: 60000,
	});
	const plan = await adapter.executor!.startup(f.claim);
	expect(plan).not.toBeNull();
	const state = transitionExecutorInstanceV2({
		state: null,
		mutation: plan!,
		authority: {
			namespace: f.claim.profile.policy.namespace,
			podName: `sandbox-${f.claim.sandboxId}`,
			sandboxId: f.claim.sandboxId,
			generation: 1,
			resourceFence: 1,
			configurationRevision: 1,
			imageDigest,
			now: Date.now(),
			hasUnresolvedExecution: false,
			proofVerified: false,
		},
	})!.state;
	Object.assign(f.claim, {
		executorStartup: {
			schemaVersion: 1,
			startupRef: state.startupRef,
			deadlineMs: state.expiresAt,
			writer: { owner: f.claim.leaseOwner, fence: f.claim.deliveryFence },
			instance: state,
			projection: null,
			consumption: null,
		},
	});
	const rendered = await adapter.render(f.claim);
	const pod = rendered.find((r) => r.kind === "Pod") as V1Pod;
	expect(pod.spec?.containers).toHaveLength(2);
	expect(
		pod.spec?.volumes?.find((v) => v.name === "executor-bootstrap")?.secret
			?.secretName,
	).toBe(state.startupRef);
	expect(
		pod.metadata?.annotations?.[
			"agent-infra.agora.io/executor-startup-deadline"
		],
	).toBe(String(state.expiresAt));
	expect(JSON.stringify(rendered)).not.toContain(
		sessionSandboxDeploymentTokenFixture,
	);
	const runner = pod.spec?.containers.find(
		(c) => c.name === "codex-session-executor",
	);
	expect(
		runner?.volumeMounts?.some(
			(v) => v.name === "runtime-secret" || v.name === "executor-identity-host",
		),
	).toBe(false);
	await expect(f.adapter.render(f.claim)).rejects.toMatchObject({
		code: "policy",
	});
	const cost = f.claim.profile.resources.cpuMillis;
	Object.assign(f.claim.profile.resources, { cpuMillis: 100 });
	await expect(adapter.render(f.claim)).rejects.toMatchObject({
		code: "policy",
	});
	Object.assign(f.claim.profile.resources, { cpuMillis: cost });
	Object.assign(f.options.workload.policy, {
		executorInstanceStartupApprovals: [],
	});
	await expect(adapter.render(f.claim)).rejects.toMatchObject({
		code: "policy",
	});
});

async function executorPublicationFixture() {
	const issuer = generateKeyPairSync("ed25519");
	const f = fixture("codex", {
		policy: {
			codexSessionExecutor: executorPolicy,
			runtimeAuth: {
				...sessionSandboxRuntimeAuthFixture,
				grantPublicKey: issuer.publicKey
					.export({ format: "pem", type: "spki" })
					.toString(),
			},
			executorInstanceStartupApprovals: [
				{
					schemaVersion: 2,
					imageDigest: `registry.example.test/templates/codex@${"sha256:" + "1".repeat(64)}`,
					verificationRef: "verified-v2",
				},
			],
		},
	});
	Object.assign(f.claim.profile.resources, {
		cpuMillis: 1000,
		memoryBytes: 512 * 1024 ** 2,
	});
	const adapter = createSessionSandboxExecutorReservePreparationAdapterV1({
		...f.options,
		executorIdentityIssuer: issuer.privateKey,
		executorDrainStartupTimeoutMs: 60000,
	});
	const authority = {
		namespace: f.claim.profile.policy.namespace,
		podName: `sandbox-${f.claim.sandboxId}`,
		sandboxId: f.claim.sandboxId,
		generation: 1,
		resourceFence: 1,
		configurationRevision: 1,
		imageDigest: f.claim.profile.policy.imageDigest,
		now: Date.now(),
		hasUnresolvedExecution: false,
		proofVerified: false,
	};
	let state = required(
		transitionExecutorInstanceV2({
			state: null,
			mutation: required(await adapter.executor!.startup(f.claim)),
			authority,
		}),
	).state;
	const startup = {
		schemaVersion: 1 as const,
		startupRef: state.startupRef,
		deadlineMs: state.expiresAt,
		writer: { owner: f.claim.leaseOwner, fence: f.claim.deliveryFence },
		instance: state,
		projection: null,
		consumption: null,
	};
	Object.assign(f.claim, { executorStartup: startup });
	const resources: KubernetesObject[] = [];
	for (const object of await adapter.render(f.claim)) {
		if (object.kind === "Pod") {
			state = required(
				transitionExecutorInstanceV2({
					state,
					mutation: {
						kind: "pod-create",
						attemptId: state.attemptId,
						revision: state.revision,
					},
					authority,
				}),
			).state;
			Object.assign(startup, { instance: state });
		}
		const current = await adapter.create(f.claim, object);
		resources.push(current);
		(f.claim.operations as SessionSandboxReserveOperationV1[]).push({
			attemptId: randomUUID(),
			operation: "create",
			kind: current.kind as SessionSandboxReserveOperationV1["kind"],
			name: required(current.metadata?.name),
			status: "confirmed",
			writeCompletion: "response",
			writer: startup.writer,
			resource: f.identity(current),
			absent: false,
		});
	}
	const pod = required(resources.find((x) => x.kind === "Pod"));
	state = required(
		transitionExecutorInstanceV2({
			state,
			mutation: {
				kind: "bind",
				attemptId: state.attemptId,
				revision: state.revision,
				podUid: required(pod.metadata?.uid),
				resources: resources
					.filter((x) => x.kind === "Pod" || x.kind === "Service")
					.map((x) => ({
						...f.identity(x),
						kind: x.kind as "Pod" | "Service",
					})),
			},
			authority,
		}),
	).state;
	Object.assign(startup, { instance: state });
	const publication = await adapter.executor!.projection(f.claim, pod);
	state = required(
		transitionExecutorInstanceV2({
			state,
			mutation: {
				kind: "delivery",
				attemptId: state.attemptId,
				revision: state.revision,
				hostPublicKey: publication.intent.hostPublicKey,
				...publication.intent.instanceDelivery!,
			},
			authority,
		}),
	).state;
	Object.assign(startup, {
		instance: state,
		projection: {
			podUid: required(pod.metadata?.uid),
			hostKeyId: publication.intent.hostKeyId,
			hostPublicKey: publication.intent.hostPublicKey,
			bindingDigest: publication.intent.bindingDigest,
			create: {
				attemptId: state.attemptId,
				status: "pending",
				resource: null,
				absent: false,
				writeCompletion: "pending",
				writer: startup.writer,
			},
			deletes: [],
		},
	});
	return { ...f, adapter, publication, resources };
}

it("publishes role-separated V2 inputs only once and deletes only the original projection UID/current RV (#4248 B3b)", async () => {
	const f = await executorPublicationFixture();
	const port = f.adapter.executor!;
	const projection = f.claim.executorStartup!.projection!;
	const material = f.publication
		.resource as import("@kubernetes/client-node").V1Secret;
	expect(Object.keys(material.data!).sort()).toEqual(["host", "runner"]);
	const host = JSON.parse(
		Buffer.from(material.data!.host!, "base64").toString(),
	);
	const runner = JSON.parse(
		Buffer.from(material.data!.runner!, "base64").toString(),
	);
	expect(host.privateKey).not.toBe(runner.privateKey);
	expect(host.statement.instance.recordRef).toBe(
		f.claim.executorStartup!.instance!.recordRef,
	);
	expect(JSON.stringify(material)).not.toContain(
		sessionSandboxDeploymentTokenFixture,
	);
	const created = await port.createProjection(f.claim, material);
	expect(f.create).toHaveBeenCalledTimes(7);
	await expect(port.createProjection(f.claim, material)).rejects.toMatchObject({
		code: "conflict",
	});
	Object.assign(projection.create, {
		status: "confirmed",
		writeCompletion: "response",
		resource: f.identity(created),
	});
	await expect(port.createProjection(f.claim, material)).rejects.toMatchObject({
		code: "conflict",
	});
	const secret = required(f.objects.get(`Secret/${material.metadata!.name}`));
	secret.metadata!.resourceVersion = "2";
	const old = f.identity(created);
	const current = f.identity(secret);
	(projection.deletes as unknown[]).push({
		attemptId: "delete-1",
		status: "pending",
		writeCompletion: "pending",
		resource: old,
		absent: false,
		writer: { owner: f.claim.leaseOwner, fence: f.claim.deliveryFence },
	});
	await expect(port.removeProjection(f.claim, old)).rejects.toMatchObject({
		code: "conflict",
	});
	expect(f.remove).not.toHaveBeenCalled();
	Object.assign(projection.deletes[0]!, { resource: current });
	expect(await port.removeProjection(f.claim, current)).toBe("acknowledged");
	expect(await port.readProjection(f.claim)).toBeNull();
	f.objects.set(`Secret/${material.metadata!.name}`, {
		...created,
		metadata: { ...created.metadata, uid: "replacement-uid" },
	});
	await expect(port.readProjection(f.claim)).rejects.toMatchObject({
		code: "conflict",
	});
	expect(f.remove).toHaveBeenCalledTimes(1);
});

it("rejects foreign role material, subjects, expired starts and unconfirmed creates without publishing (#4248 B3b)", async () => {
	const f = await executorPublicationFixture();
	const port = f.adapter.executor!;
	const material = structuredClone(
		f.publication.resource,
	) as import("@kubernetes/client-node").V1Secret;
	material.data!.host = required(material.data!.runner);
	await expect(port.createProjection(f.claim, material)).rejects.toThrow();
	await expect(
		port.projection(
			{ ...f.claim, principal: { userId: "foreign" } } as typeof f.claim,
			f.resources.find((x) => x.kind === "Pod")!,
		),
	).rejects.toThrow();
	const startup = f.claim.executorStartup!;
	const expired = {
		...f.claim,
		executorStartup: {
			...startup,
			deadlineMs: Date.now() - 1,
			instance: { ...startup.instance!, expiresAt: Date.now() - 1 },
		},
	};
	await expect(
		port.createProjection(expired, f.publication.resource),
	).rejects.toThrow();
	expect(f.create).toHaveBeenCalledTimes(6);
	const response = await f.adapter.bootstrap(f.claim, f.resources);
	expect(response).toMatchObject({
		bootstrapReady: false,
		businessStateAbsent: false,
	});
	expect(f.fetch).not.toHaveBeenCalled();
});

it("bootstraps only from both original containers, fixed checks and fresh pinned Host evidence (#4248 B3b)", async () => {
	const f = await executorPublicationFixture();
	const projection = f.claim.executorStartup!.projection!;
	const material = f.publication
		.resource as import("@kubernetes/client-node").V1Secret;
	const host = JSON.parse(
		Buffer.from(material.data!.host!, "base64").toString(),
	);
	const signingKey = createPrivateKey({
		key: Buffer.from(host.privateKey, "base64url"),
		format: "der",
		type: "pkcs8",
	});
	const created = await f.adapter.executor!.createProjection(f.claim, material);
	Object.assign(projection.create, {
		status: "confirmed",
		writeCompletion: "response",
		resource: f.identity(created),
	});
	f.objects.delete(`Secret/${f.claim.executorStartup!.startupRef}`);
	const pod = f.objects.get(`Pod/sandbox-${f.claim.sandboxId}`) as V1Pod;
	const digest = f.claim.profile.policy.imageDigest;
	pod.status = {
		phase: "Running",
		podIP: "10.0.0.9",
		conditions: [{ type: "Ready", status: "True" }],
		containerStatuses: ["runtime", "codex-session-executor"].map((name) => ({
			name,
			image: digest,
			imageID: `docker-pullable://runtime@${digest}`,
			ready: true,
			restartCount: 0,
			state: { running: { startedAt: new Date() } },
		})),
		initContainerStatuses: [
			{
				name: "codex-session-workspace-init",
				image: digest,
				imageID: `docker-pullable://runtime@${digest}`,
				ready: false,
				restartCount: 0,
				state: { terminated: { exitCode: 0 } },
			},
		],
	};
	const name = pod.metadata!.name!;
	const namespace = pod.metadata!.namespace!;
	const endpoints = {
		apiVersion: "v1",
		kind: "Endpoints",
		metadata: { name, namespace },
		subsets: [
			{
				addresses: [
					{
						ip: pod.status.podIP,
						targetRef: { kind: "Pod", name, namespace, uid: pod.metadata!.uid },
					},
				],
				ports: [{ port: f.claim.deployment!.service.port, protocol: "TCP" }],
			},
		],
	};
	f.objects.set(`Endpoints/${name}`, endpoints);
	let driftDuringRead = false;
	f.fetch.mockImplementation(async (_url, init) => {
		const { authorization, ...request } = JSON.parse(init!.body as string);
		const grant = JSON.parse(
			Buffer.from(authorization.split(".")[1], "base64url").toString(),
		);
		const body = {
			...request,
			requestDigest: grant.requestDigest,
			hostKeyId: projection.hostKeyId,
			runnerEpoch: "123e4567-e89b-42d3-a456-426614174099",
			observedAt: Date.now(),
			expiresAt: Date.now() + 5000,
			checks: {
				hostIdentityConsumed: true,
				runnerIdentityConsumed: true,
				deliveryFilesRemoved: true,
				executorReady: true,
				emptyBusinessState: true,
			},
		};
		const header = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				kid: projection.hostKeyId,
				typ: "session-instance-evidence-v1",
			}),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				...body,
				purpose: "session-instance-evidence-v1",
				audience: request.workerId,
			}),
		).toString("base64url");
		const bytes = `${header}.${payload}`;
		if (driftDuringRead) pod.metadata!.uid = "replacement-pod";
		return new Response(
			JSON.stringify({
				...body,
				signature: `${bytes}.${sign(null, Buffer.from(bytes), signingKey).toString("base64url")}`,
			}),
			{ headers: { "content-type": "application/json" } },
		);
	});
	expect(await f.adapter.bootstrap(f.claim, f.resources)).toMatchObject({
		bootstrapReady: true,
		businessStateAbsent: true,
	});
	for (const mutate of [
		() => {
			pod.status!.containerStatuses![1]!.ready = false;
		},
		() => {
			pod.status!.containerStatuses![1]!.imageID =
				`runtime@sha256:${"f".repeat(64)}`;
		},
		() => {
			pod.status!.containerStatuses![1]!.restartCount = 1;
		},
		() => {
			pod.status!.initContainerStatuses![0]!.state = { running: {} };
		},
		() => {
			endpoints.subsets[0]!.addresses[0]!.targetRef.uid = "foreign-pod";
		},
	]) {
		const originalStatus: V1Pod["status"] = structuredClone(pod.status);
		const originalEndpoint = endpoints.subsets[0]!.addresses[0]!.targetRef.uid;
		mutate();
		expect(await f.adapter.bootstrap(f.claim, f.resources)).toMatchObject({
			bootstrapReady: false,
		});
		pod.status = originalStatus;
		endpoints.subsets[0]!.addresses[0]!.targetRef.uid = originalEndpoint;
	}
	const fetched = f.fetch.mock.calls.length;
	f.objects.set(`Secret/${f.claim.executorStartup!.startupRef}`, created);
	expect(await f.adapter.bootstrap(f.claim, f.resources)).toMatchObject({
		bootstrapReady: false,
	});
	expect(f.fetch).toHaveBeenCalledTimes(fetched);
	f.objects.delete(`Secret/${f.claim.executorStartup!.startupRef}`);
	driftDuringRead = true;
	expect(await f.adapter.bootstrap(f.claim, f.resources)).toMatchObject({
		bootstrapReady: false,
	});
});

it("never mutates a claimed reserve through the preparation seam (#4248 B3b)", async () => {
	const f = await executorPublicationFixture();
	const port = f.adapter.executor!;
	const claimed = { ...f.claim, status: "claimed" as const };
	const resource = f.resources[0]!;
	for (const action of [
		() => f.adapter.create(claimed, resource),
		() => f.adapter.remove(claimed, f.identity(resource)),
		() => port.startup(claimed),
		() => port.projection(claimed, f.resources.find((x) => x.kind === "Pod")!),
		() => port.createProjection(claimed, f.publication.resource),
		() => port.removeProjection(claimed, f.identity(resource)),
	])
		await expect(action()).rejects.toThrow();
	expect(f.create).toHaveBeenCalledTimes(6);
	expect(f.remove).not.toHaveBeenCalled();
});

it("rejects missing V2 approvals at preparation assembly before any lease or write (#4248 B3b)", () => {
	const issuer = generateKeyPairSync("ed25519");
	const f = fixture("codex", {
		policy: {
			codexSessionExecutor: executorPolicy,
			runtimeAuth: {
				...sessionSandboxRuntimeAuthFixture,
				grantPublicKey: issuer.publicKey
					.export({ format: "pem", type: "spki" })
					.toString(),
			},
		},
	});
	expect(() =>
		createSessionSandboxExecutorReservePreparationAdapterV1({
			...f.options,
			executorIdentityIssuer: issuer.privateKey,
			executorDrainStartupTimeoutMs: 60000,
		}),
	).toThrow("WORKER_EXECUTOR_V2_APPROVALS_REQUIRED");
	expect(f.create).not.toHaveBeenCalled();
});
