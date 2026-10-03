import { describe, expect, it } from "vitest";
import {
	hasUnverifiedWorkloadSecretRecoveryV1,
	type WorkloadSecretRecoveryV1,
} from "./workload-secret-recovery.js";

const recovery = {
	sourceReference: { secretId: "source", secretVersion: 1 },
	sourceActivationFence: { fence: 3 },
	reference: { name: "source-recovery" },
	workloadRevision: 2,
	fence: 4,
	secretUid: "secret-uid",
	identity: { uid: "workload-uid", generation: 1 },
} as unknown as WorkloadSecretRecoveryV1;

describe("Workload Secret recovery verification", () => {
	it("requires every recovery field to match the verified record", () => {
		expect(
			hasUnverifiedWorkloadSecretRecoveryV1(
				{ secretRecoveries: [recovery] },
				{ secretRecoveries: [structuredClone(recovery)] },
			),
		).toBe(false);
		for (const patch of [
			{ fence: recovery.fence + 1 },
			{ secretUid: "different-secret" },
			{
				identity: {
					uid: (recovery.identity as { uid: string }).uid,
					generation: 2,
				},
			},
		]) {
			expect(
				hasUnverifiedWorkloadSecretRecoveryV1(
					{ secretRecoveries: [{ ...recovery, ...patch }] },
					{ secretRecoveries: [recovery] },
				),
			).toBe(true);
		}
	});
});
