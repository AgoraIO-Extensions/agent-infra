import { describe, expect, it, vi } from "vitest";
import type { AgentConfigurationRecordV2 } from "./agent-configuration.js";
import type { AgentManagementStateV1 } from "./agent-management.js";
import {
	createWorkloadReconciliationV1,
	WorkloadPreflightRejectedErrorV1,
	type WorkloadReconciliationStateV1,
	type WorkloadRuntimePortV1,
	type WorkloadStepFailureV1,
} from "./workload-reconciliation.js";

function fixture(
	source: AgentConfigurationRecordV2["source"] = {
		kind: "standard",
		imageDigest: "image-a",
	} as AgentConfigurationRecordV2["source"],
	onStepFailure?: (failure: WorkloadStepFailureV1) => void,
) {
	let configuration = {
		schemaVersion: 2,
		agentId: "agent-a",
		revision: 1,
		source,
	} as AgentConfigurationRecordV2;
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
		onStepFailure,
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
				onStepFailure,
			});
		},
		upgrade(
			image: string,
			nextSource: AgentConfigurationRecordV2["source"] = {
				...configuration.source,
				imageDigest: image,
			},
		) {
			configuration = {
				...configuration,
				revision: configuration.revision + 1,
				source: nextSource,
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
	it("persists a prepared resource intention across a Worker restart before observing it", async () => {
		const f = fixture();
		await f.tick(3);
		if (!f.state) throw new Error();
		const candidate = {
			...f.state.candidate,
			deployment: { admitted: true, receipt: "persist-before-create" },
		};
		vi.mocked(f.runtime.apply).mockResolvedValueOnce({
			status: "prepared",
			candidate,
			identity: null,
		});
		await f.tick();
		expect(f.state).toMatchObject({
			phase: "applying",
			identity: null,
			candidate,
		});
		expect(f.runtime.observe).not.toHaveBeenCalled();
		f.restart();
		await f.tick();
		expect(f.state).toMatchObject({
			phase: "observing",
			identity: { uid: "uid-a" },
			candidate,
		});
		expect(vi.mocked(f.runtime.apply).mock.calls.at(-1)?.[0].candidate).toEqual(
			candidate,
		);
	});
	it.each([false, true])(
		"keeps same-configuration recovery cleanup durable when disabled=%s",
		async (disabled) => {
			const f = fixture();
			await f.tick(7);
			f.start();
			await f.tick(3);
			const sourceReference = {
				schemaVersion: 1 as const,
				ownerType: "agent-owner" as const,
				ownerId: "owner-a",
				agentId: "agent-a",
				secretId: "secret-a",
				secretVersion: 1,
				configRevision: 1,
				algorithmVersion: "aes-256-gcm:v1" as const,
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
				wrappingKeyVersion: "key-a",
				name: "agent-a.secret-a-v1-r1",
			};
			if (!f.state) throw new Error();
			const candidate = {
				...f.state.candidate,
				secretRecoveries: [
					{
						sourceReference,
						sourceActivationFence: {
							schemaVersion: 1 as const,
							agentId: "agent-a",
							secretId: "secret-a",
							secretVersion: 1,
							configRevision: 1,
							kubernetesSecretName: sourceReference.name,
							workloadUid: "old-workload",
							workloadGeneration: 1,
							fence: 1,
						},
						reference: {
							...sourceReference,
							name: `${sourceReference.name}-w2-f42`,
						},
						workloadRevision: 2,
						fence: 42,
						secretUid: "candidate-secret",
						identity: { uid: "candidate-workload", generation: 1 },
					},
				],
			};
			vi.mocked(f.runtime.apply).mockResolvedValueOnce({
				status: "prepared",
				candidate,
				identity: { uid: "candidate-workload", generation: 1 },
			});
			await f.tick();
			f.stop(disabled);
			await f.tick();
			expect(f.state).toMatchObject({
				phase: "cleaning",
				cleanupInterrupted: true,
				candidate,
				identity: { uid: "candidate-workload" },
				fence: 43,
			});
			vi.mocked(f.runtime.discardUnactivatedSecrets)
				.mockResolvedValueOnce({
					status: "prepared",
					candidate,
					identity: { uid: "candidate-workload", generation: 2 },
				})
				.mockResolvedValueOnce(false);
			await f.tick();
			f.restart();
			await f.tick();
			expect(f.state).toMatchObject({
				phase: "cleaning",
				candidate,
				identity: { uid: "candidate-workload", generation: 2 },
			});
			await f.tick();
			expect(f.state).toMatchObject({ phase: "closing", identity: null });
		},
	);
	it.each(["stop", "restart", "configuration"] as const)(
		"retains a materialized unactivated candidate across %s and preflight rejection",
		async (command) => {
			const f = fixture();
			await f.tick(7);
			f.start();
			await f.tick(7);
			expect(f.state?.phase).toBe("ready");
			f.upgrade("image-b");
			await f.tick(5);
			expect(f.state?.phase).toBe("activating");
			const candidate = structuredClone(f.state?.candidate);
			const identity = structuredClone(f.state?.identity);
			const revision = f.state?.revision;
			vi.mocked(f.runtime.discardUnactivatedSecrets)
				.mockClear()
				.mockResolvedValueOnce(false);
			vi.mocked(f.runtime.preflight)
				.mockClear()
				.mockRejectedValueOnce(new WorkloadPreflightRejectedErrorV1());
			if (command === "stop") f.stop();
			else if (command === "restart") f.start();
			else f.upgrade("image-c");
			await f.tick(2);
			expect(f.state).toMatchObject({
				phase: "cleaning",
				cleanupInterrupted: true,
				candidate,
				identity,
				revision,
			});
			expect(f.runtime.discardUnactivatedSecrets).toHaveBeenCalledWith(
				expect.objectContaining({ candidate }),
				expect.anything(),
			);
			expect(f.runtime.preflight).not.toHaveBeenCalled();
			expect(f.runtime.cleanup).not.toHaveBeenCalled();
			f.restart();
			await f.tick();
			expect(f.state?.phase).toBe(command === "stop" ? "closing" : "preflight");
			expect(f.state).not.toHaveProperty("cleanupInterrupted");
			expect(f.runtime.discardUnactivatedSecrets).toHaveBeenCalledTimes(2);
			if (command !== "stop") {
				await f.tick();
				expect(f.state?.phase).toBe("rejected");
				expect(f.state?.candidate.configuration.source.imageDigest).toBe(
					"image-a",
				);
			}
		},
	);
	it.each(["disable", "configuration"] as const)(
		"preserves initial materialized cleanup when %s supersedes before failure",
		async (command) => {
			const f = fixture();
			await f.tick(4);
			expect(f.state?.phase).toBe("observing");
			const candidate = structuredClone(f.state?.candidate);
			vi.mocked(f.runtime.cleanup).mockResolvedValueOnce(false);
			if (command === "disable") f.stop(true);
			else f.upgrade("image-b");
			await f.tick(2);
			expect(f.state).toMatchObject({
				phase: "cleaning",
				cleanupInterrupted: true,
				candidate,
			});
			expect(f.runtime.cleanup).toHaveBeenCalledWith(
				expect.objectContaining({ candidate }),
				true,
				expect.anything(),
			);
			expect(f.runtime.discardUnactivatedSecrets).not.toHaveBeenCalled();
			f.restart();
			await f.tick();
			expect(f.state?.phase).toBe(
				command === "disable" ? "closing" : "preflight",
			);
			expect(f.state?.identity).toBeNull();
			expect(f.state).not.toHaveProperty("cleanupInterrupted");
		},
	);
	it("retries transient preflight durably and recovers without candidate mutation", async () => {
		const f = fixture();
		vi.mocked(f.runtime.preflight).mockRejectedValueOnce(
			new Error("temporary registry outage"),
		);
		await f.tick(2);
		expect(f.state).toMatchObject({ phase: "preflight", attempts: 1 });
		expect(f.runtime.closeRoute).not.toHaveBeenCalled();
		expect(f.runtime.apply).not.toHaveBeenCalled();
		f.restart();
		await f.tick();
		expect(f.state).toMatchObject({ phase: "closing", attempts: 0 });
	});
	it("rejects preflight configuration that differs from the authoritative record", async () => {
		const f = fixture();
		await f.tick();
		const authoritative = f.state?.candidate.configuration;
		if (!authoritative) throw new Error();
		vi.mocked(f.runtime.preflight).mockResolvedValueOnce({
			configuration: { ...authoritative, agentId: "agent-other" },
			deployment: { admitted: true },
		});

		await f.tick();

		expect(f.state).toMatchObject({
			phase: "cleaning",
			failureCode: "reconciliation_failed",
			candidate: { configuration: authoritative, deployment: null },
		});
		expect(f.runtime.closeRoute).not.toHaveBeenCalled();
		expect(f.runtime.apply).not.toHaveBeenCalled();
	});
	it("exhausts initial transient preflight budget before cleanup", async () => {
		const f = fixture();
		vi.mocked(f.runtime.preflight).mockRejectedValue(
			new Error("temporary registry outage"),
		);
		await f.tick(3);
		expect(f.state).toMatchObject({ phase: "preflight", attempts: 2 });
		f.restart();
		await f.tick();
		expect(f.state).toMatchObject({ phase: "cleaning" });
		expect(f.runtime.preflight).toHaveBeenCalledTimes(3);
	});
	it("preserves the verified route throughout transient upgrade retries and exhaustion", async () => {
		const f = fixture();
		await f.tick(7);
		f.upgrade("image-b");
		vi.mocked(f.runtime.closeRoute).mockClear();
		vi.mocked(f.runtime.apply).mockClear();
		vi.mocked(f.runtime.preflight).mockRejectedValue(
			new Error("temporary registry outage"),
		);
		await f.tick(3);
		expect(f.state).toMatchObject({ phase: "preflight", attempts: 2 });
		await f.tick();
		expect(f.state).toMatchObject({
			phase: "rejected",
			candidate: { configuration: { source: { imageDigest: "image-a" } } },
		});
		expect(f.runtime.closeRoute).not.toHaveBeenCalled();
		expect(f.runtime.apply).not.toHaveBeenCalled();
	});
	it("rejects permanent initial preflight immediately", async () => {
		const f = fixture();
		vi.mocked(f.runtime.preflight).mockRejectedValue(
			new WorkloadPreflightRejectedErrorV1(),
		);
		await f.tick(2);
		expect(f.state?.phase).toBe("cleaning");
		expect(f.runtime.preflight).toHaveBeenCalledOnce();
	});
	describe("swallowed step exceptions are observable (#2532)", () => {
		it("reports every swallowed exception with its phase and consecutive attempt", async () => {
			const failures: WorkloadStepFailureV1[] = [];
			const f = fixture(undefined, (failure) => failures.push(failure));
			const outage = new Error("temporary registry outage");
			vi.mocked(f.runtime.preflight).mockRejectedValue(outage);
			await f.tick(3);
			expect(failures).toEqual([
				{
					agentId: "agent-a",
					phase: "preflight",
					attempts: 1,
					terminal: false,
					error: outage,
				},
				{
					agentId: "agent-a",
					phase: "preflight",
					attempts: 2,
					terminal: false,
					error: outage,
				},
			]);
		});
		it("marks the exception that exhausts the budget as terminal", async () => {
			const failures: WorkloadStepFailureV1[] = [];
			const f = fixture(undefined, (failure) => failures.push(failure));
			vi.mocked(f.runtime.preflight).mockRejectedValue(new Error("outage"));
			await f.tick(4);
			expect(
				failures.map(({ attempts, terminal }) => [attempts, terminal]),
			).toEqual([
				[1, false],
				[2, false],
				[3, true],
			]);
			expect(f.state?.phase).toBe("cleaning");
		});
		it("marks a permanent preflight rejection as terminal at once", async () => {
			const failures: WorkloadStepFailureV1[] = [];
			const f = fixture(undefined, (failure) => failures.push(failure));
			vi.mocked(f.runtime.preflight).mockRejectedValue(
				new WorkloadPreflightRejectedErrorV1(),
			);
			await f.tick(2);
			expect(failures).toMatchObject([
				{ phase: "preflight", attempts: 1, terminal: true },
			]);
		});
		it("reports durable cleanup retries without ending the run", async () => {
			const failures: WorkloadStepFailureV1[] = [];
			const f = fixture(undefined, (failure) => failures.push(failure));
			vi.mocked(f.runtime.preflight).mockRejectedValue(
				new WorkloadPreflightRejectedErrorV1(),
			);
			await f.tick(2);
			failures.length = 0;
			vi.mocked(f.runtime.closeRoute).mockRejectedValue(new Error("forbidden"));
			await f.tick(5);
			expect(f.state).toMatchObject({ phase: "cleaning", attempts: 3 });
			expect(
				failures.map(({ phase, attempts, terminal }) => [
					phase,
					attempts,
					terminal,
				]),
			).toEqual([
				["cleaning", 1, false],
				["cleaning", 2, false],
				["cleaning", 3, false],
				["cleaning", 3, false],
				["cleaning", 3, false],
			]);
		});
		it("does not report steps that complete or keep waiting", async () => {
			const failures: WorkloadStepFailureV1[] = [];
			const f = fixture(undefined, (failure) => failures.push(failure));
			vi.mocked(f.runtime.observe).mockResolvedValueOnce("pending");
			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			expect(failures).toEqual([]);
		});
		it("never lets a throwing observer change the reconciliation result", async () => {
			const f = fixture(undefined, () => {
				throw new Error("broken diagnostics sink");
			});
			vi.mocked(f.runtime.preflight).mockRejectedValueOnce(new Error("outage"));
			await f.tick(2);
			expect(f.state).toMatchObject({ phase: "preflight", attempts: 1 });
		});
	});
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
			new WorkloadPreflightRejectedErrorV1(),
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
	it.each(["pending", "drifted"] as const)(
		"closes a rejected workload route before persisting repair for %s health",
		async (health) => {
			const f = fixture();
			await f.tick(7);
			f.upgrade("image-b");
			vi.mocked(f.runtime.preflight).mockRejectedValueOnce(
				new WorkloadPreflightRejectedErrorV1(),
			);
			await f.tick(2);
			expect(f.state?.phase).toBe("rejected");
			vi.mocked(f.runtime.observe).mockResolvedValue(health);
			vi.mocked(f.runtime.closeRoute).mockClear();
			vi.mocked(f.runtime.closeRoute).mockRejectedValueOnce(
				new Error("unavailable"),
			);
			await f.tick();
			expect(f.state).toMatchObject({
				phase: "rejected",
				revision: 2,
				attempts: 1,
			});
			let release: () => void = () => {};
			vi.mocked(f.runtime.closeRoute).mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			);
			const repair = f.tick();
			await vi.waitFor(() =>
				expect(f.runtime.closeRoute).toHaveBeenCalledTimes(2),
			);
			expect(f.state).toMatchObject({ phase: "rejected", revision: 2 });
			release();
			await repair;
			expect(f.state).toMatchObject({ phase: "closing", revision: 3 });
		},
	);
	describe("serving probes that do not complete (#2046)", () => {
		it("keeps a ready route open until the third incomplete probe in a row", async () => {
			const f = fixture();
			await f.tick(7);
			expect(f.state?.phase).toBe("ready");
			vi.mocked(f.runtime.closeRoute).mockClear();
			vi.mocked(f.runtime.promote).mockClear();

			vi.mocked(f.runtime.observe).mockResolvedValueOnce("unreachable");
			await f.tick();
			expect(f.state).toMatchObject({ phase: "ready", attempts: 1 });
			// A completed probe ends the run.
			await f.tick();
			expect(f.state).toMatchObject({ phase: "ready", attempts: 0 });
			expect(f.runtime.promote).toHaveBeenCalledOnce();

			vi.mocked(f.runtime.observe)
				.mockResolvedValueOnce("unreachable")
				.mockResolvedValueOnce("unreachable");
			await f.tick(2);
			expect(f.state).toMatchObject({ phase: "ready", attempts: 2 });
			expect(f.runtime.closeRoute).not.toHaveBeenCalled();

			vi.mocked(f.runtime.observe).mockResolvedValueOnce("unreachable");
			await f.tick();
			expect(f.runtime.closeRoute).toHaveBeenCalledOnce();
			expect(f.state).toMatchObject({
				phase: "observing",
				attempts: 0,
				revision: 1,
			});
		});
		it.each([
			["unhealthy", "observing", 1],
			["pending", "observing", 1],
			["drifted", "applying", 2],
		] as const)(
			"still closes a ready route at once on a %s probe",
			async (health, phase, revision) => {
				const f = fixture();
				await f.tick(7);
				vi.mocked(f.runtime.closeRoute).mockClear();
				vi.mocked(f.runtime.observe).mockResolvedValueOnce(health);
				await f.tick();
				expect(f.runtime.closeRoute).toHaveBeenCalledOnce();
				expect(f.state).toMatchObject({ phase, revision });
			},
		);
		it("tolerates the same run while a rejected candidate keeps the verified route", async () => {
			const f = fixture();
			await f.tick(7);
			f.upgrade("image-b");
			vi.mocked(f.runtime.preflight).mockRejectedValueOnce(
				new WorkloadPreflightRejectedErrorV1(),
			);
			await f.tick(2);
			expect(f.state?.phase).toBe("rejected");
			vi.mocked(f.runtime.closeRoute).mockClear();
			vi.mocked(f.runtime.observe)
				.mockResolvedValueOnce("unreachable")
				.mockResolvedValueOnce("unreachable")
				.mockResolvedValueOnce("unreachable");
			await f.tick(2);
			expect(f.state).toMatchObject({ phase: "rejected", attempts: 2 });
			expect(f.runtime.closeRoute).not.toHaveBeenCalled();
			await f.tick();
			expect(f.runtime.closeRoute).toHaveBeenCalledOnce();
			expect(f.state?.phase).toBe("closing");
		});
		it("retries a verification probe that does not complete within the attempt budget", async () => {
			const f = fixture();
			vi.mocked(f.runtime.observe).mockResolvedValue("unreachable");
			await f.tick(6);
			expect(f.state).toMatchObject({ phase: "observing", attempts: 2 });
			await f.tick();
			expect(f.state).toMatchObject({
				phase: "cleaning",
				failureCode: "health_check_failed",
			});
		});
		it("verifies a candidate once its probe completes again", async () => {
			const f = fixture();
			vi.mocked(f.runtime.observe)
				.mockResolvedValueOnce("unreachable")
				.mockResolvedValueOnce("healthy")
				.mockResolvedValueOnce("unreachable");
			await f.tick(5);
			expect(f.state).toMatchObject({ phase: "observing", attempts: 1 });
			await f.tick(2);
			expect(f.state).toMatchObject({ phase: "promoting", attempts: 0 });
			await f.tick();
			expect(f.state).toMatchObject({ phase: "promoting", attempts: 1 });
			await f.tick();
			expect(f.state).toMatchObject({ phase: "ready", attempts: 0 });
		});
		it("still fails a candidate whose probe answers unhealthy", async () => {
			const f = fixture();
			vi.mocked(f.runtime.observe).mockResolvedValue("unhealthy");
			await f.tick(5);
			expect(f.state).toMatchObject({
				phase: "cleaning",
				failureCode: "health_check_failed",
			});
		});
		it.each([0, 1.5, 101])(
			"rejects a probe failure threshold of %s",
			(value) => {
				const f = fixture();
				expect(() =>
					createWorkloadReconciliationV1({
						store: { runNext: async () => "idle" },
						runtime: f.runtime,
						probeFailureThreshold: value,
					}),
				).toThrow("Invalid Workload probe failure threshold");
			},
		);
	});
	it("keeps retrying rejected route closure in cleanup after the attempt budget expires", async () => {
		const f = fixture();
		await f.tick(7);
		f.upgrade("image-b");
		vi.mocked(f.runtime.preflight).mockRejectedValueOnce(
			new WorkloadPreflightRejectedErrorV1(),
		);
		await f.tick(2);
		vi.mocked(f.runtime.observe).mockResolvedValue("drifted");
		vi.mocked(f.runtime.closeRoute)
			.mockClear()
			.mockRejectedValue(new Error("unavailable"));
		vi.mocked(f.runtime.promote).mockClear();
		vi.mocked(f.runtime.apply).mockClear();
		await f.tick(3);
		expect(f.state).toMatchObject({
			phase: "cleaning",
			failureCode: "reconciliation_failed",
		});
		expect(f.runtime.closeRoute).toHaveBeenCalledTimes(3);
		await f.tick(4);
		expect(f.state).toMatchObject({ phase: "cleaning", attempts: 3 });
		expect(f.runtime.closeRoute).toHaveBeenCalledTimes(7);
		expect(f.runtime.cleanup).not.toHaveBeenCalled();
		expect(f.runtime.discardUnactivatedSecrets).not.toHaveBeenCalled();
		expect(f.runtime.promote).not.toHaveBeenCalled();
		expect(f.runtime.apply).not.toHaveBeenCalled();
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
			new WorkloadPreflightRejectedErrorV1(),
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
	it("preserves failed rollback cleanup when a newer configuration supersedes it", async () => {
		const f = fixture();
		await f.tick(7);
		f.upgrade("image-b");
		vi.mocked(f.runtime.observe).mockResolvedValue("unhealthy");
		await f.tick(8);
		expect(f.state).toMatchObject({
			phase: "cleaning",
			rollback: true,
			candidate: { configuration: { source: { imageDigest: "image-a" } } },
		});
		const rollbackCandidate = structuredClone(f.state?.candidate);
		const rollbackIdentity = structuredClone(f.state?.identity);
		const rollbackRevision = f.state?.revision;
		vi.mocked(f.runtime.cleanup).mockResolvedValueOnce(false);

		f.upgrade("image-c");
		await f.tick();

		expect(f.state).toMatchObject({
			phase: "cleaning",
			rollback: true,
			cleanupInterrupted: true,
			candidate: rollbackCandidate,
			identity: rollbackIdentity,
			revision: rollbackRevision,
		});
		expect(f.runtime.cleanup).not.toHaveBeenCalled();
		f.restart();
		await f.tick();
		expect(f.state).toMatchObject({
			phase: "cleaning",
			rollback: true,
			cleanupInterrupted: true,
			candidate: rollbackCandidate,
		});
		expect(f.runtime.cleanup).toHaveBeenCalledWith(
			expect.objectContaining({
				candidate: rollbackCandidate,
				identity: rollbackIdentity,
				rollback: true,
			}),
			false,
			expect.anything(),
		);
		f.restart();
		await f.tick();
		expect(f.state).toMatchObject({
			phase: "preflight",
			rollback: false,
			candidate: {
				configuration: { source: { imageDigest: "image-c" } },
				deployment: null,
			},
		});
		expect(f.state).not.toHaveProperty("cleanupInterrupted");
		expect(f.runtime.cleanup).toHaveBeenCalledTimes(2);
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
		await f.tick();
		expect(f.state?.phase).toBe("cleaning");
		await f.tick(3);
		expect(f.state?.phase).toBe("stopped");
		expect(f.runtime.discardUnactivatedSecrets).toHaveBeenCalledOnce();
		expect(vi.mocked(f.runtime.promote).mock.calls).toHaveLength(1);
	});
	it.each(["self-managed", "platform-managed"] as const)(
		"preserves custom self-managed interaction mode and %s identity responsibility across A-to-B",
		async (identityResponsibility) => {
			// Fixture-only: this port proves state-machine ordering, not live Kubernetes or Registry admission.
			const sourceA = {
				kind: "custom" as const,
				imageDigest: "image-a",
				admissionRevision: "admission-a",
				interactionMode: "self-managed" as const,
				identityResponsibility,
				connectionEnabled: false,
			};
			const sourceB = {
				...sourceA,
				imageDigest: "image-b",
				admissionRevision: "admission-b",
			};
			const f = fixture(sourceA);
			await f.tick(8);
			f.upgrade("image-b", sourceB);
			await f.tick(8);

			expect(f.state).toMatchObject({
				phase: "ready",
				verified: {
					configuration: {
						source: {
							kind: "custom",
							imageDigest: "image-b",
							interactionMode: "self-managed",
							identityResponsibility,
						},
					},
				},
			});
			const promoted = vi.mocked(f.runtime.promote).mock.calls;
			expect(
				promoted.some(
					([state]) =>
						state.candidate.configuration.source.imageDigest === "image-b",
				),
			).toBe(true);
		},
	);
	it("rejects a mode-changing candidate before route closure and retains verified A", async () => {
		const sourceA = {
			kind: "custom" as const,
			imageDigest: "image-a",
			admissionRevision: "admission-a",
			interactionMode: "self-managed" as const,
			identityResponsibility: "self-managed" as const,
			connectionEnabled: false,
		};
		const sourceB = {
			kind: "custom" as const,
			imageDigest: "image-b",
			admissionRevision: "admission-b",
			interactionMode: "platform-adapter" as const,
			connectionEnabled: false,
		};
		const f = fixture(sourceA);
		await f.tick(8);
		vi.mocked(f.runtime.closeRoute).mockClear();
		vi.mocked(f.runtime.promote).mockClear();
		f.upgrade("image-b", sourceB);
		await f.tick(2);

		expect(f.state).toMatchObject({
			phase: "rejected",
			failureCode: "reconciliation_failed",
			candidate: { configuration: { source: sourceA } },
			verified: { configuration: { source: sourceA } },
		});
		expect(f.runtime.closeRoute).not.toHaveBeenCalled();
		expect(f.runtime.promote).not.toHaveBeenCalled();
	});
	it("keeps verified B routed when a same-mode C candidate fails health", async () => {
		const sourceB = {
			kind: "custom" as const,
			imageDigest: "image-b",
			admissionRevision: "admission-b",
			interactionMode: "self-managed" as const,
			identityResponsibility: "platform-managed" as const,
			connectionEnabled: false,
		};
		const sourceC = {
			...sourceB,
			imageDigest: "image-c",
			admissionRevision: "admission-c",
		};
		const f = fixture(sourceB);
		await f.tick(8);
		f.upgrade("image-c", sourceC);
		vi.mocked(f.runtime.observe).mockImplementation(async (state) =>
			state.candidate.configuration.source.imageDigest === "image-c"
				? "unhealthy"
				: "healthy",
		);
		vi.mocked(f.runtime.promote).mockClear();
		await f.tick(12);

		expect(f.state).toMatchObject({
			phase: "ready",
			rollback: true,
			failureCode: "health_check_failed",
			candidate: { configuration: { source: sourceB } },
			verified: { configuration: { source: sourceB } },
		});
		expect(
			vi
				.mocked(f.runtime.promote)
				.mock.calls.some(
					([state]) =>
						state.candidate.configuration.source.imageDigest === "image-c",
				),
		).toBe(false);
		expect(
			vi
				.mocked(f.runtime.promote)
				.mock.calls.some(
					([state]) =>
						state.candidate.configuration.source.imageDigest === "image-b",
				),
		).toBe(true);
	});
});
