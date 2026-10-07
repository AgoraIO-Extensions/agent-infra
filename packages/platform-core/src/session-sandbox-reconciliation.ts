import type { SessionSandboxBindingV1 } from "./session-sandbox.js";
import type {
	SessionSandboxLifecycleV1,
	SessionSandboxSourceV1,
	SessionSandboxStopReceiptV1,
} from "./session-sandbox-lifecycle.js";
import type { TaskAuthorizationBoundaryV1 } from "./task-authorization.js";

export interface SessionSandboxPolicyV1 {
	readonly namespace: string;
	readonly resourceConfigurationHash: string;
}

export interface SessionSandboxVerifiedPolicyV1 extends SessionSandboxPolicyV1 {
	readonly configurationRevision: number;
	readonly workloadRevision: number;
	readonly managementFence: number;
	readonly imageDigest: string;
}

export interface SessionSandboxResourceIdentityV1 {
	readonly kind:
		| "StatefulSet"
		| "Pod"
		| "Service"
		| "ServiceAccount"
		| "PersistentVolumeClaim"
		| "NetworkPolicy"
		| "Secret";
	readonly namespace: string;
	readonly name: string;
	readonly uid: string;
	readonly resourceVersion: string;
	/** Actual Pod controller owner-reference UID, when a StatefulSet is used. */
	readonly controllerUid?: string;
}

export type SessionSandboxDeletionProgressStateV1 =
	| "delete-requested"
	| "absent"
	| "unknown";
const sessionSandboxDeletionProgressStates = new Set([
	"delete-requested",
	"absent",
	"unknown",
]);

/** Durable per-resource cleanup evidence; absence is not a DELETE ACK. */
export interface SessionSandboxDeletionProgressV1 {
	readonly schemaVersion: 1;
	readonly state: SessionSandboxDeletionProgressStateV1;
	/** Stable id for the conditional DELETE attempt; survives lost responses. */
	readonly deleteAttemptId: string;
	readonly deleteAttempted: boolean;
	readonly deleteCallResult:
		| "not-attempted"
		| "acknowledged"
		| "failed"
		| "unknown";
	readonly sourceGeneration: number;
	readonly resourceFence: number;
	readonly managementFence: number;
	readonly resource: SessionSandboxResourceIdentityV1;
	readonly preconditions: {
		readonly uid: string;
		readonly resourceVersion: string;
	};
	readonly absence?: {
		readonly kind: SessionSandboxResourceIdentityV1["kind"];
		readonly namespace: string;
		readonly name: string;
	};
}

/** Resource reconciliation has no business Execution or Turn delivery fence. */
export interface SessionSandboxReconciliationClaimV1 {
	readonly schemaVersion: 1;
	readonly operation: "conversation.sandbox.reconcile.v1";
	readonly execution: null;
	readonly itemId: string;
	readonly leaseOwner: string;
	readonly deliveryFence: number;
	readonly sandbox: SessionSandboxBindingV1;
	readonly resourceFence: number;
	readonly resourceStatus: "applying" | "unknown";
	readonly desiredState: "running" | "stopped";
	readonly authorization: TaskAuthorizationBoundaryV1 | null;
	readonly purpose: "prepare" | "drain";
	/** False preserves the original Service/control route and compute until Execution termination. */
	readonly drainComputeAllowed: boolean;
	readonly lifecycle: SessionSandboxLifecycleV1 | null;
	readonly policy: SessionSandboxVerifiedPolicyV1;
	/** Original verified configuration; resource names still come from the Session binding. */
	readonly deployment: unknown;
	/**
	 * Verified Runtime model projection captured with `deployment`; the Worker
	 * accepts only a keyless V4 projection and never derives one itself.
	 */
	readonly modelProjection: unknown;
	readonly previousObservation: SessionSandboxObservationV1 | null;
}

export interface SessionSandboxObservationV1 {
	readonly status: "observed" | "ready" | "stopped" | "unknown";
	readonly sourceStop?: SessionSandboxStopReceiptV1;
	readonly deletionProgress?: readonly SessionSandboxDeletionProgressV1[];
	readonly resources: readonly SessionSandboxResourceIdentityV1[];
}

export function isSessionSandboxDeletionProgressValidV1(
	progress: readonly SessionSandboxDeletionProgressV1[] | undefined,
): progress is readonly SessionSandboxDeletionProgressV1[] {
	if (progress === undefined) return true;
	if (!Array.isArray(progress)) return false;
	const kinds = new Set<string>();
	return progress.every((entry) => {
		if (
			!entry ||
			entry.schemaVersion !== 1 ||
			!sessionSandboxDeletionProgressStates.has(entry.state) ||
			typeof entry.deleteAttemptId !== "string" ||
			!entry.deleteAttemptId.trim() ||
			typeof entry.deleteAttempted !== "boolean" ||
			!["not-attempted", "acknowledged", "failed", "unknown"].includes(
				entry.deleteCallResult,
			) ||
			entry.deleteAttempted !== (entry.deleteCallResult !== "not-attempted") ||
			!Number.isSafeInteger(entry.sourceGeneration) ||
			entry.sourceGeneration < 0 ||
			!Number.isSafeInteger(entry.resourceFence) ||
			entry.resourceFence < 0 ||
			!Number.isSafeInteger(entry.managementFence) ||
			entry.managementFence < 0 ||
			!entry.resource ||
			![
				"StatefulSet",
				"Pod",
				"Service",
				"ServiceAccount",
				"NetworkPolicy",
				"Secret",
			].includes(entry.resource.kind) ||
			![
				entry.resource.namespace,
				entry.resource.name,
				entry.resource.uid,
				entry.resource.resourceVersion,
			].every((value) => typeof value === "string" && value.trim()) ||
			kinds.has(entry.resource.kind) ||
			entry.resource.kind === "PersistentVolumeClaim" ||
			entry.preconditions?.uid !== entry.resource.uid ||
			entry.preconditions.resourceVersion !== entry.resource.resourceVersion
		)
			return false;
		if (entry.state === "absent") {
			if (
				!entry.absence ||
				entry.absence.kind !== entry.resource.kind ||
				entry.absence.namespace !== entry.resource.namespace ||
				entry.absence.name !== entry.resource.name
			)
				return false;
		} else if (entry.absence) return false;
		kinds.add(entry.resource.kind);
		return true;
	});
}

/** One durable intent precedes all call/absence evidence and cannot be replaced. */
export function canAdvanceSessionSandboxDeletionProgressV1(
	previous: SessionSandboxDeletionProgressV1 | undefined,
	next: SessionSandboxDeletionProgressV1,
): boolean {
	if (!isSessionSandboxDeletionProgressValidV1([next])) return false;
	if (!previous)
		return next.state === "delete-requested" && !next.deleteAttempted;
	if (!isSessionSandboxDeletionProgressValidV1([previous])) return false;
	return (
		previous.deleteAttemptId === next.deleteAttemptId &&
		previous.sourceGeneration === next.sourceGeneration &&
		previous.resourceFence === next.resourceFence &&
		previous.managementFence === next.managementFence &&
		previous.resource.kind === next.resource.kind &&
		previous.resource.namespace === next.resource.namespace &&
		previous.resource.name === next.resource.name &&
		previous.resource.uid === next.resource.uid &&
		previous.resource.resourceVersion === next.resource.resourceVersion &&
		previous.resource.controllerUid === next.resource.controllerUid &&
		(!previous.deleteAttempted || next.deleteAttempted) &&
		(previous.deleteCallResult !== "acknowledged" ||
			next.deleteCallResult === "acknowledged") &&
		(previous.state !== "absent" || next.state === "absent")
	);
}

/** Persisted resource facts, not a grant to call or recreate the Runtime. */
export interface SessionSandboxRuntimeStateV1 {
	/** Source facts only; require original control-purpose authority and live resource verification. */
	readonly controlSource?: SessionSandboxSourceV1;
	readonly sandbox: SessionSandboxBindingV1;
	readonly resourceFence: number;
	readonly desiredState: "running" | "stopped";
	readonly status:
		| "allocated"
		| "applying"
		| "observed"
		| "ready"
		| "stopped"
		| "unknown"
		| "unavailable";
	readonly policy: SessionSandboxVerifiedPolicyV1 | null;
	readonly observation: SessionSandboxObservationV1 | null;
}

/** Readiness requires separately observed identities; an endpoint or single UID is insufficient. */
export function isSessionSandboxObservationValidV1(
	claim: Pick<
		SessionSandboxReconciliationClaimV1,
		"sandbox" | "policy" | "desiredState"
	>,
	observation: SessionSandboxObservationV1,
): boolean {
	if (
		!observation ||
		!["observed", "ready", "stopped", "unknown"].includes(observation.status) ||
		!Array.isArray(observation.resources)
	)
		return false;
	if (!isSessionSandboxDeletionProgressValidV1(observation.deletionProgress))
		return false;
	const required = new Set([
		"Pod",
		"Service",
		"ServiceAccount",
		"PersistentVolumeClaim",
		"NetworkPolicy",
		"Secret",
	]);
	const seen = new Set<string>();
	for (const resource of observation.resources) {
		if (
			!resource ||
			(!required.has(resource.kind) && resource.kind !== "StatefulSet") ||
			seen.has(resource.kind) ||
			resource.namespace !== claim.policy.namespace ||
			typeof resource.uid !== "string" ||
			!resource.uid.trim() ||
			typeof resource.resourceVersion !== "string" ||
			!resource.resourceVersion.trim() ||
			typeof resource.name !== "string" ||
			(resource.controllerUid !== undefined &&
				(resource.kind !== "Pod" ||
					typeof resource.controllerUid !== "string" ||
					!resource.controllerUid.trim())) ||
			!(
				resource.name === claim.sandbox.resourceName ||
				resource.name.startsWith(`${claim.sandbox.resourceName}-`)
			)
		)
			return false;
		seen.add(resource.kind);
	}
	if (observation.status === "ready") {
		const pod = observation.resources.find(
			(resource) => resource.kind === "Pod",
		);
		const controller = observation.resources.find(
			(resource) => resource.kind === "StatefulSet",
		);
		return (
			claim.desiredState === "running" &&
			[...required].every((kind) => seen.has(kind)) &&
			pod?.controllerUid === controller?.uid
		);
	}
	if (observation.status === "stopped") return claim.desiredState === "stopped";
	return true;
}

/** Unproved identity replacement cannot release the original resource occupancy. */
export function decideSessionSandboxObservationV1(
	claim: Pick<
		SessionSandboxReconciliationClaimV1,
		"sandbox" | "policy" | "desiredState"
	> &
		Partial<Pick<SessionSandboxReconciliationClaimV1, "lifecycle">>,
	previous: SessionSandboxObservationV1 | null,
	observation: SessionSandboxObservationV1,
) {
	if (!isSessionSandboxObservationValidV1(claim, observation))
		throw new TypeError("Invalid Sandbox observation");
	const identityChanged =
		previous?.resources.some(
			(old) =>
				!observation.resources.some(
					(current) =>
						current.kind === old.kind &&
						current.name === old.name &&
						current.namespace === old.namespace &&
						current.uid === old.uid,
				),
		) ?? false;
	const resurrectedSource =
		claim.lifecycle?.stopReceipt?.removed.some(({ resource: old }) =>
			observation.resources.some(
				(current) => current.kind === old.kind && current.uid === old.uid,
			),
		) ?? false;
	const unknown =
		observation.status === "unknown" || identityChanged || resurrectedSource;
	return {
		status: unknown ? ("unknown" as const) : observation.status,
		observation: unknown && previous ? previous : observation,
		finished:
			!unknown &&
			(observation.status === "ready" || observation.status === "stopped"),
	};
}

/** Admission/query projection of already persisted readiness; not a resource receipt. */
export function isSessionSandboxReadyV1(facts: {
	readonly status: string | null;
	readonly desiredState: string | null;
	readonly resourceFence: number;
	readonly observationStatus: string | null;
}): boolean {
	return (
		facts.status === "ready" &&
		facts.desiredState === "running" &&
		Number.isSafeInteger(facts.resourceFence) &&
		facts.resourceFence > 0 &&
		facts.observationStatus === "ready"
	);
}
