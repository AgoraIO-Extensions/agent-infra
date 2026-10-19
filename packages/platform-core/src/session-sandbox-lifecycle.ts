import type {
	AgentManagementStateV1,
	AgentManagementWritePlanV1,
} from "./agent-management.js";
import type { SessionSandboxBindingV1 } from "./session-sandbox.js";
import {
	isSessionSandboxDeletionProgressValidV1,
	isSessionSandboxObservationValidV1,
	type SessionSandboxDeletionProgressV1,
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
	/** Verified model projection captured with `deployment`; null when not prepared. */
	readonly modelProjection?: unknown;
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
	/** Set only for an upgrade to the Agent's current verified deployment
	 * (ADR 0023); audit and "updating" display only, never an authorization. */
	readonly reason?: "upgrade" | "idle_reclaim";
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
	/** Set by a new message while an idle reclaim is draining or stopped. */
	readonly resumeRequested?: boolean;
	/** Per-resource cleanup intent/progress survives a lost response or restart. */
	readonly deletionProgress?: readonly SessionSandboxDeletionProgressV1[];
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
			...(retained ? { deletionProgress: previous.deletionProgress } : {}),
		} satisfies SessionSandboxLifecycleV1,
	};
}

/**
 * #1481（按 Sandbox 投影 Runtime 输入）之前准备的来源：记录了 deployment，却没有模型投影。
 * 当时不创建 Runtime Secret，所以不要求来源记录过 Secret（#2885）。之后缺模型投影的 prepare
 * 在任何写入之前失败；来源记录过的每个资源（包括 Secret）仍要逐个证明已删除。
 */
function isPreparedWithoutModelProjectionV1(source: SessionSandboxSourceV1) {
	return source.deployment != null && source.modelProjection == null;
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
	// Keep partial owned readbacks too, preserving every previously known UID.
	// This is evidence refinement, never readiness or stop/absence proof.
	const resources = Array.isArray(observation.resources)
		? observation.resources
		: [];
	const pod = resources.find((resource) => resource?.kind === "Pod");
	const controller = resources.find(
		(resource) => resource?.kind === "StatefulSet",
	);
	if (
		observation.status === "observed" &&
		resources.length > 0 &&
		(!pod || !controller || pod.controllerUid === controller.uid) &&
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
			observation,
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
		const { deletionProgress: _untrustedProgress, ...sourceObservation } =
			observation;
		return { ...unknown(), observation: sourceObservation };
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
	// #2917：上一轮排空已完成、只剩 PVC 的沙箱被管理转换重新当作来源时，没有需要删除的
	// 资源；停止证明只需证明保留的仍是来源记录的同一 PVC。
	if (source.observation.status === "stopped") {
		const [stoppedPVC] = prior;
		if (
			prior.length !== 1 ||
			stoppedPVC?.kind !== "PersistentVolumeClaim" ||
			!isSessionSandboxObservationValidV1(
				{
					sandbox: source.sandbox,
					policy: source.policy,
					desiredState: "stopped",
				},
				source.observation,
			) ||
			receipt.removed.length !== 0 ||
			!sameIdentity(stoppedPVC, receipt.retainedPVC) ||
			observation.resources.length !== 1 ||
			!sameIdentity(receipt.retainedPVC, observation.resources[0])
		)
			return unknown();
		return {
			status: "stopped" as const,
			observation,
			finished: true,
			stopReceipt: receipt,
		};
	}
	if (
		!isSessionSandboxObservationValidV1(
			{
				sandbox: source.sandbox,
				policy: source.policy,
				desiredState: "running",
			},
			{ ...source.observation, status: "ready" },
			{ runtimeSecret: !isPreparedWithoutModelProjectionV1(source) },
		)
	)
		return unknown();
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
	if (!isSessionSandboxDeletionProgressValidV1(lifecycle.deletionProgress))
		return unknown();
	for (const old of removed) {
		const progress = lifecycle.deletionProgress?.find(
			(entry) => entry.resource.kind === old.kind,
		);
		const proof = receipt.removed.find(
			(item) => item?.resource?.kind === old.kind,
		);
		if (
			!proof ||
			!progress ||
			progress.state !== "absent" ||
			progress.sourceGeneration !== source.sandbox.generation ||
			progress.resourceFence !== source.resourceFence ||
			progress.managementFence > lifecycle.authority.managementFence ||
			!sameIdentity(progress.resource, proof.resource) ||
			progress.preconditions.resourceVersion !==
				proof.preconditions?.resourceVersion ||
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

/** Work that never reached a Runtime (#1522 writes `unknown` before any send)
 * holds no Sandbox side effect; `processing`/`unknown` keep their occupancy. */
function holdsNoSandboxWorkV1(status: string): boolean {
	return ["completed", "failed", "cancelled", "submitted", "waiting"].includes(
		status,
	);
}

/** Resource absence never decides an original Execution outcome or frees unknown occupancy.
 * Only execution status decides (ADR 0023): a Turn waiting for this very
 * drain already carries a delivery fence from its claim. */
export function canDrainSessionSandboxComputeV1(
	executionStatuses: readonly string[],
): boolean {
	return executionStatuses.every(holdsNoSandboxWorkV1);
}

/**
 * Plans the upgrade of one idle Sandbox to the Agent's current verified
 * deployment (ADR 0023). The intent reuses the management lifecycle: drain
 * the source, keep its PVC, then re-prepare under the current authority.
 * Returns null whenever the Sandbox is not idle, not settled or not stale.
 */
export function planSessionSandboxUpgradeTransitionV1(input: {
	readonly management: Pick<
		AgentManagementStateV1,
		| "applicationId"
		| "agentId"
		| "status"
		| "revision"
		| "fence"
		| "workloadRevision"
		| "desiredState"
	>;
	readonly current: SessionSandboxSourceV1;
	readonly allocation: {
		readonly status: string;
		readonly desiredState: string;
	};
	/** The Sandbox's original reconcile intent; only a settled one may restart. */
	readonly intent: { readonly status: string } | null;
	readonly policyCurrent: boolean;
	readonly executionStatuses: readonly string[];
	readonly generationBarrierPending: boolean;
}) {
	const { management, current } = input;
	const deployment = current.deployment;
	if (
		input.policyCurrent ||
		management.agentId !== current.sandbox.agentId ||
		management.status !== "available" ||
		management.desiredState !== "running" ||
		input.allocation.status !== "ready" ||
		input.allocation.desiredState !== "running" ||
		input.intent?.status !== "succeeded" ||
		!Number.isSafeInteger(current.resourceFence) ||
		current.resourceFence < 1 ||
		current.resourceFence >= Number.MAX_SAFE_INTEGER ||
		!current.policy ||
		current.observation?.status !== "ready" ||
		deployment === null ||
		typeof deployment !== "object" ||
		input.generationBarrierPending ||
		!input.executionStatuses.every(holdsNoSandboxWorkV1)
	)
		return null;
	return {
		resourceFence: current.resourceFence + 1,
		status: "unavailable" as const,
		desiredState: "stopped" as const,
		lifecycle: {
			schemaVersion: 1,
			reason: "upgrade",
			authority: {
				kind: "management",
				applicationId: management.applicationId,
				managementRevision: management.revision,
				managementFence: management.fence,
				workloadRevision: management.workloadRevision,
				targetDesiredState: "running",
			},
			source: current,
			stopReceipt: null,
		} satisfies SessionSandboxLifecycleV1,
	};
}

/**
 * Plans a compute-only reclaim for a settled, idle Session Sandbox.
 * The lifecycle keeps the target authority as running so the existing
 * drain/reprepare path can be resumed by a later message, but the absence of
 * `resumeRequested` deliberately leaves the Sandbox stopped after the drain.
 *
 * 与 Magic 对齐（#2239）：空闲回收只看 Sandbox 自身，不要求所属 Agent 的
 * Workload 就绪，也不要求 policy 仍是当前版本；恢复时按 Agent 当前已验证部署
 * 重新准备，过期的 Sandbox 因此在恢复时完成升级。
 */
export function planSessionSandboxIdleReclaimTransitionV1(input: {
	readonly management: Pick<
		AgentManagementStateV1,
		| "applicationId"
		| "agentId"
		| "status"
		| "revision"
		| "fence"
		| "workloadRevision"
		| "desiredState"
	>;
	readonly current: SessionSandboxSourceV1;
	readonly allocation: {
		readonly status: string;
		readonly desiredState: string;
	};
	readonly intent: { readonly status: string } | null;
	readonly executionStatuses: readonly string[];
	readonly generationBarrierPending: boolean;
}) {
	const { management, current } = input;
	if (
		management.agentId !== current.sandbox.agentId ||
		management.status !== "available" ||
		management.desiredState !== "running" ||
		input.allocation.status !== "ready" ||
		input.allocation.desiredState !== "running" ||
		input.intent?.status !== "succeeded" ||
		!Number.isSafeInteger(current.resourceFence) ||
		current.resourceFence < 1 ||
		current.resourceFence >= Number.MAX_SAFE_INTEGER ||
		!current.policy ||
		current.observation?.status !== "ready" ||
		current.deployment === null ||
		typeof current.deployment !== "object" ||
		input.generationBarrierPending ||
		!canReclaimIdleSessionSandboxV1(input.executionStatuses)
	)
		return null;
	return {
		resourceFence: current.resourceFence + 1,
		status: "unavailable" as const,
		desiredState: "stopped" as const,
		lifecycle: {
			schemaVersion: 1,
			reason: "idle_reclaim" as const,
			authority: {
				kind: "management" as const,
				applicationId: management.applicationId,
				managementRevision: management.revision,
				managementFence: management.fence,
				workloadRevision: management.workloadRevision,
				targetDesiredState: "running" as const,
			},
			source: current,
			stopReceipt: null,
			resumeRequested: false,
		} satisfies SessionSandboxLifecycleV1,
	};
}

/** Idle reclaim is stricter than upgrade: waiting/submitted work must stay warm. */
export function canReclaimIdleSessionSandboxV1(
	executionStatuses: readonly string[],
) {
	return executionStatuses.every((status) =>
		["completed", "failed", "cancelled"].includes(status),
	);
}

/** Existing management lifecycles continue preparing; idle reclaim waits for a message. */
export function shouldContinueSessionSandboxPreparationV1(
	lifecycle: Pick<
		SessionSandboxLifecycleV1,
		"authority" | "reason" | "resumeRequested"
	>,
) {
	return (
		lifecycle.authority.targetDesiredState === "running" &&
		(lifecycle.reason !== "idle_reclaim" || lifecycle.resumeRequested === true)
	);
}

/** A persisted source-stop proof permits preparation, never business execution. */
export function canPrepareSessionSandboxReplacementV1(input: {
	readonly sandbox: SessionSandboxBindingV1;
	readonly resourceFence: number;
	readonly lifecycle: SessionSandboxLifecycleV1;
	readonly observation: SessionSandboxObservationV1 | null;
	readonly executions: readonly { readonly status: string }[];
	readonly generationBarrierPending: boolean;
}): boolean {
	const { sandbox, resourceFence, lifecycle, observation } = input;
	const receipt = lifecycle.stopReceipt;
	if (
		(lifecycle.reason === "idle_reclaim" &&
			lifecycle.resumeRequested !== true) ||
		(lifecycle.preparation &&
			(lifecycle.preparation.generation !== sandbox.generation ||
				lifecycle.preparation.resourceFence !== resourceFence)) ||
		lifecycle.authority.targetDesiredState !== "running" ||
		input.generationBarrierPending ||
		!input.executions.every(({ status }) => holdsNoSandboxWorkV1(status))
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
