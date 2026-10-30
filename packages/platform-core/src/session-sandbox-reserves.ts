import { createHash } from "node:crypto";
import type {
	SessionSandboxResourceIdentityV1,
	SessionSandboxVerifiedPolicyV1,
} from "./session-sandbox-reconciliation.js";

export interface SessionSandboxResourceBudgetV1 {
	readonly cpuMillis: number;
	readonly memoryBytes: number;
	readonly storageBytes: number;
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
		!value ||
		value.schemaVersion !== 1 ||
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
export function canReadySessionSandboxReserveV1(input: {
	status: SessionSandboxReserveStatusV1;
	operations: readonly SessionSandboxReserveOperationV1[];
	bootstrapReady: boolean;
	businessStateAbsent: boolean;
}): boolean {
	return (
		input.status === "preparing" &&
		input.bootstrapReady &&
		input.businessStateAbsent &&
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
}): boolean {
	return (
		input.status === "retiring" &&
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
									d.absent &&
									d.resource?.uid === o.resource?.uid &&
									d.resource?.resourceVersion === o.resource?.resourceVersion,
							)),
				)
			);
		})
	);
}
