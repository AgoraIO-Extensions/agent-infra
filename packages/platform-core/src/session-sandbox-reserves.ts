import { createHash } from "node:crypto";
import type { ExecutorInstanceStateV2 } from "./executor-instance-types.js";
import type {
	SessionSandboxResourceIdentityV1,
	SessionSandboxVerifiedPolicyV1,
} from "./session-sandbox-reconciliation.js";

export interface SessionSandboxResourceBudgetV1 {
	readonly cpuMillis: number;
	readonly memoryBytes: number;
	readonly storageBytes: number;
}
/** The observed maximum remains conservative for sparse samples; it is not a population percentile. */
export function sessionSandboxReserveTargetV1(input: {
	minimum: number;
	maximum: number;
	newSessionCount: number;
	windowMs: number;
	replenishmentUpperBoundMs: number | null;
}): number {
	const duringRefill =
		input.replenishmentUpperBoundMs === null
			? 0
			: Math.ceil(
					(input.newSessionCount * input.replenishmentUpperBoundMs) /
						input.windowMs,
				);
	return Math.min(
		input.maximum,
		Math.max(input.minimum, input.newSessionCount > 0 ? duringRefill + 1 : 0),
	);
}
/** Deployment module input, never accepted from a Conversation command. Versions cover all secret-derived inputs without exposing them. */
export interface SessionSandboxReserveConfigurationV1 {
	readonly schemaVersion: 1;
	readonly enabled: boolean;
	readonly revision: number;
	readonly namespace: string;
	readonly totalBudget: SessionSandboxResourceBudgetV1;
	/** Approved actual CPU/memory/PVC specifications keyed by the verified resource policy hash. Unknown costs forbid new capacity. */
	readonly resourceCosts: readonly {
		readonly resourceConfigurationHash: string;
		readonly resources: SessionSandboxResourceBudgetV1;
	}[];
	readonly maximumReserves: number;
	readonly maximumConcurrentCreates: number;
	readonly ttlMs: number;
	readonly cooldownMs: number;
	readonly failureBackoffMs: number;
	readonly profiles: readonly {
		readonly agentId: string;
		readonly templateId: string;
		readonly imageDigest: string;
		readonly resourceConfigurationHash: string;
		readonly resources: SessionSandboxResourceBudgetV1;
		readonly storageConfigurationVersion: string;
		readonly networkPolicyVersion: string;
		readonly signingConfigurationVersion: string;
		readonly transportConfigurationVersion: string;
		readonly connectionConfigurationVersion: string;
		readonly minimum: number;
		readonly maximum: number;
	}[];
}
export interface SessionSandboxReserveProfileV1 {
	readonly maintenanceView?: true;
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly digest: string;
	readonly deploymentDigest: string;
	readonly modelProjectionDigest: string;
	readonly environmentDigest: string;
	readonly skillsDigest: string;
	readonly connectionConfigurationVersion: string;
	readonly networkPolicyVersion: string;
	readonly signingConfigurationVersion: string;
	readonly transportConfigurationVersion: string;
	readonly storageConfigurationVersion: string;
	readonly configurationRevision: number;
	readonly policy: SessionSandboxVerifiedPolicyV1;
	readonly resources: SessionSandboxResourceBudgetV1;
}
export type SessionSandboxReserveStatusV1 =
	| "preparing"
	| "ready"
	| "claimed"
	| "retiring"
	| "unknown";
export const sessionSandboxReserveResourceKindsV1 = [
	"Pod",
	"Service",
	"ServiceAccount",
	"PersistentVolumeClaim",
	"NetworkPolicy",
	"Secret",
] as const;
export type SessionSandboxReserveResourceKindV1 =
	(typeof sessionSandboxReserveResourceKindsV1)[number];
export interface SessionSandboxReserveOperationV1 {
	readonly attemptId: string;
	readonly operation: "create" | "delete";
	readonly kind: SessionSandboxReserveResourceKindV1;
	readonly name: string;
	readonly status: "pending" | "unknown" | "confirmed" | "rejected";
	/** Original identity for conditional DELETE; confirmed actual identity for CREATE. */
	readonly resource: SessionSandboxResourceIdentityV1 | null;
	readonly absent: boolean;
	/** Terminal response from the original create/delete call, distinct from observation. */
	readonly writeCompletion: "pending" | "response";
	readonly writer: { readonly owner: string; readonly fence: number };
}
export type SessionSandboxReserveOperationInputV1 = Omit<
	SessionSandboxReserveOperationV1,
	"writeCompletion" | "writer"
>;
/** This independent lease is revoked on claim; it is not generation/resourceFence. */
export interface SessionSandboxReserveLeaseV1 {
	readonly sandboxId: string;
	readonly leaseOwner: string;
	readonly deliveryFence: number;
}
export interface SessionSandboxReserveV1 {
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly agentId: string;
	readonly generation: 1;
	readonly resourceFence: 1;
	readonly status: SessionSandboxReserveStatusV1;
	readonly profile: SessionSandboxReserveProfileV1;
	readonly operations: readonly SessionSandboxReserveOperationV1[];
	readonly expiresAt: Date;
	/** Present only for an independent-executor reserve (HLD §10.3.1). */
	readonly executorStartup?: SessionSandboxReserveExecutorStartupV1 | null;
}
/** One writer-bound write of the one-time executor identity projection Secret. */
export interface SessionSandboxReserveProjectionWriteV1 {
	readonly attemptId: string;
	readonly status: "pending" | "unknown" | "confirmed" | "rejected";
	/** Actual identity once created; original identity for a conditional DELETE. */
	readonly resource: SessionSandboxResourceIdentityV1 | null;
	readonly absent: boolean;
	/** Terminal response of the original call, distinct from observation. */
	readonly writeCompletion: "pending" | "response";
	readonly writer: { readonly owner: string; readonly fence: number };
}
/**
 * Non-secret startup facts of one reserve Pod instance. The projection is a
 * temporary resource outside the six long-lived `operations` (Spec §10.1.1).
 */
export interface SessionSandboxReserveExecutorStartupV1 {
	readonly schemaVersion: 1;
	/** Original reserve-owned V2 ledger; no Conversation/allocation is invented. */
	readonly instance?: ExecutorInstanceStateV2;
	/** Original projection Secret name; V2 uses the immutable instance startup ref, legacy rows retain the Pod/fence ref. */
	readonly startupRef: string;
	/** Absolute deadline taken from the database clock before the Pod create. */
	readonly deadlineMs: number;
	readonly writer: { readonly owner: string; readonly fence: number };
	readonly projection: {
		readonly podUid: string;
		readonly hostKeyId: string;
		/** Public verification key fixed before the projection is published. */
		readonly hostPublicKey: string;
		readonly bindingDigest: string;
		readonly create: SessionSandboxReserveProjectionWriteV1;
		readonly deletes: readonly SessionSandboxReserveProjectionWriteV1[];
	} | null;
	readonly consumption: {
		readonly attemptId: string;
		readonly podUid: string;
		readonly projectionUid: string;
		readonly hostKeyId: string;
		readonly runnerEpoch: string;
	} | null;
}
export function sessionSandboxReserveExecutorStartupRefV1(sandboxId: string) {
	return `sandbox-${sandboxId}-executor-1`;
}
/**
 * Host instance evidence after the Worker verified its signature (HLD
 * §10.3.2). The Store re-checks scope, binding and lifetime when it commits.
 */
export interface SessionSandboxInstanceEvidenceV1 {
	readonly scope:
		| {
				readonly phase: "reserve";
				readonly reserveRef: string;
				readonly reserveDeliveryFence: number;
		  }
		| {
				readonly phase: "claimed";
				readonly claimRef: string;
				readonly allocationRef: string;
		  };
	readonly podUid: string;
	readonly hostKeyId: string;
	readonly runnerEpoch: string;
	readonly generation: number;
	readonly resourceFence: number;
	readonly issuedAtMs: number;
	readonly observedAtMs: number;
	readonly expiresAtMs: number;
}
/** A read authorization lasts at most 30 seconds and bounds the evidence. */
export const sessionSandboxInstanceEvidenceMaxMsV1 = 30_000;
export function sessionSandboxReserveRefV1(sandboxId: string) {
	return `reserve:${sandboxId}`;
}
export function sessionSandboxReserveClaimRefV1(input: {
	readonly sandboxId: string;
	readonly sessionId: string;
}) {
	return `claim:${input.sandboxId}:${input.sessionId}`;
}
export function sessionSandboxAllocationRefV1(input: {
	readonly sandboxId: string;
	readonly sessionId: string;
	readonly generation: number;
	readonly resourceFence: number;
}) {
	return `allocation:${input.sandboxId}:${input.sessionId}:${input.generation}:${input.resourceFence}`;
}
/** Shape and window only; scope, binding and the database clock are checked by the Store. */
export function sessionSandboxInstanceEvidenceShapeV1(
	evidence: unknown,
): evidence is SessionSandboxInstanceEvidenceV1 {
	if (!evidence || typeof evidence !== "object") return false;
	const value = evidence as SessionSandboxInstanceEvidenceV1;
	const scope = value.scope;
	const text = (entry: unknown) =>
		typeof entry === "string" && entry.length > 0 && entry.length <= 512;
	const positive = (entry: unknown) =>
		typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0;
	return (
		!!scope &&
		(scope.phase === "reserve"
			? text(scope.reserveRef) && positive(scope.reserveDeliveryFence)
			: scope.phase === "claimed" &&
				text(scope.claimRef) &&
				text(scope.allocationRef)) &&
		[value.podUid, value.hostKeyId, value.runnerEpoch].every(text) &&
		[
			value.generation,
			value.resourceFence,
			value.issuedAtMs,
			value.observedAtMs,
			value.expiresAtMs,
		].every(positive) &&
		value.issuedAtMs <= value.observedAtMs &&
		value.observedAtMs < value.expiresAtMs &&
		value.expiresAtMs - value.issuedAtMs <=
			sessionSandboxInstanceEvidenceMaxMsV1
	);
}
/** Every projection write has its original terminal response. */
export function sessionSandboxReserveExecutorSettledV1(
	startup: SessionSandboxReserveExecutorStartupV1 | null | undefined,
): boolean {
	const projection = startup?.projection;
	return (
		!projection ||
		[projection.create, ...projection.deletes].every(
			(write) => write.writeCompletion === "response",
		)
	);
}
function projectionRemoved(
	projection: NonNullable<SessionSandboxReserveExecutorStartupV1["projection"]>,
): boolean {
	const last = projection.deletes.at(-1);
	return (
		!!last &&
		last.status === "confirmed" &&
		last.writeCompletion === "response" &&
		last.absent &&
		!!projection.create.resource?.uid &&
		last.resource?.uid === projection.create.resource.uid
	);
}
/** Ready needs both-role consumption and confirmed removal of the original projection. */
function executorReady(
	startup: SessionSandboxReserveExecutorStartupV1,
	operations: readonly SessionSandboxReserveOperationV1[],
): boolean {
	const { projection, consumption } = startup;
	if (!projection || !consumption) return false;
	const { create } = projection;
	const pod = operations.find(
		(o) => o.kind === "Pod" && o.operation === "create",
	);
	return (
		sessionSandboxReserveExecutorSettledV1(startup) &&
		create.status === "confirmed" &&
		!create.absent &&
		!!create.resource?.uid &&
		pod?.resource?.uid === projection.podUid &&
		consumption.attemptId === create.attemptId &&
		consumption.podUid === projection.podUid &&
		consumption.projectionUid === create.resource.uid &&
		consumption.hostKeyId === projection.hostKeyId &&
		projectionRemoved(projection)
	);
}
/** Release needs every projection write settled and an original projection confirmed absent. */
function executorReleasable(
	startup: SessionSandboxReserveExecutorStartupV1,
): boolean {
	const { projection } = startup;
	if (!projection) return true;
	if (!sessionSandboxReserveExecutorSettledV1(startup)) return false;
	return (
		projection.create.status === "rejected" || projectionRemoved(projection)
	);
}
export interface SessionSandboxReserveClaimV1
	extends SessionSandboxReserveV1,
		SessionSandboxReserveLeaseV1 {}
export function sessionSandboxReserveDigestV1(value: unknown): string {
	const canonical = (entry: unknown): unknown =>
		Array.isArray(entry)
			? entry.map(canonical)
			: entry && typeof entry === "object"
				? Object.fromEntries(
						Object.entries(entry)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([k, v]) => [k, canonical(v)]),
					)
				: entry;
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}
export function parseSessionSandboxReserveConfigurationV1(
	value: SessionSandboxReserveConfigurationV1,
): SessionSandboxReserveConfigurationV1 {
	const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
	const nonNegative = (n: number) => Number.isSafeInteger(n) && n >= 0;
	const budget = (v: SessionSandboxResourceBudgetV1, allowZero: boolean) =>
		!!v &&
		Object.keys(v).length === 3 &&
		[v.cpuMillis, v.memoryBytes, v.storageBytes].every(
			allowZero ? nonNegative : positive,
		);
	if (
		value?.schemaVersion !== 1 ||
		typeof value.enabled !== "boolean" ||
		!positive(value.revision) ||
		!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.namespace) ||
		!budget(value.totalBudget, !value.enabled) ||
		!Array.isArray(value.resourceCosts) ||
		!Array.isArray(value.profiles)
	)
		throw new TypeError("Session reserve deployment configuration is invalid");
	if (!value.enabled) {
		if (
			value.resourceCosts.length === 0 &&
			value.profiles.length === 0 &&
			[
				value.maximumReserves,
				value.maximumConcurrentCreates,
				value.ttlMs,
				value.cooldownMs,
				value.failureBackoffMs,
			].every(nonNegative)
		)
			return structuredClone(value);
		// A disabled policy may retain full immutable facts so existing charges remain auditable.
		parseSessionSandboxReserveConfigurationV1({
			...value,
			enabled: true,
			maximumReserves: Math.max(
				1,
				value.maximumReserves,
				...value.profiles.map((profile) => profile.maximum),
			),
			maximumConcurrentCreates: Math.max(1, value.maximumConcurrentCreates),
			ttlMs: Math.max(1, value.ttlMs),
			cooldownMs: Math.max(1, value.cooldownMs),
			failureBackoffMs: Math.max(1, value.failureBackoffMs),
		});
		return structuredClone(value);
	}
	const cost = (v: SessionSandboxResourceBudgetV1) => budget(v, false);
	if (
		!value.resourceCosts.length ||
		new Set(value.resourceCosts.map((c) => c.resourceConfigurationHash))
			.size !== value.resourceCosts.length ||
		value.resourceCosts.some(
			(c) =>
				!/^[a-f0-9]{64}$/.test(c.resourceConfigurationHash) ||
				!cost(c.resources),
		) ||
		![
			value.maximumReserves,
			value.maximumConcurrentCreates,
			value.ttlMs,
			value.cooldownMs,
			value.failureBackoffMs,
		].every(positive) ||
		new Set(value.profiles.map((p) => p.agentId)).size !==
			value.profiles.length ||
		value.profiles.some(
			(p) =>
				!p.agentId ||
				!p.templateId ||
				!/^sha256:[a-f0-9]{64}$/.test(p.imageDigest) ||
				!/^[a-f0-9]{64}$/.test(p.resourceConfigurationHash) ||
				!cost(p.resources) ||
				![
					p.storageConfigurationVersion,
					p.networkPolicyVersion,
					p.signingConfigurationVersion,
					p.transportConfigurationVersion,
					p.connectionConfigurationVersion,
				].every(
					(v) => typeof v === "string" && v.length > 0 && v.length <= 256,
				) ||
				!Number.isSafeInteger(p.minimum) ||
				p.minimum < 0 ||
				!positive(p.maximum) ||
				p.maximum < p.minimum ||
				p.maximum > value.maximumReserves ||
				!value.resourceCosts.some(
					(c) =>
						c.resourceConfigurationHash === p.resourceConfigurationHash &&
						sessionSandboxReserveDigestV1(c.resources) ===
							sessionSandboxReserveDigestV1(p.resources),
				),
		)
	)
		throw new TypeError("Session reserve deployment configuration is invalid");
	return structuredClone(value);
}
export function sessionSandboxBudgetFitsV1(
	limit: SessionSandboxResourceBudgetV1,
	used: SessionSandboxResourceBudgetV1,
	added: SessionSandboxResourceBudgetV1,
): boolean {
	return (["cpuMillis", "memoryBytes", "storageBytes"] as const).every(
		(k) =>
			Number.isSafeInteger(used[k] + added[k]) &&
			used[k] >= 0 &&
			added[k] >= 0 &&
			used[k] + added[k] <= limit[k],
	);
}
/**
 * Deployment budgets size the unclaimed reserve pool. Runtime usage is an
 * observable signal and is intentionally not an admission predicate for an
 * ordinary or already-owned Session.
 */
export function canReadySessionSandboxReserveV1(input: {
	status: SessionSandboxReserveStatusV1;
	operations: readonly SessionSandboxReserveOperationV1[];
	bootstrapReady: boolean;
	businessStateAbsent: boolean;
	executorStartup?: SessionSandboxReserveExecutorStartupV1 | null;
}): boolean {
	return (
		input.status === "preparing" &&
		input.bootstrapReady &&
		input.businessStateAbsent &&
		(!input.executorStartup ||
			executorReady(input.executorStartup, input.operations)) &&
		input.operations.length === 6 &&
		sessionSandboxReserveResourceKindsV1.every(
			(kind) =>
				input.operations.filter(
					(o) =>
						o.kind === kind &&
						o.operation === "create" &&
						o.status === "confirmed" &&
						o.writeCompletion === "response" &&
						o.resource?.kind === kind &&
						o.resource.uid &&
						o.resource.resourceVersion &&
						!o.absent,
				).length === 1,
		)
	);
}
export function canReleaseSessionSandboxReserveV1(input: {
	status: SessionSandboxReserveStatusV1;
	operations: readonly SessionSandboxReserveOperationV1[];
	executorStartup?: SessionSandboxReserveExecutorStartupV1 | null;
}): boolean {
	return (
		input.status === "retiring" &&
		(!input.executorStartup || executorReleasable(input.executorStartup)) &&
		input.operations.every(
			(operation) => operation.writeCompletion === "response",
		) &&
		sessionSandboxReserveResourceKindsV1.every((kind) => {
			const creates = input.operations.filter(
				(o) => o.kind === kind && o.operation === "create",
			);
			return (
				creates.length <= 1 &&
				creates.every(
					(o) =>
						(o.status === "rejected" && o.writeCompletion === "response") ||
						(o.status === "confirmed" &&
							o.writeCompletion === "response" &&
							input.operations.some(
								(d) =>
									d.kind === kind &&
									d.operation === "delete" &&
									d.status === "confirmed" &&
									d.writeCompletion === "response" &&
									d.absent &&
									d.resource?.uid === o.resource?.uid &&
									d.resource?.kind === o.resource?.kind &&
									d.resource?.name === o.resource?.name &&
									d.resource?.namespace === o.resource?.namespace,
							)),
				)
			);
		})
	);
}
