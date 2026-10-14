import { describe, expect, it } from "vitest";
import {
	sessionSandboxObservationFingerprintV1,
	sessionSandboxUnknownRetryDelayMs,
} from "./session-sandbox-reconciliation.js";

const resource = {
	kind: "Pod" as const,
	namespace: "sandbox",
	name: "session",
	uid: "pod-uid",
	resourceVersion: "17",
};

describe("Session Sandbox unknown reconciliation pacing", () => {
	it("keeps the first five retries at one second and then caps exponential backoff", () => {
		expect(
			[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(
				sessionSandboxUnknownRetryDelayMs,
			),
		).toEqual([
			1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000,
			60_000,
		]);
		expect(() => sessionSandboxUnknownRetryDelayMs(0)).toThrow(TypeError);
	});

	it("ignores resourceVersion churn but tracks identity, state and stop evidence", () => {
		const base = {
			allocationStatus: "unknown" as const,
			observation: { status: "unknown" as const, resources: [resource] },
			stopReceipt: null,
		};
		const refreshed = sessionSandboxObservationFingerprintV1({
			...base,
			observation: {
				...base.observation,
				resources: [{ ...resource, resourceVersion: "18" }],
			},
		});
		expect(refreshed).toBe(sessionSandboxObservationFingerprintV1(base));
		expect(
			sessionSandboxObservationFingerprintV1({
				...base,
				observation: {
					...base.observation,
					resources: [{ ...resource, uid: "replacement-uid" }],
				},
			}),
		).not.toBe(refreshed);
		expect(
			sessionSandboxObservationFingerprintV1({
				...base,
				allocationStatus: "observed",
			}),
		).not.toBe(refreshed);
		expect(
			sessionSandboxObservationFingerprintV1({
				...base,
				stopReceipt: { schemaVersion: 1 },
			}),
		).not.toBe(refreshed);
	});
});
