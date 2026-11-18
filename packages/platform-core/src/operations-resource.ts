import type {
	OperationsBudgetObservationV2 as OperationsBudgetV2,
	OperationsQuantitiesV2,
	OperationsResourceSnapshotV2 as OperationsResourcesV2,
	OperationsResourceObservationV2 as OperationsResourceV2,
} from "./operations-types.js";
import type { SessionSandboxResourceBudgetV1 } from "./session-sandbox-reserves.js";

export interface OperationsBindingV2 {
	readonly agentId: string;
	readonly agentName: string;
	readonly sessionId: string | null;
	readonly sandboxId: string | null;
	readonly namespace: string;
	readonly generation: number | null;
	readonly revision: number | null;
	readonly resourceFence: number | null;
	readonly ownership: "agent" | "reserve";
	readonly retainedStorage: boolean;
	readonly identities: readonly { kind: string; name: string; uid: string }[];
	readonly controllerUid?: string;
	readonly workloadRevision?: number;
	readonly manifestHash?: string;
	readonly members?: readonly { kind: string; name: string }[];
}

export function bindOperationsResourcesV2(
	resources: readonly OperationsResourceV2[],
	bindings: readonly OperationsBindingV2[],
): OperationsResourceV2[] {
	return resources.map((resource) => {
		const binding = bindings.find(
			(candidate) =>
				candidate.agentId === resource.agentId &&
				candidate.sessionId === resource.sessionId &&
				candidate.sandboxId === resource.sandboxId &&
				candidate.namespace === resource.namespace &&
				(candidate.controllerUid !== undefined
					? candidate.generation === resource.ownerGeneration &&
						candidate.resourceFence === resource.resourceFence &&
						candidate.workloadRevision === resource.workloadRevision
					: resource.kind === "PersistentVolumeClaim"
						? resource.generation !== null &&
							candidate.generation !== null &&
							resource.generation <= candidate.generation &&
							resource.resourceFence !== null &&
							candidate.resourceFence !== null &&
							resource.resourceFence <= candidate.resourceFence
						: candidate.generation === resource.generation &&
							candidate.resourceFence === resource.resourceFence) &&
				(candidate.revision === resource.revision ||
					(resource.sandboxId !== null && resource.revision === null)) &&
				(candidate.identities.some(
					(identity) =>
						identity.kind === resource.kind &&
						identity.name === resource.name &&
						identity.uid === resource.uid,
				) ||
					(candidate.controllerUid !== undefined &&
						candidate.controllerUid === resource.ownerUid)),
		);
		if (binding)
			return {
				...resource,
				revision: binding.revision,
				ownership: binding.ownership,
				agentName: binding.agentName,
				retainedStorage:
					resource.kind === "PersistentVolumeClaim" && binding.retainedStorage,
			};
		return {
			...resource,
			ownership: resource.ownership === "shared" ? "shared" : "unknown",
			agentId: null,
			agentName: null,
			sessionId: null,
			sandboxId: null,
			retainedStorage: false,
		};
	});
}

export function aggregateOperationsAgentsV2(
	resources: readonly OperationsResourceV2[],
): OperationsResourcesV2["agents"] {
	const grouped = new Map<string, OperationsResourceV2[]>();
	for (const resource of resources) {
		if (resource.ownership !== "agent" || !resource.agentId) continue;
		grouped.set(resource.agentId, [
			...(grouped.get(resource.agentId) ?? []),
			resource,
		]);
	}
	return [...grouped]
		.map(([agentId, entries]) => {
			const sum = (
				kind: "usage" | "requests" | "limits",
			): OperationsQuantitiesV2 => {
				const result: OperationsQuantitiesV2 = {
					cpuCores: null,
					memoryBytes: null,
					storageBytes: null,
					ephemeralStorageBytes: null,
				};
				for (const key of Object.keys(
					result,
				) as (keyof OperationsQuantitiesV2)[]) {
					const relevant = entries.filter((entry) =>
						key === "storageBytes"
							? entry.kind === "PersistentVolumeClaim"
							: entry.kind === "Pod",
					);
					if (
						relevant.length &&
						relevant.every((entry) => entry[kind][key] !== null)
					)
						result[key] = relevant.reduce(
							(total, entry) => total + (entry[kind][key] ?? 0),
							0,
						);
				}
				return result;
			};
			return {
				agentId,
				name: entries[0]?.agentName ?? agentId,
				sessions: new Set(
					entries.flatMap((entry) =>
						entry.sessionId ? [entry.sessionId] : [],
					),
				).size,
				pods: entries.filter((entry) => entry.kind === "Pod").length,
				volumes: entries.filter(
					(entry) => entry.kind === "PersistentVolumeClaim",
				).length,
				usage: sum("usage"),
				requests: sum("requests"),
				limits: sum("limits"),
			};
		})
		.sort(
			(left, right) =>
				(right.usage.memoryBytes ?? -1) - (left.usage.memoryBytes ?? -1),
		);
}

export interface OperationsChargeV2 {
	readonly resources: SessionSandboxResourceBudgetV1 | null;
	readonly computeReleased: boolean;
	readonly hasAllocation: boolean;
	readonly hasReserve: boolean;
	readonly claimed: boolean;
	readonly hasConversation: boolean;
}

export function projectOperationsBudgetV2(input: {
	namespace: string;
	revision: number | null;
	enabled: boolean | null;
	updatedAt: string | null;
	limits: SessionSandboxResourceBudgetV1 | null;
	charges: readonly OperationsChargeV2[];
	unaccountedCount: number;
	unaccountedReserves?: number;
	unaccountedSessions?: number;
}): OperationsBudgetV2 {
	const zero = (): OperationsQuantitiesV2 => ({
		cpuCores: 0,
		memoryBytes: 0,
		storageBytes: 0,
		ephemeralStorageBytes: null,
	});
	const result: OperationsBudgetV2 = {
		namespace: input.namespace,
		scope: "unclaimed-reserves",
		revision: input.revision,
		enabled: input.enabled,
		updatedAt: input.updatedAt,
		limits: input.limits
			? {
					cpuCores: input.limits.cpuMillis / 1000,
					memoryBytes: input.limits.memoryBytes,
					storageBytes: input.limits.storageBytes,
					ephemeralStorageBytes: null,
				}
			: null,
		reserveUsage: zero(),
		sessionUsage: zero(),
		unknownUsage: zero(),
		counts: { unclaimedReserves: 0, sessions: 0, retainedStorage: 0 },
		unaccountedCount: input.unaccountedCount,
	};
	for (const charge of input.charges) {
		const isReserve =
			charge.hasReserve &&
			!charge.claimed &&
			!charge.hasConversation &&
			!charge.hasAllocation;
		const bucket = charge.hasAllocation
			? result.sessionUsage
			: isReserve
				? result.reserveUsage
				: result.unknownUsage;
		if (charge.hasAllocation) result.counts.sessions += 1;
		if (isReserve) result.counts.unclaimedReserves += 1;
		if (charge.computeReleased) result.counts.retainedStorage += 1;
		if (!charge.resources) {
			bucket.cpuCores = null;
			bucket.memoryBytes = null;
			bucket.storageBytes = null;
			result.unaccountedCount += 1;
			continue;
		}
		if (bucket.cpuCores !== null)
			bucket.cpuCores += charge.computeReleased
				? 0
				: charge.resources.cpuMillis / 1000;
		if (bucket.memoryBytes !== null)
			bucket.memoryBytes += charge.computeReleased
				? 0
				: charge.resources.memoryBytes;
		if (bucket.storageBytes !== null)
			bucket.storageBytes += charge.resources.storageBytes;
	}
	if (input.unaccountedReserves) {
		result.counts.unclaimedReserves += input.unaccountedReserves;
		result.reserveUsage = {
			cpuCores: null,
			memoryBytes: null,
			storageBytes: null,
			ephemeralStorageBytes: null,
		};
	}
	if (input.unaccountedSessions) {
		result.counts.sessions += input.unaccountedSessions;
		result.sessionUsage = {
			cpuCores: null,
			memoryBytes: null,
			storageBytes: null,
			ephemeralStorageBytes: null,
		};
	}
	return result;
}

export function emptyOperationsResourcesV2(
	scope: OperationsResourcesV2["scope"],
	now: string,
): OperationsResourcesV2 {
	return {
		schemaVersion: 2,
		scope,
		generatedAt: now,
		collectionStartedAt: now,
		refreshSeconds: 30,
		sources: [
			"platform",
			"kubernetes",
			"pod-metrics",
			"node-metrics",
			"image-cache",
			"prometheus",
			"logs",
			"traces",
		].map((kind) => ({
			kind: kind as OperationsResourcesV2["sources"][number]["kind"],
			state: "not-configured",
			observedAt: null,
			windowSeconds: null,
			reason: "NOT_CONFIGURED",
		})),
		nodes: [],
		resources: [],
		agents: [],
		quotas: [],
		quotaSource: "not-configured",
		budget: null,
		imageCaches: [],
		cacheEvidence: [],
		events: [],
		alerts: [],
		queue: null,
		database: null,
		retention: {
			target: {
				detailDays: 7,
				aggregateDays: 30,
				aggregateStepSeconds: 300,
				logDays: 7,
				traceDays: 7,
			},
			effective: null,
		},
		links: [],
		truncated: false,
	};
}
