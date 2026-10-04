import type { AgentManagementWritePlanV1 } from "./agent-management.js";
import type { SessionSandboxBindingV1 } from "./session-sandbox.js";
import {
	isSessionSandboxObservationValidV1,
	type SessionSandboxObservationV1,
	type SessionSandboxResourceIdentityV1,
	type SessionSandboxVerifiedPolicyV1,
} from "./session-sandbox-reconciliation.js";

/** Immutable source evidence survives changes to the target management intent. */
export interface SessionSandboxSourceV1 {
	readonly sandbox: SessionSandboxBindingV1;
	readonly resourceFence: number;
	readonly policy: SessionSandboxVerifiedPolicyV1 | null;
	readonly observation: SessionSandboxObservationV1 | null;
	/** Original verified preparation input; absent for allocations never prepared. */
	readonly deployment?: unknown;
}

export interface SessionSandboxStopReceiptV1 {
	readonly schemaVersion: 1;
	readonly sandboxId: string;
	readonly sessionId: string;
	readonly sourceGeneration: number;
	readonly sourceResourceFence: number;
	readonly targetGeneration: number;
	readonly targetResourceFence: number;
	readonly removed: readonly {
		readonly resource: SessionSandboxResourceIdentityV1;
		readonly preconditions: {
			readonly uid: string;
			readonly resourceVersion: string;
		};
		readonly absence: {
			readonly kind: SessionSandboxResourceIdentityV1["kind"];
			readonly namespace: string;
			readonly name: string;
		};
	}[];
	readonly retainedPVC: SessionSandboxResourceIdentityV1;
}

/** Carried by the original durable resource outbox, never a business grant. */
export interface SessionSandboxLifecycleV1 {
	readonly schemaVersion: 1;
	readonly authority: {
		readonly kind: "management";
		readonly applicationId: string;
		readonly managementRevision: number;
		readonly managementFence: number;
		readonly workloadRevision: number;
		readonly targetDesiredState: "running" | "stopped";
	};
	readonly source: SessionSandboxSourceV1;
	/** Original outbox proved no resource preparation was ever authorized. */
	readonly sourceState?: "never-prepared";
	readonly stopReceipt: SessionSandboxStopReceiptV1 | null;
	/** Set atomically before any replacement mutation can be authorized. */
	readonly preparation?: {
		readonly generation: number;
		readonly resourceFence: number;
	};
}

export function planSessionSandboxManagementTransitionV1(input: {
	readonly plan: AgentManagementWritePlanV1;
	readonly current: SessionSandboxSourceV1;
	readonly status: string;
	readonly sourceSnapshot?: SessionSandboxSourceV1;
	readonly previous: SessionSandboxLifecycleV1 | null;
	readonly originalIntent?: {
		readonly status: string;
		readonly attemptCount: number;
		readonly deliveryFence: number;
	};
}) {
	const { plan, current, previous } = input;
	if (
		!plan.outboxIntent ||
		plan.state.agentId !== current.sandbox.agentId ||
		!Number.isSafeInteger(current.resourceFence) ||
		current.resourceFence < 0 ||
		current.resourceFence >= Number.MAX_SAFE_INTEGER
	)
		throw new TypeError("Invalid Sandbox management transition");
	// Once new resources have been observed, they become the next source. Until
	// then a later management intent cannot erase the original drain obligation.
	const retained =
		previous &&
		!previous.preparation &&
		input.status !== "ready" &&
		input.status !== "observed";
	const source = retained ? previous.source : (input.sourceSnapshot ?? current);
	if (
		source.sandbox.sandboxId !== current.sandbox.sandboxId ||
		source.sandbox.sessionId !== current.sandbox.sessionId ||
		source.sandbox.agentId !== current.sandbox.agentId ||
		source.sandbox.principal.kind !== current.sandbox.principal.kind ||
		source.sandbox.principal.id !== current.sandbox.principal.id ||
		source.sandbox.channelId !== current.sandbox.channelId ||
		source.sandbox.generation > current.sandbox.generation
	)
		throw new TypeError("Sandbox lifecycle source changed");
	const neverPrepared =
		source.resourceFence === 0 &&
		source.policy === null &&
		source.observation === null &&
		source.deployment === null &&
		(retained
			? previous.sourceState === "never-prepared"
			: !previous &&
				!input.sourceSnapshot &&
				input.status === "allocated" &&
				input.originalIntent?.status === "pending" &&
				input.originalIntent.attemptCount === 0 &&
				input.originalIntent.deliveryFence === 0);
	const settled = neverPrepared && plan.state.desiredState === "stopped";

	return {
		resourceFence: current.resourceFence + 1,
		status: settled
			? "stopped"
			: input.status === "unknown"
				? "unknown"
				: "unavailable",
		settled,
		desiredState: "stopped" as const,
		lifecycle: {
			schemaVersion: 1,
			authority: {
				kind: "management",
				applicationId: plan.state.applicationId,
				managementRevision: plan.state.revision,
				managementFence: plan.state.fence,
				workloadRevision: plan.state.workloadRevision,
				targetDesiredState: plan.state.desiredState,
			},
			source,
			...(neverPrepared ? { sourceState: "never-prepared" as const } : {}),
			stopReceipt: retained ? previous.stopReceipt : null,
		} satisfies SessionSandboxLifecycleV1,
	};
}

/** Only a complete per-object stop proof may replace the saved source identities. */
export function decideSessionSandboxDrainObservationV1(input: {
	readonly sandbox: SessionSandboxBindingV1;
	readonly resourceFence: number;
	readonly lifecycle: SessionSandboxLifecycleV1;
	readonly observation: SessionSandboxObservationV1;
}) {
	const { lifecycle, observation, sandbox, resourceFence } = input;
	const source = lifecycle.source;
	const receipt = observation.sourceStop;
	const unknown = () => ({
		status: "unknown" as const,
		observation: source.observation ?? {
			status: "unknown" as const,
			resources: [],
		},
		finished: false,
		stopReceipt: null,
	});
	// A prepare may have created resources before its observation committed.
	// Adopt only a complete owned readback, preserving every previously known UID.
	// This is evidence refinement, never readiness or stop/absence proof.
	if (
		observation.status === "observed" &&
		!observation.sourceStop &&
		source.policy &&
		!lifecycle.stopReceipt &&
		!lifecycle.preparation &&
		isSessionSandboxObservationValidV1(
			{
				sandbox: source.sandbox,
				policy: source.policy,
				desiredState: "running",
			},
			{ ...observation, status: "ready" },
		) &&
		(source.observation?.resources ?? []).every((prior) =>
			observation.resources.some(
				(current) =>
					current.kind === prior.kind &&
					current.namespace === prior.namespace &&
					current.name === prior.name &&
					current.uid === prior.uid &&
					current.controllerUid === prior.controllerUid,
			),
		)
	) {
		return { ...unknown(), observation };
	}
	if (
		observation.status !== "stopped" ||
		!receipt ||
		!source.observation ||
		!source.policy ||
		receipt.schemaVersion !== 1 ||
		receipt.sandboxId !== sandbox.sandboxId ||
		receipt.sessionId !== sandbox.sessionId ||
		receipt.sourceGeneration !== source.sandbox.generation ||
		receipt.sourceResourceFence !== source.resourceFence ||
		receipt.targetGeneration !== sandbox.generation ||
		receipt.targetResourceFence !== resourceFence ||
		!Array.isArray(receipt.removed) ||
		!Array.isArray(observation.resources)
	)
		return unknown();
	if (
		!isSessionSandboxObservationValidV1(
			{
				sandbox: source.sandbox,
				policy: source.policy,
				desiredState: "running",
			},
			{ ...source.observation, status: "ready" },
		)
	)
		return unknown();
	const prior = source.observation.resources;
	const sameIdentity = (
		old: SessionSandboxResourceIdentityV1,
		current: SessionSandboxResourceIdentityV1 | undefined,
	) =>
		!!current &&
		old.kind === current.kind &&
		old.namespace === current.namespace &&
		old.name === current.name &&
		old.uid === current.uid &&
		typeof current.resourceVersion === "string" &&
		!!current.resourceVersion.trim();
	const pvc = prior.find(
		(resource) => resource.kind === "PersistentVolumeClaim",
	);
	if (
		!pvc ||
		!sameIdentity(pvc, receipt.retainedPVC) ||
		observation.resources.length !== 1 ||
		!sameIdentity(receipt.retainedPVC, observation.resources[0])
	)
		return unknown();
	const removed = prior.filter(
		(resource) => resource.kind !== "PersistentVolumeClaim",
	);
	if (
		removed.length !== receipt.removed.length ||
		new Set(receipt.removed.map((item) => item?.resource?.kind)).size !==
			removed.length
	)
		return unknown();
	for (const old of removed) {
		const proof = receipt.removed.find(
			(item) => item?.resource?.kind === old.kind,
		);
		if (
			!proof ||
			!sameIdentity(old, proof.resource) ||
			proof.preconditions?.uid !== proof.resource.uid ||
			proof.preconditions.resourceVersion !== proof.resource.resourceVersion ||
			proof.absence?.kind !== old.kind ||
			proof.absence.namespace !== old.namespace ||
			proof.absence.name !== old.name
		)
			return unknown();
	}
	// Removal and same-target absence of the source Service is the closed route
	// proof; a detached endpoint or boolean cannot stand in for it.
	return {
		status: "stopped" as const,
		observation,
		finished: true,
		stopReceipt: receipt,
	};
}

/** Resource absence never decides an original Execution outcome or frees unknown occupancy. */
export function canDrainSessionSandboxComputeV1(
	executionStatuses: readonly string[],
): boolean {
	return executionStatuses.every((status) =>
		["completed", "failed", "cancelled"].includes(status),
	);
}

/** A persisted source-stop proof permits preparation, never business execution. */
export function canPrepareSessionSandboxReplacementV1(input: {
	readonly sandbox: SessionSandboxBindingV1;
	readonly resourceFence: number;
	readonly lifecycle: SessionSandboxLifecycleV1;
	readonly observation: SessionSandboxObservationV1 | null;
	readonly executions: readonly {
		readonly status: string;
		readonly deliveryFence: number;
	}[];
	readonly generationBarrierPending: boolean;
}): boolean {
	const { sandbox, resourceFence, lifecycle, observation } = input;
	const receipt = lifecycle.stopReceipt;
	if (
		(lifecycle.preparation &&
			(lifecycle.preparation.generation !== sandbox.generation ||
				lifecycle.preparation.resourceFence !== resourceFence)) ||
		lifecycle.authority.targetDesiredState !== "running" ||
		input.generationBarrierPending ||
		!input.executions.every(
			({ status, deliveryFence }) =>
				["completed", "failed", "cancelled"].includes(status) ||
				(["submitted", "waiting"].includes(status) && deliveryFence === 0),
		)
	)
		return false;
	if (lifecycle.sourceState === "never-prepared") {
		const source = lifecycle.source;
		return (
			!receipt &&
			source.resourceFence === 0 &&
			source.policy === null &&
			source.observation === null &&
			source.deployment === null &&
			source.sandbox.generation === sandbox.generation &&
			Number.isSafeInteger(resourceFence) &&
			resourceFence > 0 &&
			(!!lifecycle.preparation || observation === null)
		);
	}
	if (
		!receipt ||
		!Number.isSafeInteger(receipt.targetGeneration) ||
		receipt.targetGeneration < lifecycle.source.sandbox.generation ||
		receipt.targetGeneration > sandbox.generation ||
		!Number.isSafeInteger(receipt.targetResourceFence) ||
		receipt.targetResourceFence <= lifecycle.source.resourceFence ||
		receipt.targetResourceFence > resourceFence
	)
		return false;

	if (
		!decideSessionSandboxDrainObservationV1({
			sandbox: { ...sandbox, generation: receipt.targetGeneration },
			resourceFence: receipt.targetResourceFence,
			lifecycle,
			observation: {
				status: "stopped",
				resources: [receipt.retainedPVC],
				sourceStop: receipt,
			},
		}).finished
	)
		return false;
	const pvc = observation?.resources.find(
		(resource) => resource.kind === "PersistentVolumeClaim",
	);
	return (
		!!pvc &&
		pvc.namespace === receipt.retainedPVC.namespace &&
		pvc.name === receipt.retainedPVC.name &&
		pvc.uid === receipt.retainedPVC.uid
	);
}
