import { describe, expect, it } from "vitest";
import { createSessionSandboxBindingV1 } from "./session-sandbox.js";
import {
	decideSessionSandboxObservationV1,
	isSessionSandboxDeletionProgressValidV1,
	isSessionSandboxObservationValidV1,
	type SessionSandboxObservationV1,
	type SessionSandboxReconciliationClaimV1,
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
	it("accepts the five actual direct-Pod resources without a fabricated controller", () => {
		expect(isSessionSandboxObservationValidV1(claim, ready)).toBe(true);
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
