import { describe, expect, it } from "vitest";
import {
	canReadySessionSandboxReserveV1,
	canReleaseSessionSandboxReserveV1,
	parseSessionSandboxReserveConfigurationV1,
	type SessionSandboxReserveOperationV1,
	sessionSandboxBudgetFitsV1,
	sessionSandboxReserveResourceKindsV1,
	sessionSandboxReserveTargetV1,
} from "./session-sandbox-reserves.js";

describe("Session reserve admission", () => {
	it("keeps CPU, memory and retained PVC as independent hard caps", () => {
		const limit = { cpuMillis: 2000, memoryBytes: 4096, storageBytes: 10000 };
		expect(
			sessionSandboxBudgetFitsV1(
				limit,
				{ cpuMillis: 1000, memoryBytes: 2048, storageBytes: 9000 },
				{ cpuMillis: 1000, memoryBytes: 2048, storageBytes: 1001 },
			),
		).toBe(false);
		expect(
			sessionSandboxBudgetFitsV1(
				limit,
				{ cpuMillis: 0, memoryBytes: 0, storageBytes: 9000 },
				{ cpuMillis: 2000, memoryBytes: 4096, storageBytes: 1000 },
			),
		).toBe(true);
	});
	it("accepts an empty explicit disabled configuration", () => {
		expect(() =>
			parseSessionSandboxReserveConfigurationV1({
				schemaVersion: 1,
				enabled: false,
				revision: 1,
				namespace: "reserve-test",
				totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
				resourceCosts: [],
				maximumReserves: 0,
				maximumConcurrentCreates: 0,
				ttlMs: 0,
				cooldownMs: 0,
				failureBackoffMs: 0,
				profiles: [],
			}),
		).not.toThrow();
	});
	it("never promotes incomplete/unknown creates or a retiring reserve", () => {
		expect(
			canReadySessionSandboxReserveV1({
				status: "preparing",
				operations: [],
				bootstrapReady: true,
				businessStateAbsent: true,
			}),
		).toBe(false);
		const operations = sessionSandboxReserveResourceKindsV1.map((kind) => ({
			attemptId: kind,
			operation: "create" as const,
			kind,
			name: `sandbox-${kind}`,
			status: "confirmed" as const,
			resource: {
				kind,
				namespace: "ns",
				name: `sandbox-${kind}`,
				uid: kind,
				resourceVersion: "1",
			},
			absent: false,
			writeCompletion: "response" as const,
			writer: { owner: "worker", fence: 1 },
		}));
		expect(
			canReadySessionSandboxReserveV1({
				status: "unknown",
				operations,
				bootstrapReady: true,
				businessStateAbsent: true,
			}),
		).toBe(false);
		expect(
			canReadySessionSandboxReserveV1({
				status: "retiring",
				operations: [],
				bootstrapReady: true,
				businessStateAbsent: true,
			}),
		).toBe(false);
	});
	it("does not release an unknown create from a single absence or a claimed reserve", () => {
		expect(
			canReleaseSessionSandboxReserveV1({ status: "unknown", operations: [] }),
		).toBe(false);
		expect(
			canReleaseSessionSandboxReserveV1({ status: "claimed", operations: [] }),
		).toBe(false);
	});
	it("requires settled same-UID DELETE evidence before releasing a confirmed create", () => {
		const created: SessionSandboxReserveOperationV1 = {
			attemptId: "create-pod",
			operation: "create",
			kind: "Pod",
			name: "sandbox-pod",
			status: "confirmed",
			resource: {
				kind: "Pod",
				namespace: "ns",
				name: "sandbox-pod",
				uid: "original-pod",
				resourceVersion: "1",
			},
			absent: false,
			writeCompletion: "response",
			writer: { owner: "worker", fence: 1 },
		};
		const deleted: SessionSandboxReserveOperationV1 = {
			...created,
			attemptId: "delete-pod",
			operation: "delete",
			absent: true,
		};
		const release = (operation: SessionSandboxReserveOperationV1) =>
			canReleaseSessionSandboxReserveV1({
				status: "retiring",
				operations: [created, operation],
			});
		expect(release(deleted)).toBe(true);
		expect(release({ ...deleted, writeCompletion: "pending" })).toBe(false);
		expect(release({ ...deleted, absent: false })).toBe(false);
		expect(release({ ...deleted, status: "unknown" })).toBe(false);
		expect(
			canReleaseSessionSandboxReserveV1({
				status: "retiring",
				operations: [
					created,
					deleted,
					{
						...deleted,
						attemptId: "delete-retry-pending",
						status: "pending",
						absent: false,
						writeCompletion: "pending",
					},
				],
			}),
		).toBe(false);
		expect(
			release({
				...deleted,
				resource: {
					kind: "Pod",
					namespace: "ns",
					name: created.name,
					uid: "replacement-pod",
					resourceVersion: "2",
				},
			}),
		).toBe(false);
	});
});

describe("observed Session reserve sizing", () => {
	it("uses arrival rate times observed refill duration plus one burst slot", () => {
		const demand = {
			minimum: 1,
			maximum: 10,
			newSessionCount: 6,
			windowMs: 60_000,
		};
		expect(
			sessionSandboxReserveTargetV1({
				...demand,
				replenishmentUpperBoundMs: 1000,
			}),
		).toBe(2);
		expect(
			sessionSandboxReserveTargetV1({
				...demand,
				replenishmentUpperBoundMs: 30_000,
			}),
		).toBe(4);
		expect(
			sessionSandboxReserveTargetV1({
				...demand,
				replenishmentUpperBoundMs: 300_000,
			}),
		).toBe(10);
	});
	it("keeps sparse samples as observed bounds and uses the approved minimum without measurements or arrivals", () => {
		const demand = {
			minimum: 2,
			maximum: 4,
			newSessionCount: 60,
			windowMs: 60_000,
		};
		expect(
			sessionSandboxReserveTargetV1({
				...demand,
				replenishmentUpperBoundMs: null,
			}),
		).toBe(2);
		expect(
			sessionSandboxReserveTargetV1({
				...demand,
				replenishmentUpperBoundMs: 2500,
			}),
		).toBe(4);
		expect(
			sessionSandboxReserveTargetV1({
				...demand,
				newSessionCount: 0,
				replenishmentUpperBoundMs: 30_000,
			}),
		).toBe(2);
	});
});
