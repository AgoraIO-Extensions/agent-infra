import { randomUUID } from "node:crypto";
import type {
	SessionSandboxReserveConfigurationV1,
	SessionSandboxReserveOperationV1,
	SessionSandboxResourceIdentityV1,
} from "@agent-infra/platform-core";
import type { SessionSandboxReserveWorkerClaimV1 } from "@agent-infra/platform-store";
import type { KubernetesObject } from "@kubernetes/client-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { createPlatformSessionReserveWorkerV1 } from "./session-reserve-worker.js";

const namespace = "reserve-test";
const imageDigest = `sha256:${"a".repeat(64)}`;
const resourceHash = "b".repeat(64);
const resources = { cpuMillis: 1000, memoryBytes: 2048, storageBytes: 4096 };
const configuration: SessionSandboxReserveConfigurationV1 = {
	schemaVersion: 1,
	enabled: true,
	revision: 1,
	namespace,
	totalBudget: { cpuMillis: 8000, memoryBytes: 16384, storageBytes: 32768 },
	resourceCosts: [{ resourceConfigurationHash: resourceHash, resources }],
	maximumReserves: 4,
	maximumConcurrentCreates: 2,
	ttlMs: 60_000,
	cooldownMs: 1000,
	failureBackoffMs: 1000,
	profiles: [
		{
			agentId: "agent",
			templateId: "codex",
			imageDigest,
			resourceConfigurationHash: resourceHash,
			resources,
			storageConfigurationVersion: "storage-1",
			networkPolicyVersion: "network-1",
			signingConfigurationVersion: "signing-1",
			transportConfigurationVersion: "transport-1",
			connectionConfigurationVersion: "connection-1",
			minimum: 1,
			maximum: 3,
		},
	],
};
const kinds = [
	"PersistentVolumeClaim",
	"ServiceAccount",
	"NetworkPolicy",
	"Service",
	"Secret",
	"Pod",
] as const;
const running: ReturnType<typeof createPlatformSessionReserveWorkerV1>[] = [];
afterEach(async () => {
	for (const worker of running.splice(0)) await worker.stop();
	vi.useRealTimers();
});

function fixture(
	options: {
		configuration?: SessionSandboxReserveConfigurationV1;
		status?: SessionSandboxReserveWorkerClaimV1["status"];
		log?: (code: "SESSION_RESERVE_RECONCILE_UNAVAILABLE") => void;
	} = {},
) {
	let now = 10_000;
	const sandboxId = randomUUID();
	const claim: SessionSandboxReserveWorkerClaimV1 = {
		sandboxId,
		sessionId: randomUUID(),
		agentId: "agent",
		generation: 1,
		resourceFence: 1,
		status: options.status ?? "preparing",
		leaseOwner: "worker",
		deliveryFence: 1,
		expiresAt: new Date(now + 60_000),
		operations: [],
		profile: {
			schemaVersion: 1,
			agentId: "agent",
			digest: "c".repeat(64),
			deploymentDigest: "d".repeat(64),
			modelProjectionDigest: "e".repeat(64),
			environmentDigest: "f".repeat(64),
			skillsDigest: "a".repeat(64),
			configurationRevision: 1,
			resources,
			connectionConfigurationVersion: "connection-1",
			networkPolicyVersion: "network-1",
			signingConfigurationVersion: "signing-1",
			transportConfigurationVersion: "transport-1",
			storageConfigurationVersion: "storage-1",
			policy: {
				namespace,
				resourceConfigurationHash: resourceHash,
				configurationRevision: 1,
				workloadRevision: 1,
				managementFence: 1,
				imageDigest,
			},
		},
		deployment: {} as SessionSandboxReserveWorkerClaimV1["deployment"],
		modelProjection:
			{} as SessionSandboxReserveWorkerClaimV1["modelProjection"],
	};
	const row = {
		sandboxId,
		agentId: "agent",
		profileDigest: claim.profile.digest,
		status: claim.status,
		expiresAt: claim.expiresAt,
		createdAt: new Date(now - 100),
		updatedAt: new Date(now - 50),
	};
	const name = `sandbox-${sandboxId}`;
	const objects = new Map<string, KubernetesObject>();
	const desired = kinds.map((kind) => ({
		apiVersion: kind === "NetworkPolicy" ? "networking.k8s.io/v1" : "v1",
		kind,
		metadata: { name, namespace },
	}));
	const calls: string[] = [];
	let leaseCurrent = true;
	let retired = row.status === "retiring";
	const store = {
		applyConfiguration: vi.fn(async () => {}),
		list: vi.fn(async () => [structuredClone(row)]),
		listPage: vi.fn(async () => ({
			items: [structuredClone(row)],
			nextCursor: null,
		})),
		inspect: vi.fn(async () => null),
		statistics: vi.fn(async () => ({
			observedAt: new Date(now),
			windowMs: 60_000,
			profiles: [] as {
				agentId: string;
				profileDigest: string | null;
				currentProfileDigest: string | null;
				newSessionCount: number;
				claimedCount: number;
			}[],
		})),
		prepare: vi.fn(async () => null as string | null),
		claimLease: vi.fn(async () =>
			leaseCurrent
				? structuredClone({
						...claim,
						status: retired ? "retiring" : row.status,
					})
				: null,
		),
		renewLease: vi.fn(async () => leaseCurrent),
		recordIntent: vi.fn(async (_lease, operation) => {
			calls.push(`intent:${operation.operation}:${operation.kind}`);
			if (!leaseCurrent || (operation.operation === "delete" && !retired))
				return false;
			(claim.operations as SessionSandboxReserveOperationV1[]).push({
				...structuredClone(operation),
				writeCompletion: "pending",
				writer: { owner: claim.leaseOwner, fence: claim.deliveryFence },
			});
			return true;
		}),
		recordCreateResponse: vi.fn(async (_lease, input) => {
			calls.push(`response:${input.response}`);
			const operation = claim.operations.find(
				(entry) => entry.attemptId === input.attemptId,
			);
			if (!operation) return false;
			Object.assign(operation, {
				status: input.response === "created" ? "confirmed" : "rejected",
				resource: input.resource,
				writeCompletion: "response",
			});
			return true;
		}),
		recordObservation: vi.fn(async (_lease, resource) => {
			calls.push(`observed:${resource.kind}`);
			return leaseCurrent;
		}),
		recordResult: vi.fn(async (_lease, operation) => {
			calls.push(`result:${operation.operation}:${operation.status}`);
			const previous = claim.operations.find(
				(entry) => entry.attemptId === operation.attemptId,
			);
			if (previous) Object.assign(previous, operation);
			return leaseCurrent;
		}),
		recordDeleteResponse: vi.fn(async (_lease, input) => {
			calls.push(`delete-response:${input.response}`);
			const operation = claim.operations.find(
				(entry) => entry.attemptId === input.attemptId,
			);
			if (!operation) return false;
			Object.assign(operation, {
				status: input.response === "rejected" ? "rejected" : "confirmed",
				absent: input.response === "absent",
				resource: input.resource,
				writeCompletion: "response",
			});
			return true;
		}),
		recordDeleteObservation: vi.fn(async (_lease, input) => {
			calls.push(`delete-observation:${input.attemptId}`);
			const operation = claim.operations.find(
				(entry) => entry.attemptId === input.attemptId,
			);
			if (operation?.writeCompletion !== "response") return false;
			Object.assign(operation, { status: "confirmed", absent: true });
			return leaseCurrent;
		}),
		markReady: vi.fn(async () => {
			calls.push("ready");
			row.status = "ready";
			return leaseCurrent;
		}),
		retire: vi.fn(async () => {
			calls.push("retire");
			if (!leaseCurrent || row.status === "claimed") return false;
			retired = true;
			row.status = "retiring";
			return true;
		}),
		finishRetirement: vi.fn(async () => {
			calls.push("retired");
			return true;
		}),
		close: vi.fn(async () => {
			calls.push("close");
		}),
	};
	const adapter = {
		render: vi.fn(async () => structuredClone(desired)),
		read: vi.fn(async (_claim, kind) =>
			structuredClone(objects.get(kind) ?? null),
		),
		create: vi.fn(async (_claim, object) => {
			calls.push(`create:${object.kind}`);
			const created = {
				...object,
				metadata: {
					...object.metadata,
					uid: `uid-${object.kind}`,
					resourceVersion: "1",
				},
			};
			objects.set(object.kind, created);
			return structuredClone(created);
		}),
		remove: vi.fn(async (_claim, identity) => {
			calls.push(`delete:${identity.kind}`);
			objects.delete(identity.kind);
			return "acknowledged" as const;
		}),
		bootstrap: vi.fn(async () => ({
			bootstrapReady: true,
			businessStateAbsent: true,
		})),
	};
	const worker = createPlatformSessionReserveWorkerV1({
		databaseUrl: "postgres://unused",
		configuration: options.configuration ?? configuration,
		adapter,
		store,
		workerId: "worker",
		pollIntervalMs: 100,
		leaseDurationMs: 3000,
		now: () => now,
		log: options.log,
	});
	running.push(worker);
	return {
		worker,
		store,
		adapter,
		claim,
		row,
		objects,
		desired,
		calls,
		setNow: (time: number) => {
			now = time;
		},
		expireLease: () => {
			leaseCurrent = false;
		},
	};
}

function confirmed(f: ReturnType<typeof fixture>) {
	for (const resource of f.desired) {
		const identity = {
			kind: resource.kind,
			name: resource.metadata.name,
			namespace,
			uid: `uid-${resource.kind}`,
			resourceVersion: "1",
		} satisfies SessionSandboxResourceIdentityV1;
		f.objects.set(resource.kind, {
			...resource,
			metadata: {
				...resource.metadata,
				uid: identity.uid,
				resourceVersion: identity.resourceVersion,
			},
		});
		(f.claim.operations as SessionSandboxReserveOperationV1[]).push({
			attemptId: randomUUID(),
			kind: identity.kind,
			name: identity.name,
			operation: "create",
			status: "confirmed",
			resource: identity,
			absent: false,
			writeCompletion: "response",
			writer: { owner: "worker", fence: 1 },
		});
	}
}

describe("Session reserve Worker", () => {
	it("persists each create intent before sending and prepares Secret before Pod", async () => {
		const f = fixture();
		await f.worker.reconcile();
		expect(f.adapter.create).toHaveBeenCalledTimes(6);
		for (const kind of kinds)
			expect(f.calls.indexOf(`intent:create:${kind}`)).toBeLessThan(
				f.calls.indexOf(`create:${kind}`),
			);
		expect(f.calls.indexOf("create:Secret")).toBeLessThan(
			f.calls.indexOf("create:Pod"),
		);
		expect(f.store.recordCreateResponse).toHaveBeenCalledTimes(6);
		expect(f.store.markReady).toHaveBeenCalledOnce();
		expect(f.store.applyConfiguration).toHaveBeenCalledOnce();
	});

	it("uses current-profile demand statistics to refill up to the bounded concurrency", async () => {
		const f = fixture();
		f.store.statistics.mockResolvedValue({
			observedAt: new Date(),
			windowMs: 60_000,
			profiles: [
				{
					agentId: "agent",
					profileDigest: f.claim.profile.digest,
					currentProfileDigest: f.claim.profile.digest,
					newSessionCount: 3,
					claimedCount: 0,
				},
			],
		});
		f.store.prepare.mockResolvedValue("next-reserve");
		await f.worker.reconcile();
		expect(f.store.statistics).toHaveBeenCalledWith({ windowMs: 60_000 });
		expect(f.store.prepare).toHaveBeenCalledTimes(2);
	});

	it("never resends a create with an unknown response or upgrades observation into completion", async () => {
		const f = fixture({ status: "unknown" });
		const resource = {
			kind: "PersistentVolumeClaim",
			name: `sandbox-${f.claim.sandboxId}`,
			namespace,
			uid: "observed-pvc",
			resourceVersion: "2",
		} as const;
		(f.claim.operations as SessionSandboxReserveOperationV1[]).push({
			attemptId: "unknown-create",
			operation: "create",
			kind: "PersistentVolumeClaim",
			name: resource.name,
			status: "unknown",
			resource: null,
			absent: false,
			writeCompletion: "pending",
			writer: { owner: "old-worker", fence: 1 },
		});
		f.objects.set("PersistentVolumeClaim", {
			kind: "PersistentVolumeClaim",
			metadata: resource,
		});
		await f.worker.reconcile();
		expect(f.adapter.create).not.toHaveBeenCalled();
		expect(f.store.recordCreateResponse).not.toHaveBeenCalled();
		expect(f.store.recordObservation).toHaveBeenCalledWith(
			expect.anything(),
			resource,
		);
		expect(f.store.markReady).not.toHaveBeenCalled();
	});

	it("observes an unknown Pod even when earlier resources already have confirmed responses", async () => {
		const f = fixture({ status: "unknown" });
		confirmed(f);
		const pod = f.claim.operations.find(
			(operation) => operation.kind === "Pod",
		);
		if (!pod) throw new Error("Pod fixture missing");
		Object.assign(pod, {
			status: "unknown",
			resource: null,
			writeCompletion: "pending",
		});
		await f.worker.reconcile();
		expect(f.store.recordObservation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: "Pod" }),
		);
		expect(f.adapter.create).not.toHaveBeenCalled();
		expect(f.store.markReady).not.toHaveBeenCalled();
		expect(f.store.finishRetirement).not.toHaveBeenCalled();
	});

	it("retires settled unknown writes instead of silently promoting the uncertain reserve", async () => {
		const f = fixture({ status: "unknown" });
		confirmed(f);
		await f.worker.reconcile();
		expect(f.store.retire).toHaveBeenCalledOnce();
		expect(f.store.markReady).not.toHaveBeenCalled();
		expect(f.adapter.create).not.toHaveBeenCalled();
	});

	it("records readiness resource versions from readback rather than the original create response", async () => {
		const f = fixture();
		f.adapter.bootstrap.mockImplementation(async () => {
			for (const object of f.objects.values())
				Object.assign(object.metadata ?? {}, {
					resourceVersion: "ready-version",
				});
			return { bootstrapReady: true, businessStateAbsent: true };
		});
		await f.worker.reconcile();
		expect(f.store.markReady).toHaveBeenCalledOnce();
		for (const kind of kinds)
			expect(f.store.recordObservation).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ kind, resourceVersion: "ready-version" }),
			);
	});

	it("does not send resources when lease renewal fails", async () => {
		const f = fixture();
		f.store.renewLease.mockResolvedValue(false);
		await f.worker.reconcile();
		expect(f.adapter.create).not.toHaveBeenCalled();
		expect(f.adapter.remove).not.toHaveBeenCalled();
		expect(f.store.markReady).not.toHaveBeenCalled();
	});

	it("records a lost create as unknown and does not create the remaining objects", async () => {
		const f = fixture();
		f.adapter.create.mockRejectedValueOnce(
			new WorkloadKubernetesError("unavailable"),
		);
		await f.worker.reconcile();
		expect(f.adapter.create).toHaveBeenCalledOnce();
		expect(f.store.recordResult).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ operation: "create", status: "unknown" }),
		);
		expect(f.store.recordCreateResponse).not.toHaveBeenCalled();
		expect(f.store.markReady).not.toHaveBeenCalled();
	});

	it("retires definite admission rejection and keeps raw errors out of diagnostics", async () => {
		const f = fixture();
		f.adapter.create.mockRejectedValueOnce(
			new WorkloadKubernetesError("unavailable", {
				status: 403,
				verb: "create",
				kind: "PersistentVolumeClaim",
			}),
		);
		await f.worker.reconcile();
		expect(f.store.recordCreateResponse).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ response: "rejected", resource: null }),
		);
		expect(f.store.retire).toHaveBeenCalledOnce();
	});

	it("persists a retiring intent before conditional deletion and verifies absence", async () => {
		const f = fixture({ status: "retiring" });
		confirmed(f);
		await f.worker.reconcile();
		expect(f.adapter.remove).toHaveBeenCalledTimes(6);
		for (const kind of kinds)
			expect(f.calls.indexOf(`intent:delete:${kind}`)).toBeLessThan(
				f.calls.indexOf(`delete:${kind}`),
			);
		expect(f.store.recordDeleteResponse).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ response: "acknowledged" }),
		);
		expect(f.store.recordDeleteObservation).toHaveBeenCalled();
		expect(f.store.finishRetirement).toHaveBeenCalledOnce();
	});

	it("does not delete a claimed reserve from a stale list", async () => {
		const disabled = { ...configuration, enabled: false };
		const f = fixture({ configuration: disabled, status: "claimed" });
		confirmed(f);
		f.store.claimLease.mockResolvedValue(null);
		f.store.retire.mockResolvedValue(false);
		await f.worker.reconcile();
		expect(f.adapter.remove).not.toHaveBeenCalled();
		expect(f.store.prepare).not.toHaveBeenCalled();
	});

	it("does not release a retiring reserve while an old create may still complete", async () => {
		const f = fixture({ status: "retiring" });
		(f.claim.operations as SessionSandboxReserveOperationV1[]).push({
			attemptId: "late",
			operation: "create",
			kind: "Pod",
			name: `sandbox-${f.claim.sandboxId}`,
			status: "unknown",
			resource: null,
			absent: false,
			writeCompletion: "pending",
			writer: { owner: "old-worker", fence: 1 },
		});
		await f.worker.reconcile();
		expect(f.store.finishRetirement).not.toHaveBeenCalled();
		expect(f.adapter.create).not.toHaveBeenCalled();
	});

	it("coalesces overlapping reconciles and waits for its create response on shutdown", async () => {
		const f = fixture();
		const pending = Promise.withResolvers<KubernetesObject>();
		f.adapter.create.mockImplementationOnce(() => pending.promise);
		const first = f.worker.reconcile();
		await vi.waitFor(() => expect(f.adapter.create).toHaveBeenCalledOnce());
		const second = f.worker.reconcile();
		const stopping = f.worker.stop();
		expect(f.store.close).not.toHaveBeenCalled();
		pending.resolve({
			...f.desired[0],
			metadata: {
				...f.desired[0]?.metadata,
				uid: "late-pvc",
				resourceVersion: "1",
			},
		});
		await Promise.all([first, second, stopping]);
		expect(f.adapter.create).toHaveBeenCalledOnce();
		expect(f.store.recordCreateResponse).toHaveBeenCalledOnce();
		expect(f.store.close).toHaveBeenCalledOnce();
		expect(f.store.markReady).not.toHaveBeenCalled();
	});

	it("does not delete a different current UID while retiring", async () => {
		const f = fixture({ status: "retiring" });
		confirmed(f);
		const pod = f.objects.get("Pod");
		if (!pod?.metadata) throw new Error("Pod fixture missing");
		pod.metadata.uid = "replacement-owned-by-another-attempt";
		await f.worker.reconcile();
		expect(f.adapter.remove).not.toHaveBeenCalled();
		expect(f.store.finishRetirement).not.toHaveBeenCalled();
	});

	it("keeps delete uncertainty until a terminal DELETE response", async () => {
		const f = fixture({ status: "retiring" });
		confirmed(f);
		f.adapter.remove.mockImplementationOnce(async (_claim, resource) => {
			f.objects.delete(resource.kind);
			throw new WorkloadKubernetesError("unavailable");
		});
		await f.worker.reconcile();
		expect(f.store.recordResult).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				operation: "delete",
				kind: "Pod",
				status: "unknown",
				absent: false,
			}),
		);
		expect(f.store.finishRetirement).not.toHaveBeenCalled();
		f.setNow(11_001);
		await f.worker.reconcile();
		expect(f.store.recordDeleteObservation).not.toHaveBeenCalled();
		expect(
			f.adapter.remove.mock.calls.filter(
				([, resource]) => resource.kind === "Pod",
			),
		).toHaveLength(1);
		expect(f.store.finishRetirement).not.toHaveBeenCalled();
	});

	it("records a DELETE rejection and retries the same UID with a refreshed version", async () => {
		const f = fixture({ status: "retiring" });
		confirmed(f);
		let rejected = true;
		let acknowledged = false;
		f.adapter.remove.mockImplementation(async (_claim, resource) => {
			if (resource.kind === "Pod" && rejected) {
				rejected = false;
				throw new WorkloadKubernetesError("conflict", {
					status: 409,
					verb: "delete",
					kind: "Pod",
				});
			}
			if (resource.kind === "Pod" && !acknowledged) {
				acknowledged = true;
				return "acknowledged" as const;
			}
			f.objects.delete(resource.kind);
			return "acknowledged" as const;
		});
		await f.worker.reconcile();
		expect(f.store.recordDeleteResponse).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ response: "rejected" }),
		);
		const pod = f.objects.get("Pod");
		if (!pod?.metadata) throw new Error("Pod fixture missing");
		pod.metadata.resourceVersion = "2";
		f.setNow(12_001);
		await f.worker.reconcile();
		expect(
			f.adapter.remove.mock.calls.filter(
				([, resource]) => resource.kind === "Pod",
			),
		).toHaveLength(2);
		expect(f.store.recordDeleteResponse).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ response: "acknowledged" }),
		);
		f.objects.delete("Pod");
		f.setNow(13_001);
		await f.worker.reconcile();
		expect(f.store.recordDeleteObservation).toHaveBeenCalled();
	});

	it("persists a successful DELETE response even when lease renewal is lost afterward", async () => {
		const f = fixture({ status: "retiring" });
		confirmed(f);
		f.adapter.remove.mockImplementationOnce(async (_claim, resource) => {
			f.objects.delete(resource.kind);
			f.expireLease();
			return "acknowledged" as const;
		});
		await f.worker.reconcile();
		expect(f.store.recordDeleteResponse).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ response: "acknowledged" }),
		);
	});

	it("does not resend a DELETE whose intent is still pending after a crash", async () => {
		const f = fixture({ status: "retiring" });
		confirmed(f);
		const pod = f.claim.operations.find(
			(operation) =>
				operation.operation === "create" && operation.kind === "Pod",
		);
		if (!pod?.resource) throw new Error("Pod fixture missing");
		(f.claim.operations as SessionSandboxReserveOperationV1[]).push({
			attemptId: "pending-delete",
			operation: "delete",
			kind: "Pod",
			name: pod.resource.name,
			status: "pending",
			resource: pod.resource,
			absent: false,
			writeCompletion: "pending",
			writer: { owner: "old-worker", fence: 1 },
		});
		await f.worker.reconcile();
		expect(f.adapter.remove).not.toHaveBeenCalled();
		expect(f.store.finishRetirement).not.toHaveBeenCalled();
	});

	it("records an original late create response after lease loss without sending another create", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const response = Promise.withResolvers<KubernetesObject>();
		f.adapter.create.mockImplementationOnce(() => response.promise);
		const pending = f.worker.reconcile();
		await vi.waitFor(() => expect(f.adapter.create).toHaveBeenCalledOnce());
		f.expireLease();
		await vi.advanceTimersByTimeAsync(1000);
		response.resolve({
			...f.desired[0],
			metadata: {
				...f.desired[0]?.metadata,
				uid: "late-owned-pvc",
				resourceVersion: "1",
			},
		});
		await pending;
		expect(f.store.recordCreateResponse).toHaveBeenCalledOnce();
		expect(f.adapter.create).toHaveBeenCalledOnce();
		expect(f.store.markReady).not.toHaveBeenCalled();
	});

	it("does not mark bootstrap-only readiness when the adapter reports business state", async () => {
		const f = fixture();
		f.adapter.bootstrap.mockResolvedValue({
			bootstrapReady: true,
			businessStateAbsent: false,
		});
		await f.worker.reconcile();
		expect(f.store.markReady).not.toHaveBeenCalled();
	});

	it("uses bounded diagnostic codes only", async () => {
		const log = vi.fn();
		const f = fixture({ log });
		f.adapter.render.mockRejectedValue(
			new Error("private credential and provider response"),
		);
		await f.worker.reconcile();
		expect(log.mock.calls).toEqual([["SESSION_RESERVE_RECONCILE_UNAVAILABLE"]]);
	});

	it("backs off unavailable replenishment and does not create from repeated empty-list polls", async () => {
		const f = fixture();
		f.store.list.mockResolvedValue([]);
		await f.worker.reconcile();
		await f.worker.reconcile();
		expect(f.store.prepare).toHaveBeenCalledOnce();
		f.setNow(11_001);
		await f.worker.reconcile();
		expect(f.store.prepare).toHaveBeenCalledTimes(2);
	});

	it("backs off failed profiles without hiding the failed attempt or using private error text", async () => {
		const f = fixture();
		f.store.list.mockResolvedValue([]);
		f.store.prepare.mockRejectedValue(new Error("private database credential"));
		await f.worker.reconcile();
		await f.worker.reconcile();
		expect(f.store.prepare).toHaveBeenCalledOnce();
		f.setNow(11_001);
		await f.worker.reconcile();
		expect(f.store.prepare).toHaveBeenCalledTimes(2);
	});
});
