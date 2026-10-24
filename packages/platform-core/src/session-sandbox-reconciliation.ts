import { createHash } from "node:crypto";
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
	/**
	 * Workload revision of the verified deployment the Sandbox was prepared
	 * from (`deployment.workloadRevision`). A rollback re-promotes a deployment
	 * with its original value, so this is neither the reconciliation counter
	 * (`verifiedRevision`) nor the management lifecycle revision (#1480).
	 */
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
	// #1481（按 Sandbox 投影 Runtime 输入）之前准备的来源从未创建 Runtime Secret；
	// 只有排空判定这类来源是否完整时才传 false，其余就绪判定始终要求 Secret（#2885）。
	options: { readonly runtimeSecret?: boolean } = {},
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
			[...required].every(
				(kind) =>
					seen.has(kind) ||
					(kind === "Secret" && options.runtimeSecret === false),
			) &&
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

/** 调谐重试的基础延迟；与历史固定值一致，正常 prepare/drain 的节奏不变。 */
const sessionSandboxRetryBaseDelayMsV1 = 1_000;
/** 同一次停滞里保持基础延迟的重试次数；第 6 次起按 2 倍增长。 */
const sessionSandboxRetryBaseDelayRetriesV1 = 5;
/** 证据长期不变时的重试间隔上限；条目始终保留，只是不再每秒重试。 */
const sessionSandboxRetryMaxDelayMsV1 = 60_000;

/**
 * 同一次停滞里第 `retryCount` 次重试的延迟：前 5 次 1 s，之后 2、4、8、16、32 s
 * 逐次翻倍，封顶 60 s。`retryCount` 是该次停滞内的重试序号（从 1 开始），不是条目的
 * 总尝试次数；证据一旦变化就重新从 1 开始。
 */
export function sessionSandboxRetryDelayMsV1(retryCount: number): number {
	if (!Number.isSafeInteger(retryCount) || retryCount < 1)
		throw new TypeError("Sandbox retry count must be a positive integer");
	if (retryCount <= sessionSandboxRetryBaseDelayRetriesV1)
		return sessionSandboxRetryBaseDelayMsV1;
	return Math.min(
		sessionSandboxRetryMaxDelayMsV1,
		sessionSandboxRetryBaseDelayMsV1 *
			2 ** (retryCount - sessionSandboxRetryBaseDelayRetriesV1),
	);
}

/**
 * 一次调谐尝试的进度指纹。只包含决定“有没有进展”的事实：Sandbox 身份与代际
 * （sandboxId、sessionGeneration、resourceFence，替换后的 Sandbox 不会继承上一代的
 * 指纹）、分配状态、观测状态、资源身份集合（不含 resourceVersion，Pod 状态抖动不算
 * 进展）、删除进度、停止回执和恢复请求（空闲回收后的恢复必须立刻重新计时，不能沿用
 * 上一段停滞累积的退避）。
 */
export function sessionSandboxReconcileProgressV1(input: {
	readonly sandboxId: string;
	readonly sessionGeneration: number;
	readonly resourceFence: number;
	readonly status: string;
	readonly finished: boolean;
	readonly observation: SessionSandboxObservationV1;
	readonly deletionProgress?: readonly SessionSandboxDeletionProgressV1[];
	readonly hasStopReceipt: boolean;
	readonly resumeRequested: boolean;
}): string {
	const resources = input.observation.resources
		.map((resource) =>
			[
				resource.kind,
				resource.namespace,
				resource.name,
				resource.uid,
				resource.controllerUid ?? "",
			].join("|"),
		)
		.sort();
	const deletion = (input.deletionProgress ?? [])
		.map((entry) =>
			[
				entry.resource.kind,
				entry.resource.uid,
				entry.state,
				entry.deleteCallResult,
			].join("|"),
		)
		.sort();
	return createHash("sha256")
		.update(
			JSON.stringify([
				input.sandboxId,
				input.sessionGeneration,
				input.resourceFence,
				input.status,
				input.finished,
				input.observation.status,
				input.hasStopReceipt,
				input.resumeRequested,
				resources,
				deletion,
			]),
		)
		.digest("hex")
		.slice(0, 32);
}

/**
 * 记录一次观测后的重试决定。`previous` 是上一次“有变化”的审计行：它的进度指纹，以及
 * 写出该行时的 outbox 尝试次数（`attempt_count`）。指纹相同视为没有变化：不再写审计，
 * 并按停滞期间的连续重试序号退避，避免不可恢复配置或 CrashLoop 让 Worker 热循环。没有记录、
 * 或记录无法识别（例如旧版本写的审计行没有指纹或尝试次数），都按
 * “有变化”处理。
 */
export function decideSessionSandboxRetryV1(input: {
	readonly previous:
		| { readonly progress: unknown; readonly attempt: unknown }
		| undefined;
	readonly progress: string;
	readonly attemptCount: unknown;
	readonly status: string;
}): { readonly changed: boolean; readonly delayMs: number } {
	const { previous } = input;
	const attemptCount = input.attemptCount;
	const unchanged =
		previous !== undefined &&
		previous.progress === input.progress &&
		Number.isSafeInteger(previous.attempt) &&
		(previous.attempt as number) >= 0 &&
		Number.isSafeInteger(attemptCount) &&
		(attemptCount as number) > (previous.attempt as number);
	return {
		changed: !unchanged,
		delayMs: unchanged
			? sessionSandboxRetryDelayMsV1(
					// 同一次停滞里的重试序号；乱序或异常的计数不会给出非法值。
					Math.max(1, (attemptCount as number) - (previous.attempt as number)),
				)
			: sessionSandboxRetryBaseDelayMsV1,
	};
}
