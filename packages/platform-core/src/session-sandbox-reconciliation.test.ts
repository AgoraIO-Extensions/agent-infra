import { describe, expect, it } from "vitest";
import { createSessionSandboxBindingV1 } from "./session-sandbox.js";
import {
	canAdvanceSessionSandboxDeletionProgressV1,
	decideSessionSandboxObservationV1,
	isSessionSandboxDeletionProgressValidV1,
	isSessionSandboxObservationValidV1,
	nextSessionSandboxObservationBackoffV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxObservationV1,
	type SessionSandboxReconciliationClaimV1,
	sessionSandboxReconcileProgressV1,
	sessionSandboxRetryDelayMsV1,
} from "./session-sandbox-reconciliation.js";

const sandbox = createSessionSandboxBindingV1(
	{
		schemaVersion: 1,
		actorId: "user",
		agentId: "agent",
		channelId: "web",
		authorizationRevision: "agent-1",
		supportsSupplementaryInstruction: false,
	},
	"session",
);
const claim: Pick<
	SessionSandboxReconciliationClaimV1,
	"sandbox" | "policy" | "desiredState"
> = {
	sandbox,
	desiredState: "running",
	policy: {
		namespace: "sandbox-tests",
		resourceConfigurationHash: "policy-1",
		configurationRevision: 1,
		workloadRevision: 1,
		managementFence: 1,
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
};
const requiredKinds = [
	"Pod",
	"Service",
	"ServiceAccount",
	"PersistentVolumeClaim",
	"NetworkPolicy",
	"Secret",
] as const;
const ready: SessionSandboxObservationV1 = {
	status: "ready",
	resources: requiredKinds.map((kind) => ({
		kind,
		namespace: claim.policy.namespace,
		name: sandbox.resourceName,
		uid: `observed-${kind}`,
		resourceVersion: "12",
	})),
};

describe("Session Sandbox actual resource receipt", () => {
	it("requires explicit absence proof and excludes PVC from delete progress", () => {
		const service = ready.resources.find(
			(resource) => resource.kind === "Service",
		)!;
		const progress = {
			schemaVersion: 1 as const,
			state: "absent" as const,
			deleteAttemptId: "attempt-service",
			deleteAttempted: true,
			deleteCallResult: "unknown" as const,
			sourceGeneration: 1,
			resourceFence: 2,
			managementFence: 3,
			resource: service,
			preconditions: {
				uid: service.uid,
				resourceVersion: service.resourceVersion,
			},
			absence: {
				kind: service.kind,
				namespace: service.namespace,
				name: service.name,
			},
		};
		const intent = {
			...progress,
			state: "delete-requested" as const,
			deleteAttempted: false,
			deleteCallResult: "not-attempted" as const,
			absence: undefined,
		};
		expect(
			canAdvanceSessionSandboxDeletionProgressV1(undefined, progress),
		).toBe(false);
		expect(canAdvanceSessionSandboxDeletionProgressV1(undefined, intent)).toBe(
			true,
		);
		expect(canAdvanceSessionSandboxDeletionProgressV1(intent, progress)).toBe(
			true,
		);
		expect(canAdvanceSessionSandboxDeletionProgressV1(progress, intent)).toBe(
			false,
		);
		expect(
			canAdvanceSessionSandboxDeletionProgressV1(intent, {
				...progress,
				deleteAttemptId: "new",
			}),
		).toBe(false);
		expect(
			canAdvanceSessionSandboxDeletionProgressV1(
				{ ...progress, deleteCallResult: "acknowledged" },
				progress,
			),
		).toBe(false);
		expect(
			canAdvanceSessionSandboxDeletionProgressV1(intent, {
				...intent,
				deleteAttempted: true,
				deleteCallResult: "failed",
			}),
		).toBe(true);

		expect(isSessionSandboxDeletionProgressValidV1([progress])).toBe(true);
		expect(
			isSessionSandboxDeletionProgressValidV1([
				{ ...progress, absence: undefined },
			]),
		).toBe(false);
		expect(
			isSessionSandboxDeletionProgressValidV1([
				{
					...progress,
					resource: { ...service, kind: "PersistentVolumeClaim" },
				},
			]),
		).toBe(false);
	});
	it("accepts the six actual direct-Pod resources without a fabricated controller", () => {
		expect(isSessionSandboxObservationValidV1(claim, ready)).toBe(true);
	});
	it("accepts delete progress for the per-Sandbox Secret (#1466)", () => {
		const secret = ready.resources.find(
			(resource) => resource.kind === "Secret",
		);
		if (!secret) throw new Error("Missing Secret fixture");
		expect(
			isSessionSandboxDeletionProgressValidV1([
				{
					schemaVersion: 1,
					state: "delete-requested",
					deleteAttemptId: "attempt-secret",
					deleteAttempted: false,
					deleteCallResult: "not-attempted",
					sourceGeneration: 1,
					resourceFence: 2,
					managementFence: 3,
					resource: secret,
					preconditions: {
						uid: secret.uid,
						resourceVersion: secret.resourceVersion,
					},
				},
			]),
		).toBe(true);
	});
	it.each(requiredKinds)("rejects readiness without actual %s", (kind) => {
		expect(
			isSessionSandboxObservationValidV1(claim, {
				...ready,
				resources: ready.resources.filter((resource) => resource.kind !== kind),
			}),
		).toBe(false);
	});
	it("requires the real Pod controller relation when a StatefulSet is present", () => {
		const controller = {
			kind: "StatefulSet" as const,
			namespace: claim.policy.namespace,
			name: sandbox.resourceName,
			uid: "observed-controller",
			resourceVersion: "23",
		};
		const controlled = {
			...ready,
			resources: [
				...ready.resources.map((resource) =>
					resource.kind === "Pod"
						? { ...resource, controllerUid: controller.uid }
						: resource,
				),
				controller,
			],
		};
		expect(isSessionSandboxObservationValidV1(claim, controlled)).toBe(true);
		expect(
			isSessionSandboxObservationValidV1(claim, {
				...ready,
				resources: [...ready.resources, controller],
			}),
		).toBe(false);
		expect(
			isSessionSandboxObservationValidV1(claim, {
				...controlled,
				resources: controlled.resources.filter(
					(resource) => resource.kind !== "StatefulSet",
				),
			}),
		).toBe(false);
		expect(
			isSessionSandboxObservationValidV1(claim, {
				...controlled,
				resources: controlled.resources.map((resource) =>
					resource.kind === "Pod"
						? { ...resource, controllerUid: "other-controller" }
						: resource,
				),
			}),
		).toBe(false);
	});
	it.each([
		{ uid: "" },
		{ uid: "   " },
		{ resourceVersion: "" },
		{ namespace: "another-namespace" },
		{ name: "another-sandbox" },
	])("rejects an incomplete or foreign resource identity %j", (changes) => {
		expect(
			isSessionSandboxObservationValidV1(claim, {
				...ready,
				resources: ready.resources.map((resource) =>
					resource.kind === "Pod" ? { ...resource, ...changes } : resource,
				),
			}),
		).toBe(false);
	});
	it("does not substitute a duplicate kind for a missing identity or mark a stopped target ready", () => {
		expect(
			isSessionSandboxObservationValidV1(claim, {
				...ready,
				resources: [...ready.resources, ...ready.resources],
			}),
		).toBe(false);
		expect(
			isSessionSandboxObservationValidV1(
				{ ...claim, desiredState: "stopped" },
				ready,
			),
		).toBe(false);
	});
});

describe("Session Sandbox observation decision", () => {
	it.each(["Pod", "PersistentVolumeClaim"] as const)(
		"retains old identities when %s is replaced without proof",
		(kind) => {
			const replacement = {
				...ready,
				resources: ready.resources.map((resource) =>
					resource.kind === kind
						? { ...resource, uid: "unproved-replacement" }
						: resource,
				),
			};
			expect(
				decideSessionSandboxObservationV1(claim, ready, replacement),
			).toEqual({ status: "unknown", observation: ready, finished: false });
		},
	);
	it("retains old evidence on an unknown partial observation", () => {
		expect(
			decideSessionSandboxObservationV1(claim, ready, {
				status: "unknown",
				resources: [],
			}),
		).toEqual({ status: "unknown", observation: ready, finished: false });
	});
	it("accepts newer versions of the same observed identities", () => {
		const refreshed = {
			...ready,
			resources: ready.resources.map((resource) => ({
				...resource,
				resourceVersion: "13",
			})),
		};
		expect(decideSessionSandboxObservationV1(claim, ready, refreshed)).toEqual({
			status: "ready",
			observation: refreshed,
			finished: true,
		});
	});
});

describe("Session Sandbox reconcile retry pacing (#2456)", () => {
	it("keeps the base delay through the grace attempts, then doubles up to the cap", () => {
		expect(
			[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 64].map(
				sessionSandboxRetryDelayMsV1,
			),
		).toEqual([
			1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 8_000, 16_000,
			32_000, 60_000, 60_000, 60_000,
		]);
	});

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects the invalid streak %s",
		(streak) => {
			expect(() => sessionSandboxRetryDelayMsV1(streak)).toThrow(TypeError);
		},
	);

	const progressOf = (
		overrides: Partial<
			Parameters<typeof sessionSandboxReconcileProgressV1>[0]
		> = {},
	) =>
		sessionSandboxReconcileProgressV1({
			status: "unknown",
			finished: false,
			observation: ready,
			hasStopReceipt: false,
			...overrides,
		});
	const deletion = (
		kind: "Pod" | "Service",
		state: SessionSandboxDeletionProgressV1["state"],
	): SessionSandboxDeletionProgressV1 => {
		const resource = ready.resources.find((item) => item.kind === kind);
		if (!resource) throw new Error("fixture resource is missing");
		return {
			schemaVersion: 1,
			state,
			deleteAttemptId: `attempt-${kind}`,
			deleteAttempted: state !== "delete-requested",
			deleteCallResult:
				state === "delete-requested" ? "not-attempted" : "acknowledged",
			sourceGeneration: 1,
			resourceFence: 1,
			managementFence: 1,
			resource: resource as SessionSandboxDeletionProgressV1["resource"],
			preconditions: {
				uid: resource.uid,
				resourceVersion: resource.resourceVersion,
			},
			...(state === "absent"
				? {
						absence: {
							kind,
							namespace: resource.namespace,
							name: resource.name,
						},
					}
				: {}),
		};
	};

	it("ignores resourceVersion churn and resource order, but not identity or state", () => {
		const base = progressOf();
		expect(base).toMatch(/^[0-9a-f]{32}$/);
		expect(
			progressOf({
				observation: {
					...ready,
					resources: [...ready.resources]
						.reverse()
						.map((resource) => ({ ...resource, resourceVersion: "999" })),
				},
			}),
		).toBe(base);
		const changed = [
			progressOf({ status: "ready" }),
			progressOf({ finished: true }),
			progressOf({ hasStopReceipt: true }),
			progressOf({ observation: { ...ready, status: "unknown" } }),
			progressOf({
				observation: {
					...ready,
					resources: ready.resources.map((resource) =>
						resource.kind === "Pod"
							? { ...resource, uid: "replacement" }
							: resource,
					),
				},
			}),
			progressOf({
				observation: { ...ready, resources: ready.resources.slice(1) },
			}),
			progressOf({ deletionProgress: [deletion("Pod", "delete-requested")] }),
		];
		expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
		expect(
			progressOf({ deletionProgress: [deletion("Pod", "absent")] }),
		).not.toBe(
			progressOf({ deletionProgress: [deletion("Pod", "delete-requested")] }),
		);
		// 删除进度的顺序不影响指纹。
		expect(
			progressOf({
				deletionProgress: [
					deletion("Pod", "absent"),
					deletion("Service", "absent"),
				],
			}),
		).toBe(
			progressOf({
				deletionProgress: [
					deletion("Service", "absent"),
					deletion("Pod", "absent"),
				],
			}),
		);
	});

	it("backs off only while an unknown observation keeps the same evidence", () => {
		const progress = progressOf();
		let previous: unknown;
		const delays: number[] = [];
		const changes: boolean[] = [];
		for (let attempt = 0; attempt < 13; attempt += 1) {
			const next = nextSessionSandboxObservationBackoffV1({
				previous,
				progress,
				status: "unknown",
			});
			delays.push(next.delayMs);
			changes.push(next.changed);
			previous = next.backoff;
		}
		// 首次观测写审计且按基础延迟；之后的相同证据不写审计，从第 6 次重复起翻倍。
		expect(changes).toEqual([true, ...Array(12).fill(false)]);
		expect(delays).toEqual([
			1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 8_000, 16_000,
			32_000, 60_000, 60_000,
		]);
	});

	it("returns to the base delay and writes an audit row when the evidence changes", () => {
		let previous: unknown;
		const progress = progressOf();
		for (let attempt = 0; attempt < 10; attempt += 1)
			previous = nextSessionSandboxObservationBackoffV1({
				previous,
				progress,
				status: "unknown",
			}).backoff;
		const next = nextSessionSandboxObservationBackoffV1({
			previous,
			progress: progressOf({ hasStopReceipt: true }),
			status: "unknown",
		});
		expect(next).toMatchObject({
			changed: true,
			delayMs: 1_000,
			backoff: { unchanged: 0 },
		});
	});

	it("never slows the wait for readiness or deletion, only the audit rows", () => {
		let previous: unknown;
		const progress = progressOf({ status: "observed" });
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const next = nextSessionSandboxObservationBackoffV1({
				previous,
				progress,
				status: "observed",
			});
			expect(next.delayMs).toBe(1_000);
			expect(next.changed).toBe(attempt === 0);
			previous = next.backoff;
		}
	});

	it("treats unrecognized persisted state as a change and bounds the streak", () => {
		const progress = progressOf();
		for (const previous of [
			undefined,
			null,
			"text",
			[],
			{},
			{ progress: "short", unchanged: 3 },
			{ progress, unchanged: -1 },
			{ progress, unchanged: 1.5 },
			{ progress: progress.toUpperCase(), unchanged: 2 },
		])
			expect(
				nextSessionSandboxObservationBackoffV1({
					previous,
					progress,
					status: "unknown",
				}),
			).toMatchObject({ changed: true, backoff: { unchanged: 0 } });
		expect(
			nextSessionSandboxObservationBackoffV1({
				previous: { progress, unchanged: 1_000_000 },
				progress,
				status: "unknown",
			}).backoff.unchanged,
		).toBe(64);
	});
});
