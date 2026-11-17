/** Domain observations. Protocol validation and serialization remain in the adapters. */
export interface OperationsQuantitiesV2 {
	cpuCores: number | null;
	memoryBytes: number | null;
	storageBytes: number | null;
	ephemeralStorageBytes: number | null;
}
export interface OperationsBudgetObservationV2 {
	namespace: string;
	scope: "unclaimed-reserves";
	revision: number | null;
	enabled: boolean | null;
	updatedAt: string | null;
	limits: OperationsQuantitiesV2 | null;
	reserveUsage: OperationsQuantitiesV2;
	sessionUsage: OperationsQuantitiesV2;
	unknownUsage: OperationsQuantitiesV2;
	counts: {
		unclaimedReserves: number;
		sessions: number;
		retainedStorage: number;
	};
	unaccountedCount: number;
}
export interface OperationsResourceObservationV2 {
	kind: "Pod" | "PersistentVolumeClaim";
	uid: string;
	name: string;
	namespace: string;
	resourceVersion: string;
	ownerUid: string | null;
	ownerGeneration: number | null;
	agentId: string | null;
	agentName: string | null;
	sessionId: string | null;
	sandboxId: string | null;
	generation: number | null;
	revision: number | null;
	workloadRevision: number | null;
	resourceFence: number | null;
	ownership: "agent" | "shared" | "reserve" | "unknown";
	role:
		| "sandbox"
		| "workload"
		| "api"
		| "worker"
		| "database"
		| "web"
		| "directory"
		| "unknown";
	nodeName: string | null;
	phase: string;
	ready: boolean | null;
	restarts: number;
	reason: string | null;
	observedAt: string;
	identityObservedAt?: string;
	usage: OperationsQuantitiesV2;
	requests: OperationsQuantitiesV2;
	limits: OperationsQuantitiesV2;
	containers: {
		name: string;
		role: "runtime" | "executor" | "init" | "sidecar" | "unknown";
		image: string;
		imageId: string | null;
		ready: boolean;
		restarts: number;
		state: "running" | "waiting" | "terminated" | "unknown";
		reason: string | null;
		usage: OperationsQuantitiesV2;
		requests: OperationsQuantitiesV2;
		limits: OperationsQuantitiesV2;
	}[];
	images: string[];
	retainedStorage: boolean;
}
export interface OperationsResourceSnapshotV2 {
	schemaVersion: 2;
	scope: { clusterId: string; namespace: string };
	generatedAt: string;
	collectionStartedAt?: string;
	refreshSeconds: number;
	sources: {
		kind:
			| "platform"
			| "kubernetes"
			| "pod-metrics"
			| "node-metrics"
			| "image-cache"
			| "prometheus"
			| "logs"
			| "traces";
		state: "available" | "not-configured" | "unavailable" | "missing" | "stale";
		observedAt: string | null;
		windowSeconds: number | null;
		reason:
			| "NOT_CONFIGURED"
			| "ACCESS_DENIED"
			| "QUERY_FAILED"
			| "INVALID_DATA"
			| "NO_SAMPLES"
			| "STALE"
			| "TRUNCATED"
			| "NOT_SUPPORTED"
			| null;
	}[];
	nodes: {
		uid: string;
		name: string;
		virtual: boolean;
		ready: boolean | null;
		pressures: (
			| "MemoryPressure"
			| "DiskPressure"
			| "PIDPressure"
			| "NetworkUnavailable"
		)[];
		capacity: OperationsQuantitiesV2;
		allocatable: OperationsQuantitiesV2;
		usage: OperationsQuantitiesV2;
		requests: OperationsQuantitiesV2;
		observedAt: string;
		identityObservedAt?: string;
	}[];
	resources: OperationsResourceObservationV2[];
	agents: {
		agentId: string;
		name: string;
		sessions: number;
		pods: number;
		volumes: number;
		usage: OperationsQuantitiesV2;
		requests: OperationsQuantitiesV2;
		limits: OperationsQuantitiesV2;
	}[];
	quotas: {
		uid: string;
		name: string;
		namespace: string;
		observedAt: string;
		values: {
			resource:
				| "requests.cpu"
				| "limits.cpu"
				| "requests.memory"
				| "limits.memory"
				| "requests.storage"
				| "requests.ephemeral-storage"
				| "limits.ephemeral-storage"
				| "pods"
				| "persistentvolumeclaims"
				| "services"
				| "secrets";
			unit: "cores" | "bytes" | "count";
			used: number | null;
			hard: number;
		}[];
	}[];
	budget: OperationsBudgetObservationV2 | null;
	imageCaches: {
		uid: string;
		name: string;
		cacheId: string | null;
		owner: string;
		phase: string;
		images: string[];
		expiresAt: string | null;
		deleting: boolean;
		observedAt: string;
		inventoryLimit: number | null;
	}[];
	cacheEvidence: {
		podUid: string;
		podName: string;
		images: string[];
		cacheId: string | null;
		coverage: "covered" | "partial" | "missing" | "unknown";
		hit: "confirmed" | "pull-observed" | "unknown" | "not-applicable";
		observedAt: string;
	}[];
	events: {
		uid: string;
		source: "kubernetes-event" | "container-status";
		objectUid: string;
		objectName: string;
		reason: string;
		category:
			| "capacity"
			| "scheduling"
			| "image"
			| "runtime"
			| "dependency"
			| "observation";
		severity: "warning" | "info";
		count: number;
		firstAt: string | null;
		lastAt: string | null;
	}[];
	alerts: {
		id: string;
		objectUid: string | null;
		objectName: string;
		code:
			| "MEMORY_PRESSURE"
			| "NODE_PRESSURE"
			| "CPU_PRESSURE"
			| "QUOTA_PRESSURE"
			| "RESERVE_PRESSURE"
			| "CACHE_INVENTORY"
			| "CACHE_EXPIRED"
			| "POD_UNAVAILABLE"
			| "QUEUE_BACKLOG"
			| "DATABASE_PRESSURE"
			| "ERROR_RATE"
			| "SOURCE_UNAVAILABLE";
		severity: "warning" | "critical";
		state: "firing" | "resolved";
		firstAt: string;
		lastAt: string;
		resolvedAt: string | null;
		value: number | null;
		threshold: number | null;
	}[];
	queue: {
		waiting: number;
		outboxPending: number;
		oldestWaitingAt: string | null;
	} | null;
	selection?: {
		agent: "not-requested" | "present" | "not-found";
		session: "not-requested" | "present" | "not-found";
	};
	database: {
		scope: "current-role";
		connections: number;
		active: number;
		idle: number;
		idleInTransaction: number;
		lockWaiting: number;
		databaseConnections: number;
		maxConnections: number;
		roleConnectionLimit: number | null;
		observedAt: string;
	} | null;
	errorRates?: {
		stage: "http" | "model" | "runtime" | "tool";
		ratio: number | null;
		observedAt: string | null;
		windowSeconds: number;
	}[];
	retention: {
		target: OperationsRetentionPolicyV2;
		effective: OperationsRetentionPolicyV2 | null;
		configured?: { [K in keyof OperationsRetentionPolicyV2]: number | null };
	};
	links: { kind: "metrics" | "logs" | "traces"; url: string }[];
	truncated: boolean;
}
export interface OperationsRetentionPolicyV2 {
	detailDays: number;
	aggregateDays: number;
	aggregateStepSeconds: number;
	logDays: number;
	traceDays: number;
}
export class OperationsScopeErrorV2 extends Error {
	constructor() {
		super("Operations scope unavailable");
	}
}
