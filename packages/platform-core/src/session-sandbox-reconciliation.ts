import type { SessionSandboxBindingV1 } from "./session-sandbox.js";
import type {
	SessionSandboxLifecycleV1,
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
		| "NetworkPolicy";
	readonly namespace: string;
	readonly name: string;
	readonly uid: string;
	readonly resourceVersion: string;
	/** Actual Pod controller owner-reference UID, when a StatefulSet is used. */
	readonly controllerUid?: string;
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
	/** False permits route closure only; original Execution control still owns termination. */
	readonly drainComputeAllowed: boolean;
	readonly lifecycle: SessionSandboxLifecycleV1 | null;
	readonly policy: SessionSandboxVerifiedPolicyV1;
	/** Original verified configuration; resource names still come from the Session binding. */
	readonly deployment: unknown;
	readonly previousObservation: SessionSandboxObservationV1 | null;
}

export interface SessionSandboxObservationV1 {
	readonly status: "observed" | "ready" | "stopped" | "unknown";
	readonly sourceStop?: SessionSandboxStopReceiptV1;
	readonly resources: readonly SessionSandboxResourceIdentityV1[];
}

/** Persisted resource facts, not a grant to call or recreate the Runtime. */
export interface SessionSandboxRuntimeStateV1 {
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
	const required = new Set([
		"Pod",
		"Service",
		"ServiceAccount",
		"PersistentVolumeClaim",
		"NetworkPolicy",
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
	>,
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
	const unknown = observation.status === "unknown" || identityChanged;
	return {
		status: unknown ? ("unknown" as const) : observation.status,
		observation: unknown && previous ? previous : observation,
		finished:
			!unknown &&
			(observation.status === "ready" || observation.status === "stopped"),
	};
}
