import { describe, expect, it, vi } from "vitest";
import type { AgentConfigurationRecordV1 } from "./agent-configuration.js";
import type { AgentManagementStateV1 } from "./agent-management.js";
import {
	createWorkloadReconciliationV1,
	type WorkloadReconciliationStateV1,
	type WorkloadRuntimePortV1,
} from "./workload-reconciliation.js";

function fixture() {
	let configuration = {
		schemaVersion: 1,
		agentId: "agent-a",
		revision: 1,
		source: { kind: "standard", imageDigest: "image-a" },
	} as AgentConfigurationRecordV1;
	let management = {
		agentId: "agent-a",
		workloadRevision: 1,
		fence: 41,
		desiredState: "running",
		status: "creating",
	} as AgentManagementStateV1;
	let state: WorkloadReconciliationStateV1 | null = null;
	const runtime: WorkloadRuntimePortV1 = {
		capabilities: async () => ({}),
		preflight: vi.fn(async (_input, current) => ({
			...current.candidate,
			deployment: { admitted: true },
		})),
		closeRoute: vi.fn(async () => undefined),
		apply: vi.fn(async () => ({ uid: "uid-a", generation: 1 })),
		observe: vi.fn(async () => "healthy" as const),
		activateSecrets: vi.fn(async () => "active" as const),
		promote: vi.fn(async () => undefined),
		discardUnactivatedSecrets: vi.fn(async () => true),
		cleanup: vi.fn(async () => true),
	};
	const store = {
		async runNext(
			_workerId: string,
			step: Parameters<
				Parameters<typeof createWorkloadReconciliationV1>[0]["store"]["runNext"]
			>[1],
		) {
			state = await step({
				configuration,
				management,
				state: structuredClone(state),
				requestId: "request-a",
				traceId: "trace-a",
			});
			return "advanced" as const;
		},
	};
	let worker = createWorkloadReconciliationV1({
		store,
		runtime,
		maximumAttempts: 3,
	});
	return {
		runtime,
		get state() {
			return state;
		},
		async tick(times = 1) {
			for (let i = 0; i < times; i++) await worker.tick("worker-a");
		},
		restart() {
			worker = createWorkloadReconciliationV1({
				store,
				runtime,
				maximumAttempts: 3,
			});
		},
		upgrade(image: string) {
			configuration = {
				...configuration,
				revision: configuration.revision + 1,
				source: { ...configuration.source, imageDigest: image },
			};
		},
		stop(disabled = false) {
			management = {
				...management,
				workloadRevision: management.workloadRevision + 1,
				fence: management.fence + 1,
				desiredState: "stopped",
				status: disabled ? "disabled" : "stopped",
			};
		},
		start() {
			management = {
				...management,
				workloadRevision: management.workloadRevision + 1,
				fence: management.fence + 1,
				desiredState: "running",
				status: "available",
			};
		},
	};
}

describe("durable Workload reconciliation", () => {
	it("keeps the management fence independent from local Workload revisions", async () => {
		const f = fixture();
		await f.tick();
		expect(f.state).toMatchObject({ revision: 1, fence: 41 });

		await f.tick(6);
		f.upgrade("image-b");
		await f.tick();
		expect(f.state).toMatchObject({ revision: 2, fence: 41 });

		f.stop();
		await f.tick();
		expect(f.state).toMatchObject({ revision: 3, fence: 42 });
	});

	it("repairs the verified route after rejection and reapplies it if its workload is lost", async () => {
		const f = fixture();
		await f.tick(7);
		f.upgrade("image-c");
		vi.mocked(f.runtime.preflight).mockRejectedValueOnce(
			new Error("invalid manifest"),
		);
		await f.tick(2);
		expect(f.state?.phase).toBe("rejected");
		vi.mocked(f.runtime.promote).mockClear();
		await f.tick();
		expect(f.runtime.promote).toHaveBeenCalledOnce();
		vi.mocked(f.runtime.observe).mockResolvedValueOnce("pending");
		await f.tick();
		expect(f.state).toMatchObject({ phase: "closing", revision: 3 });
		await f.tick(5);
		expect(f.state?.phase).toBe("ready");
		expect(f.state?.verified?.configuration.source.imageDigest).toBe("image-a");
		expect(f.runtime.cleanup).not.toHaveBeenCalled();
	});
	it("rejects invalid C without mutating verified B and restarts B after rejection", async () => {
		const f = fixture();
		await f.tick(7);
		f.upgrade("image-b");
		await f.tick(7);
		vi.mocked(f.runtime.apply).mockClear();
		vi.mocked(f.runtime.closeRoute).mockClear();
		f.upgrade("image-c");
		vi.mocked(f.runtime.preflight).mockRejectedValueOnce(
			new Error("invalid manifest"),
		);
		await f.tick(3);
		expect(f.state).toMatchObject({
			phase: "rejected",
			failureCode: "reconciliation_failed",
		});
		expect(f.runtime.apply).not.toHaveBeenCalled();
		expect(f.runtime.closeRoute).not.toHaveBeenCalled();
		f.stop();
		await f.tick(3);
		f.start();
		await f.tick(7);
		expect(f.state?.verified?.configuration.source.imageDigest).toBe("image-b");
	});
	it("creates and promotes only after observation and Secret activation, surviving every restart", async () => {
		const f = fixture();
		for (let i = 0; i < 8; i++) {
			await f.tick();
			f.restart();
		}
		expect(f.state?.phase).toBe("ready");
		expect(f.state?.verified?.configuration.source.imageDigest).toBe("image-a");
		expect(
			vi.mocked(f.runtime.observe).mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(f.runtime.activateSecrets).mock.invocationCallOrder[0] ?? 0,
		);
		expect(
			vi.mocked(f.runtime.activateSecrets).mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(f.runtime.promote).mock.invocationCallOrder[0] ?? 0,
		);
	});
	it("upgrades A to B, rolls failed C back to B as a new revision, and retains the volume", async () => {
		const f = fixture();
		await f.tick(8);
		f.upgrade("image-b");
		await f.tick(8);
		expect(f.state?.verified?.configuration.source.imageDigest).toBe("image-b");
		f.upgrade("image-c");
		vi.mocked(f.runtime.observe).mockImplementation(async (state) =>
			state.candidate.configuration.source.imageDigest === "image-c"
				? "unhealthy"
				: "healthy",
		);
		await f.tick(12);
		expect(f.state).toMatchObject({
			phase: "ready",
			rollback: true,
			revision: 4,
			failureCode: "health_check_failed",
		});
		expect(f.state?.candidate.configuration.source.imageDigest).toBe("image-b");
		expect(
			vi
				.mocked(f.runtime.promote)
				.mock.calls.some(
					([state]) =>
						state.candidate.configuration.source.imageDigest === "image-c",
				),
		).toBe(false);
		expect(f.runtime.cleanup).not.toHaveBeenCalled();
	});
	it("retries unactivated Secret discard before switching to the verified rollback", async () => {
		const f = fixture();
		await f.tick(7);
		f.upgrade("image-c");
		vi.mocked(f.runtime.observe).mockImplementation(async (state) =>
			state.candidate.configuration.source.imageDigest === "image-c"
				? "unhealthy"
				: "healthy",
		);
		vi.mocked(f.runtime.discardUnactivatedSecrets).mockResolvedValueOnce(false);
		await f.tick(5);
		expect(f.state?.phase).toBe("cleaning");
		vi.mocked(f.runtime.closeRoute).mockClear();
		vi.mocked(f.runtime.discardUnactivatedSecrets).mockClear();

		await f.tick();
		expect(f.state?.phase).toBe("cleaning");
		expect(f.runtime.closeRoute).toHaveBeenCalledOnce();
		expect(f.runtime.discardUnactivatedSecrets).toHaveBeenCalledOnce();
		expect(
			vi.mocked(f.runtime.closeRoute).mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(f.runtime.discardUnactivatedSecrets).mock
				.invocationCallOrder[0] ?? 0,
		);
		expect(f.runtime.cleanup).not.toHaveBeenCalled();

		await f.tick();
		expect(f.state).toMatchObject({
			phase: "applying",
			rollback: true,
			revision: 3,
			candidate: { configuration: { source: { imageDigest: "image-a" } } },
		});
		expect(f.runtime.discardUnactivatedSecrets).toHaveBeenCalledTimes(2);
		expect(f.runtime.cleanup).not.toHaveBeenCalled();
	});
	it.each(["stop", "disable", "restart", "configuration"] as const)(
		"preserves candidate cleanup across %s and process restart",
		async (command) => {
			for (const failure of ["pending", "throw"] as const) {
				const f = fixture();
				await f.tick(7);
				f.upgrade("image-c");
				vi.mocked(f.runtime.observe).mockResolvedValue("unhealthy");
				await f.tick(5);
				expect(f.state?.phase).toBe("cleaning");
				const candidate = structuredClone(f.state?.candidate);
				const identity = structuredClone(f.state?.identity);
				const revision = f.state?.revision;
				if (!revision) throw new Error();
				if (command === "stop") f.stop();
				else if (command === "disable") f.stop(true);
				else if (command === "restart") f.start();
				else f.upgrade("image-d");
				const fence = command === "configuration" ? 41 : 42;
				await f.tick();
				expect(f.state).toMatchObject({
					phase: "cleaning",
					cleanupInterrupted: true,
					candidate,
					identity,
					revision,
					fence,
				});
				expect(vi.mocked(f.runtime.closeRoute).mock.lastCall?.[0].fence).toBe(
					fence,
				);
				f.restart();
				if (failure === "pending")
					vi.mocked(f.runtime.discardUnactivatedSecrets).mockResolvedValueOnce(
						false,
					);
				else
					vi.mocked(f.runtime.discardUnactivatedSecrets).mockRejectedValueOnce(
						new Error("synthetic pending cleanup"),
					);
				await f.tick();
				expect(f.state).toMatchObject({
					phase: "cleaning",
					cleanupInterrupted: true,
					candidate,
					identity,
					revision,
					fence,
				});
				expect(
					vi.mocked(f.runtime.discardUnactivatedSecrets).mock.lastCall?.[0],
				).toMatchObject({ candidate, identity, fence });
				expect(f.runtime.cleanup).not.toHaveBeenCalled();
				f.restart();
				await f.tick();
				expect(f.state).toMatchObject({
					phase:
						command === "stop" || command === "disable"
							? "closing"
							: "preflight",
					revision: revision + 1,
					fence,
				});
				expect(f.state).not.toHaveProperty("cleanupInterrupted");
				expect(f.state?.candidate.configuration.source.imageDigest).toBe(
					command === "configuration" ? "image-d" : "image-c",
				);
				expect(f.runtime.discardUnactivatedSecrets).toHaveBeenCalledTimes(2);
			}
		},
	);

	it.each(["stop", "disable", "restart", "configuration"] as const)(
		"preserves initial candidate cleanup across %s and process restart",
		async (command) => {
			for (const failure of ["pending", "throw"] as const) {
				const f = fixture();
				vi.mocked(f.runtime.observe).mockResolvedValue("unhealthy");
				await f.tick(5);
				expect(f.state?.phase).toBe("cleaning");
				const candidate = structuredClone(f.state?.candidate);
				const identity = structuredClone(f.state?.identity);
				const revision = f.state?.revision;
				if (!revision) throw new Error();
				if (command === "stop") f.stop();
				else if (command === "disable") f.stop(true);
				else if (command === "restart") f.start();
				else f.upgrade("image-d");
				const fence = command === "configuration" ? 41 : 42;
				await f.tick();
				expect(f.state).toMatchObject({
					phase: "cleaning",
					cleanupInterrupted: true,
					candidate,
					identity,
					revision,
					fence,
				});
				expect(vi.mocked(f.runtime.closeRoute).mock.lastCall?.[0].fence).toBe(
					fence,
				);
				f.restart();
				if (failure === "pending")
					vi.mocked(f.runtime.cleanup).mockResolvedValueOnce(false);
				else
					vi.mocked(f.runtime.cleanup).mockRejectedValueOnce(
						new Error("synthetic pending cleanup"),
					);
				await f.tick();
				expect(f.state).toMatchObject({
					phase: "cleaning",
					cleanupInterrupted: true,
					candidate,
					identity,
					revision,
					fence,
				});
				expect(vi.mocked(f.runtime.cleanup).mock.lastCall?.[0]).toMatchObject({
					candidate,
					identity,
					fence,
				});
				expect(vi.mocked(f.runtime.cleanup).mock.lastCall?.[1]).toBe(true);
				f.restart();
				await f.tick();
				expect(f.state).toMatchObject({
					phase:
						command === "stop" || command === "disable"
							? "closing"
							: "preflight",
					revision: revision + 1,
					fence,
				});
				expect(f.state).not.toHaveProperty("cleanupInterrupted");
				expect(f.state?.identity).toBeNull();
				expect(f.state?.candidate.configuration.source.imageDigest).toBe(
					command === "configuration" ? "image-d" : "image-a",
				);
				expect(f.runtime.cleanup).toHaveBeenCalledTimes(2);
			}
		},
	);

	it.each([false, true])(
		"stops/disables without waiting for candidate admission and restarts on the retained volume (%s)",
		async (disabled) => {
			const f = fixture();
			await f.tick(8);
			f.stop(disabled);
			await f.tick(3);
			expect(f.state?.phase).toBe("stopped");
			expect(f.runtime.apply).toHaveBeenLastCalledWith(
				expect.anything(),
				true,
				expect.anything(),
			);
			expect(f.runtime.cleanup).not.toHaveBeenCalled();
			f.start();
			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
		},
	);
	it("does not declare creation failure until route closure and new-volume cleanup are confirmed", async () => {
		const f = fixture();
		vi.mocked(f.runtime.observe).mockResolvedValue("unhealthy");
		await f.tick(5);
		expect(f.state?.phase).toBe("cleaning");
		vi.mocked(f.runtime.closeRoute).mockRejectedValueOnce(
			new Error("private provider response"),
		);
		await f.tick();
		expect(f.runtime.cleanup).not.toHaveBeenCalled();
		vi.mocked(f.runtime.cleanup).mockResolvedValueOnce(false);
		await f.tick();
		expect(f.state?.phase).toBe("cleaning");
		await f.tick();
		expect(f.state?.phase).toBe("failed");
		expect(f.runtime.cleanup).toHaveBeenLastCalledWith(
			expect.anything(),
			true,
			expect.objectContaining({
				configuration: expect.objectContaining({ revision: 1 }),
			}),
		);
		expect(JSON.stringify(f.state)).not.toContain("private provider response");
	});
	it("recloses a partial candidate route before reobserving and promoting", async () => {
		const f = fixture();
		await f.tick(6);
		expect(f.state?.phase).toBe("promoting");
		vi.mocked(f.runtime.closeRoute).mockClear();
		vi.mocked(f.runtime.observe).mockClear();
		vi.mocked(f.runtime.promote).mockClear();
		await f.tick();
		expect(f.state?.phase).toBe("ready");
		const close = vi.mocked(f.runtime.closeRoute).mock.invocationCallOrder[0];
		const observe = vi.mocked(f.runtime.observe).mock.invocationCallOrder[0];
		const promote = vi.mocked(f.runtime.promote).mock.invocationCallOrder[0];
		if (close === undefined || observe === undefined || promote === undefined)
			throw new Error();
		expect(close).toBeLessThan(observe);
		expect(observe).toBeLessThan(promote);
	});
	it("fails closed when a candidate remains drifted after route closure", async () => {
		const f = fixture();
		await f.tick(6);
		expect(f.state?.phase).toBe("promoting");
		vi.mocked(f.runtime.closeRoute).mockClear();
		vi.mocked(f.runtime.observe).mockClear();
		vi.mocked(f.runtime.promote).mockClear();
		vi.mocked(f.runtime.observe).mockResolvedValueOnce("drifted");
		await f.tick();
		expect(f.runtime.closeRoute).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "promoting" }),
		);
		const close = vi.mocked(f.runtime.closeRoute).mock.invocationCallOrder[0];
		const observe = vi.mocked(f.runtime.observe).mock.invocationCallOrder[0];
		if (close === undefined || observe === undefined) throw new Error();
		expect(close).toBeLessThan(observe);
		expect(f.runtime.promote).not.toHaveBeenCalled();
		expect(f.state).toMatchObject({
			phase: "cleaning",
			failureCode: "health_check_failed",
		});
	});
	it("retries promoting when candidate route closure fails", async () => {
		const f = fixture();
		await f.tick(6);
		expect(f.state?.phase).toBe("promoting");
		vi.mocked(f.runtime.observe).mockClear();
		vi.mocked(f.runtime.closeRoute).mockRejectedValueOnce(
			new Error("route close failed"),
		);
		await f.tick();
		expect(f.state).toMatchObject({ phase: "promoting", attempts: 1 });
		expect(f.runtime.observe).not.toHaveBeenCalled();
	});
	it("supersedes an in-flight candidate before promotion when newer desired state arrives", async () => {
		const f = fixture();
		await f.tick(7);
		expect(f.state?.phase).toBe("ready");
		f.upgrade("image-b");
		await f.tick(6);
		expect(f.state?.phase).toBe("promoting");
		f.stop();
		await f.tick(3);
		expect(f.state?.phase).toBe("stopped");
		expect(vi.mocked(f.runtime.promote).mock.calls).toHaveLength(1);
	});
});
