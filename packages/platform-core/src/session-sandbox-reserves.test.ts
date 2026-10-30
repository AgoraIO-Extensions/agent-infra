import { describe, expect, it } from "vitest";
import {
	canReadySessionSandboxReserveV1,
	canReleaseSessionSandboxReserveV1,
	parseSessionSandboxReserveConfigurationV1,
	sessionSandboxBudgetFitsV1,
	sessionSandboxReserveResourceKindsV1,
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
});
