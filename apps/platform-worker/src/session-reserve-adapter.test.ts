import { createHash, randomUUID } from "node:crypto";
import { RuntimeSkillHubBindingV1Schema } from "@agent-infra/contracts/runtime";
import { validateRuntimeModelProjectionV4 } from "@agent-infra/model-catalog";
import {
	type SessionSandboxReserveOperationV1,
	type SessionSandboxResourceIdentityV1,
	sessionSandboxReserveDigestV1,
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

function fixture(driver: "codex" | "claude" | "acp" | "pi" = "codex") {
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
		templateId: content.standardTemplateBinding.templateId,
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
		const f = fixture();
		for (const profile of [
			{ ...f.claim.profile, deploymentDigest: "b".repeat(64) },
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
		const f = fixture();
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
		expect((await f.adapter.bootstrap(pending, objects)).bootstrapReady).toBe(
			false,
		);
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
	it("requires retiring state and original UID/current RV for conditional deletion", async () => {
		const f = fixture();
		const objects = await f.ready();
		const identity = f.identity(required(objects[0]));
		await expect(f.adapter.remove(f.claim, identity)).rejects.toThrow();
		const retiring = {
			...f.claim,
			status: "retiring" as const,
			deployment: null,
			modelProjection: null,
		};
		await expect(
			f.adapter.remove(retiring, { ...identity, uid: randomUUID() }),
		).rejects.toThrow();
		expect(await f.adapter.remove(retiring, identity)).toBe("acknowledged");
		expect(await f.adapter.remove(retiring, identity)).toBe("absent");
		await expect(
			f.adapter.remove({ ...retiring, status: "claimed" }, identity),
		).rejects.toThrow();
	});
});

function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null)
		throw new Error("Fixture value missing");
	return value;
}

async function compareNormalSession(f: ReturnType<typeof fixture>) {
	const expected = await f.adapter.render(f.claim);
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
	await receive(
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
			previousObservation: null,
		},
		new AbortController().signal,
	);
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
