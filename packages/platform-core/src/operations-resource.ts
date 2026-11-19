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
		const binding = bindings.find((candidate) => {
			const exactIdentity = candidate.identities.some(
				(identity) =>
					identity.kind === resource.kind &&
					identity.name === resource.name &&
					identity.uid === resource.uid,
			);
			return (
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
				(candidate.controllerUid !== undefined && candidate.retainedStorage
					? resource.kind === "PersistentVolumeClaim" &&
						resource.phase === "Bound" &&
						resource.identityObservedAt !== undefined &&
						exactIdentity &&
						candidate.controllerUid === resource.ownerUid
					: exactIdentity ||
						(candidate.controllerUid !== undefined &&
							candidate.controllerUid === resource.ownerUid))
			);
		});
		if (binding)
			return {
				...resource,
				revision: binding.revision,
				ownership: binding.ownership,
				ownershipReason: null,
				agentName: binding.agentName,
				retainedStorage:
					resource.kind === "PersistentVolumeClaim" && binding.retainedStorage,
			};
		const shared = resource.ownership === "shared";
		return {
			...resource,
			ownership: shared ? "shared" : "unknown",
			ownershipReason: shared
				? null
				: resource.kind === "PersistentVolumeClaim"
					? "PVC_BINDING_UNAVAILABLE"
					: "BINDING_UNAVAILABLE",
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

export interface OperationsSessionAllocationV2 {
	readonly sandboxId: string;
	readonly resourceName: string;
	readonly stopped: boolean;
	readonly noRetainedPvc: boolean;
	readonly configurationRevision: number | null;
}

export interface OperationsInventoryV2 {
	readonly podsObservedAt: string | null;
	readonly claimsObservedAt: string | null;
}

const sessionDimensions = ["cpuCores", "memoryBytes", "storageBytes"] as const;

function projectSessionRequests(
	input: {
		allocations: readonly OperationsSessionAllocationV2[];
		observed: readonly OperationsResourceV2[];
		bound: readonly OperationsResourceV2[];
		unscopedSessions: number;
		podsComplete: boolean;
		claimsComplete: boolean;
	},
	result: OperationsBudgetV2,
): void {
	const coverage = { cpuCores: 0, memoryBytes: 0, storageBytes: 0 };
	const totals = { ...coverage, ephemeralStorageBytes: null };
	const bySandbox = new Map<string, number[]>();
	const byName = new Map<string, number[]>();
	const byUid = new Map<string, number[]>();
	const index = (map: Map<string, number[]>, key: string, i: number) => {
		const entries = map.get(key);
		if (entries) entries.push(i);
		else map.set(key, [i]);
	};
	for (const [i, resource] of input.observed.entries()) {
		if (resource.namespace !== result.namespace) continue;
		index(byName, resource.name, i);
		index(byUid, resource.uid, i);
		if (resource.sandboxId) index(bySandbox, resource.sandboxId, i);
	}
	const freshSample = (
		indexes: readonly number[],
		allocation: OperationsSessionAllocationV2,
	) => {
		const first =
			indexes[0] === undefined ? undefined : input.bound[indexes[0]];
		if (!first?.identityObservedAt || allocation.configurationRevision === null)
			return undefined;
		const aliases = byUid.get(first.uid) ?? [];
		return indexes.length === aliases.length &&
			indexes.every((i) => input.observed[i]?.uid === first.uid) &&
			aliases.every((i) => {
				const sample = input.bound[i];
				return (
					sample?.uid === first.uid &&
					sample.kind === first.kind &&
					sample.name === first.name &&
					sample.namespace === result.namespace &&
					sample.revision === allocation.configurationRevision &&
					sample.ownership === "agent" &&
					sample.role === "sandbox" &&
					sample.sandboxId === allocation.sandboxId &&
					sample.resourceVersion === first.resourceVersion &&
					sample.identityObservedAt === first.identityObservedAt &&
					sample.phase === first.phase &&
					sessionDimensions.every(
						(dimension) =>
							sample.requests[dimension] === first.requests[dimension],
					)
				);
			})
			? first
			: undefined;
	};
	const counted = new Set<string>();
	for (const allocation of input.allocations) {
		const candidates = [
			...new Set([
				...(bySandbox.get(allocation.sandboxId) ?? []),
				...(byName.get(allocation.resourceName) ?? []),
			]),
		];
		const pods = candidates.filter((i) => input.observed[i]?.kind === "Pod");
		const claims = candidates.filter(
			(i) => input.observed[i]?.kind === "PersistentVolumeClaim",
		);
		const pod = input.podsComplete ? freshSample(pods, allocation) : undefined;
		const claim = input.claimsComplete
			? freshSample(claims, allocation)
			: undefined;
		const stopped =
			allocation.stopped && allocation.configurationRevision !== null;
		const podAbsent = stopped && input.podsComplete && pods.length === 0;
		const take = (resource: OperationsResourceV2 | undefined) => {
			if (!resource || counted.has(resource.uid)) return undefined;
			counted.add(resource.uid);
			return resource.requests;
		};
		const compute = take(pod);
		const storage = take(claim?.phase === "Bound" ? claim : undefined);
		const values = {
			cpuCores: podAbsent ? 0 : (compute?.cpuCores ?? null),
			memoryBytes: podAbsent ? 0 : (compute?.memoryBytes ?? null),
			storageBytes:
				stopped &&
				input.claimsComplete &&
				allocation.noRetainedPvc &&
				claims.length === 0
					? 0
					: (storage?.storageBytes ?? null),
		};
		if (stopped && storage?.storageBytes != null)
			result.counts.retainedStorage++;
		if (sessionDimensions.some((dimension) => values[dimension] === null))
			result.unaccountedCount++;
		for (const dimension of sessionDimensions) {
			const value = values[dimension];
			if (value === null) continue;
			totals[dimension] += value;
			coverage[dimension]++;
		}
	}
	result.counts.sessions = input.allocations.length;
	result.sessionRequestCoverage = {
		...coverage,
		unscopedSessions: input.unscopedSessions,
	};
	result.unaccountedCount += input.unscopedSessions;
	result.sessionUsage = totals;
	for (const dimension of sessionDimensions) {
		if (
			input.unscopedSessions > 0 ||
			coverage[dimension] !== result.counts.sessions ||
			(dimension !== "cpuCores" && !Number.isSafeInteger(totals[dimension]))
		)
			result.sessionUsage[dimension] = null;
	}
}

export function projectOperationsBudgetV2(input: {
	namespace: string;
	revision: number | null;
	enabled: boolean | null;
	updatedAt: string | null;
	limits: SessionSandboxResourceBudgetV1 | null;
	charges: readonly OperationsChargeV2[];
	unaccountedReserves: number;
	unaccountedSessions?: number;
	sessionRequests?: Parameters<typeof projectSessionRequests>[0];
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
		unaccountedCount:
			input.unaccountedReserves + (input.unaccountedSessions ?? 0),
	};
	for (const charge of input.charges) {
		if (input.sessionRequests && charge.hasAllocation) continue;
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
		if (!input.sessionRequests && charge.computeReleased)
			result.counts.retainedStorage += 1;
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
	if (input.sessionRequests)
		projectSessionRequests(input.sessionRequests, result);
	else if (input.unaccountedSessions) {
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
		quotaSource: "unavailable",
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
