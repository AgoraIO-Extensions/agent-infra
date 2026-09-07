import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import { RuntimeCapabilitiesResponseV1Schema } from "@agent-infra/contracts/runtime";
import {
	createWorkloadReconciliationV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import {
	runtimeGrantFixture,
	verificationForRuntimeGrant,
} from "../../../packages/agent-runtime/src/grant-fixture.test-support.js";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import {
	fakeKubernetesApi,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import {
	createWorkloadRuntimeV1,
	type WorkloadRuntimeOptionsV1,
} from "./workload-runtime.js";

function fixture(overrides: Partial<WorkloadRuntimeOptionsV1> = {}) {
	const api = fakeKubernetesApi();
	const configuration = {
		schemaVersion: 1 as const,
		actions: [],
		actionSetRevision: "actions-a",
		channels: [],
		channelRevision: "channels-a",
		agentId: "agent-a",
		revision: 1,
		modelConfiguration: null,
		secrets: [],
		environment: [],
		source: {
			kind: "custom" as const,
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admission-a",
			interactionMode: "platform-adapter" as const,
			connectionEnabled: false as const,
		},
	};
	let state: WorkloadReconciliationStateV1 | null = null;
	const options: WorkloadRuntimeOptionsV1 = {
		workerId: "worker-a",
		client: api.client,
		policy: workloadTestPolicy,
		registry: workloadRegistryFixture({
			schemaVersion: 1,
			interactionMode: "platform-adapter",
			protocol: "acp",
			service: { port: 8080 },
			health: { path: "/healthz" },
			capabilities: {
				attachments: true,
				modelSelection: true,
				supplementaryInstruction: true,
			},
		}),
		admissionPolicyRef: "policy-a",
		registrySubjectRef: "subject-a",
		decryptor: {
			decrypt: async () => ({
				outcome: "failed",
				code: "SECRET_KEY_UNAVAILABLE",
			}),
		},
		revisionBinder: {
			bind: async () => ({
				outcome: "failed",
				code: "SECRET_KEY_UNAVAILABLE",
			}),
		},
		fetch: vi.fn(async () => new Response("ok")),
		probeRuntime: async () => ({ core: "passed", capabilities: {} }),
		...overrides,
	};
	return {
		...api,
		options,
		get state() {
			return state;
		},
		async tick(times: number) {
			for (let i = 0; i < times; i++) {
				await createWorkloadReconciliationV1({
					runtime: createWorkloadRuntimeV1(options),
					maximumAttempts: 2,
					store: {
						async runNext(_workerId, step) {
							state = await step({
								state,
								configuration,
								management: {
									schemaVersion: 1,
									agentId: "agent-a",
									applicationId: "application-a",
									applicantId: "owner-a",
									ownerIds: ["owner-a"],
									availability: [],
									decisionReason: null,
									revision: 1,
									workloadRevision: 1,
									fence: 1,
									status: "creating",
									desiredState: "running",
									serviceAvailability: "updating",
									approvalRevision: 1,
									failureCode: null,
								},
								requestId: "request-a",
								traceId: "trace-a",
							});
							return "advanced";
						},
					},
				}).tick("worker-a");
			}
		},
	};
}

describe("assembled Workload Runtime contracts", () => {
	it("requires Worker-only Secret revision binding crypto", () => {
		const f = fixture();
		expect(() =>
			createWorkloadRuntimeV1({
				...f.options,
				revisionBinder: undefined as never,
			}),
		).toThrow("Worker Secret revision binder is required");
	});
	it.each(["NetworkPolicy", "ServiceAccount", "Service"])(
		"repairs a missing %s after readiness without promoting until the replacement is verified",
		async (kind) => {
			const f = fixture();
			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			const resource = [...f.resources.entries()].find(
				([_, object]) => object.kind === kind,
			);
			if (!resource) throw new Error();
			const pvc = [...f.resources.values()].find(
				(object) => object.kind === "PersistentVolumeClaim",
			);
			f.resources.delete(resource[0]);
			await f.tick(1);
			expect(f.state).toMatchObject({ phase: "applying", revision: 2 });
			await f.tick(7);
			expect(f.state?.phase).toBe("ready");
			expect(f.resources.has(resource[0])).toBe(true);
			expect(
				[...f.resources.values()].find(
					(object) => object.kind === "PersistentVolumeClaim",
				)?.metadata?.uid,
			).toBe(pvc?.metadata?.uid);
		},
	);
	it("keeps a core-compatible candidate available when optional capability probing has no valid result", async () => {
		const f = fixture({
			probeRuntime: async () => ({
				core: "passed",
				capabilities: { attachments: "unavailable" },
			}),
		});
		await f.tick(8);
		expect(f.state?.phase).toBe("ready");
		expect(Object.values(f.state?.capabilities ?? {})).toEqual([
			false,
			false,
			false,
			false,
			false,
		]);
	});
	it("uses RuntimeHost Fake HTTP capabilities and persists only the declared intersection across Worker restarts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "workload-runtime-"));
		try {
			const host = await RuntimeHost.open({
				store: await FileRuntimeStore.open(join(directory, "host.json")),
				driver: await FakeRuntimeDriver.open(join(directory, "driver.json")),
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			});
			const app = createRuntimeHostApp({
				host,
				serviceToken: "synthetic-service-proof",
				verifyGrant: verificationForRuntimeGrant,
			});
			const f = fixture({
				fetch: (async (url, init) =>
					app.request(String(url), init)) as typeof fetch,
				async probeRuntime({ agentId, workloadRevision, baseUrl }) {
					const binding = {
						agentId,
						actorId: "worker-a",
						channelId: "web",
						conversationId: "probe",
						executionId: `probe-${workloadRevision}`,
						turnId: "probe",
						sessionGeneration: 1,
						traceId: "trace-a",
					};
					const response = await app.request(
						`${baseUrl}/internal/runtime/v1/capabilities`,
						{
							method: "POST",
							headers: {
								authorization: "Bearer synthetic-service-proof",
								"content-type": "application/json",
							},
							body: JSON.stringify({
								schemaVersion: 1,
								...binding,
								requestId: "probe-a",
								deliveryFence: 1,
								grant: runtimeGrantFixture(binding, ["capabilities.read"]),
							}),
						},
					);
					expect(response.status).toBe(200);
					return {
						core: "passed",
						capabilities: RuntimeCapabilitiesResponseV1Schema.parse(
							await response.json(),
						).capabilities,
					};
				},
			});
			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			expect(f.state?.capabilities).toMatchObject({
				modelSelection: true,
				attachments: true,
				connection: false,
				resultFiles: false,
			});
			expect(
				[...f.resources.values()].filter(
					(resource) => resource.kind === "Ingress",
				),
			).toHaveLength(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("closes and cleans a candidate whose Runtime core probe fails", async () => {
		const f = fixture({
			probeRuntime: async () => ({ core: "failed", capabilities: {} }),
		});
		await f.tick(10);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
	});
	it("removes delayed resource writes even after creation failure was persisted", async () => {
		const f = fixture({
			probeRuntime: async () => ({ core: "failed", capabilities: {} }),
		});
		await f.tick(4);
		const remnants = new Map(f.resources);
		await f.tick(6);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
		for (const [key, object] of remnants) f.resources.set(key, object);
		await f.tick(1);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
	});
	it("cleans the same UID after an uncommitted generation change", async () => {
		const f = fixture({
			probeRuntime: async () => ({ core: "failed", capabilities: {} }),
		});
		await f.tick(5);
		expect(f.state?.phase).toBe("cleaning");
		for (const [key, object] of f.resources) {
			if (object.kind === "StatefulSet" && object.metadata)
				f.resources.set(key, {
					...object,
					metadata: { ...object.metadata, generation: 2 },
				});
		}
		await f.tick(1);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
	});
	it("does not clean a replacement UID or a newer resource revision", async () => {
		for (const metadata of [
			{ uid: "replacement" },
			{ labels: { "agent-infra.agora.io/revision": "2" } },
		]) {
			const f = fixture({
				probeRuntime: async () => ({ core: "failed", capabilities: {} }),
			});
			await f.tick(5);
			for (const [key, object] of f.resources) {
				if (object.kind === "StatefulSet" && object.metadata)
					f.resources.set(key, {
						...object,
						metadata: {
							...object.metadata,
							...metadata,
							labels: { ...object.metadata.labels, ...metadata.labels },
						},
					});
			}
			await f.tick(1);
			expect(f.state?.phase).toBe("cleaning");
			expect(
				[...f.resources.values()].some(
					(object) => object.kind === "StatefulSet",
				),
			).toBe(true);
		}
	});
	it("uses a fixed origin and disables redirects for image-declared health paths", async () => {
		const fetcher = vi.fn(async () => new Response("", { status: 503 }));
		const probe = vi.fn(async () => ({
			core: "passed" as const,
			capabilities: {},
		}));
		const f = fixture({ fetch: fetcher, probeRuntime: probe });
		await f.tick(5);
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringMatching(
				/^http:\/\/agent-[a-f0-9]+-probe\.workload-test\.svc:8080\/healthz$/,
			),
			expect.objectContaining({
				redirect: "error",
				signal: expect.any(AbortSignal),
			}),
		);
		expect(probe).not.toHaveBeenCalled();
		expect(f.state?.phase).toBe("cleaning");
	});
});
