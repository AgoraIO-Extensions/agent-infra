import { describe, expect, it } from "vitest";
import { workspaceSnapshotLimitsV1 } from "./workspace-snapshot.js";
import { workspaceSnapshotUploadPolicyV1 as admission } from "./workspace-snapshot-upload-admission.js";

describe("snapshot upload admission policy", () => {
	const empty = {
		activeUploads: 0,
		activeOwnerUploads: 0,
		requestsInWindow: 0,
		ownerRequestsInWindow: 0,
		temporaryBytes: 0,
	};
	it("captures a validated immutable deployment policy", () => {
		const input = { ...admission.defaults };
		const policy = admission.parse(input);
		input.maximumConcurrentUploads = 999;
		expect(policy.maximumConcurrentUploads).toBe(4);
		expect(Object.isFrozen(policy)).toBe(true);
		expect(() => admission.assertAdmitted(policy, empty)).not.toThrow();
	});
	it.each([
		{ maximumConcurrentUploads: 0 },
		{ maximumConcurrentUploads: 1001 },
		{ maximumConcurrentUploadsPerOwner: 5 },
		{ maximumRequestsPerWindow: 601 },
		{ rateWindowMs: Number.NaN },
		{ rateWindowMs: 86_400_001 },
		{ uploadTimeoutMs: 3_600_001 },
		{ admissionLeaseMs: 300_000 },
		{ maximumTemporaryBytes: workspaceSnapshotLimitsV1.maxArchiveBytes - 1 },
		{ unknown: 1 },
	])("rejects invalid limits: %j", (change) => {
		expect(() =>
			admission.parse({ ...admission.defaults, ...change }),
		).toThrow();
	});
	it.each([
		{ activeUploads: admission.defaults.maximumConcurrentUploads },
		{ activeOwnerUploads: admission.defaults.maximumConcurrentUploadsPerOwner },
		{ requestsInWindow: admission.defaults.maximumGlobalRequestsPerWindow },
		{ ownerRequestsInWindow: admission.defaults.maximumRequestsPerWindow },
		{
			temporaryBytes:
				admission.defaults.maximumTemporaryBytes -
				workspaceSnapshotLimitsV1.maxArchiveBytes +
				1,
		},
	])(
		"rejects exhausted capacity with a bounded retryable reason: %j",
		(usage) => {
			expect(() =>
				admission.assertAdmitted(admission.defaults, { ...empty, ...usage }),
			).toThrow(expect.objectContaining({ code: "rate_limited" }));
		},
	);
	it("does not turn unknown database counters into available capacity", () => {
		expect(() =>
			admission.assertAdmitted(admission.defaults, {
				...empty,
				activeUploads: Number.NaN,
			}),
		).toThrow(expect.objectContaining({ code: "unavailable" }));
	});
});
