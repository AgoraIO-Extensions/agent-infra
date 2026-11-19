import { z } from "zod";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

const count = z.number().int().safe().nonnegative();
const timestamp = z.string().datetime({ offset: true });
const identifier = z.string().min(1).max(256);

export const OperationsScopeV2Schema = z.strictObject({
	clusterId: identifier,
	namespace: z
		.string()
		.min(1)
		.max(63)
		.regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
});
export const OperationsSourceV2Schema = z.strictObject({
	kind: z.enum([
		"platform",
		"kubernetes",
		"pod-metrics",
		"node-metrics",
		"image-cache",
		"prometheus",
		"logs",
		"traces",
	]),
	state: z.enum([
		"available",
		"not-configured",
		"unavailable",
		"missing",
		"stale",
	]),
	observedAt: timestamp.nullable(),
	windowSeconds: z.number().positive().finite().nullable(),
	reason: z
		.enum([
			"NOT_CONFIGURED",
			"ACCESS_DENIED",
			"QUERY_FAILED",
			"INVALID_DATA",
			"NO_SAMPLES",
			"STALE",
			"TRUNCATED",
			"NOT_SUPPORTED",
		])
		.nullable(),
});
export const OperationsRetentionV2Schema = z.strictObject({
	detailDays: count,
	aggregateDays: count,
	aggregateStepSeconds: count.positive(),
	logDays: count,
	traceDays: count,
});
export const OperationsResourceQueryV2Schema = z.strictObject({
	namespace: OperationsScopeV2Schema.shape.namespace.optional(),
	agentId: identifier.optional(),
	sessionId: identifier.optional(),
});

export const OperationsQuantitiesV2Schema = z.strictObject({
	cpuCores: z.number().finite().nonnegative().nullable(),
	memoryBytes: count.nullable(),
	storageBytes: count.nullable(),
	ephemeralStorageBytes: count.nullable(),
});
export const OperationsBudgetV2Schema = z.strictObject({
	namespace: OperationsScopeV2Schema.shape.namespace,
	scope: z.literal("unclaimed-reserves"),
	revision: count.nullable(),
	enabled: z.boolean().nullable(),
	updatedAt: timestamp.nullable(),
	limits: OperationsQuantitiesV2Schema.nullable(),
	reserveUsage: OperationsQuantitiesV2Schema,
	sessionUsage: OperationsQuantitiesV2Schema,
	sessionRequestCoverage: z
		.strictObject({ cpuCores: count, memoryBytes: count, storageBytes: count })
		.optional(),
	unknownUsage: OperationsQuantitiesV2Schema,
	counts: z.strictObject({
		unclaimedReserves: count,
		sessions: count,
		retainedStorage: count,
	}),
	unaccountedCount: count,
});

const image = z.string().max(512);
const safeReason = z
	.string()
	.max(96)
	.regex(/^[a-zA-Z0-9_.:-]*$/);
export const OperationsContainerV2Schema = z.strictObject({
	name: identifier,
	role: z.enum(["runtime", "executor", "init", "sidecar", "unknown"]),
	image,
	imageId: image.nullable(),
	ready: z.boolean(),
	restarts: count,
	state: z.enum(["running", "waiting", "terminated", "unknown"]),
	reason: safeReason.nullable(),
	usage: OperationsQuantitiesV2Schema,
	requests: OperationsQuantitiesV2Schema,
	limits: OperationsQuantitiesV2Schema,
});
export const OperationsResourceV2Schema = z.strictObject({
	kind: z.enum(["Pod", "PersistentVolumeClaim"]),
	uid: identifier,
	name: identifier,
	namespace: OperationsScopeV2Schema.shape.namespace,
	resourceVersion: identifier,
	ownerUid: identifier.nullable(),
	ownerGeneration: count.nullable(),
	agentId: identifier.nullable(),
	agentName: z.string().max(256).nullable(),
	sessionId: identifier.nullable(),
	sandboxId: identifier.nullable(),
	generation: count.nullable(),
	revision: count.nullable(),
	workloadRevision: count.nullable().default(null),
	resourceFence: count.nullable(),
	ownership: z.enum(["agent", "shared", "reserve", "unknown"]),
	role: z.enum([
		"sandbox",
		"workload",
		"api",
		"worker",
		"database",
		"web",
		"directory",
		"unknown",
	]),
	nodeName: identifier.nullable(),
	phase: safeReason,
	ready: z.boolean().nullable(),
	restarts: count,
	reason: safeReason.nullable(),
	observedAt: timestamp,
	identityObservedAt: timestamp.optional(),
	usage: OperationsQuantitiesV2Schema,
	requests: OperationsQuantitiesV2Schema,
	limits: OperationsQuantitiesV2Schema,
	containers: z.array(OperationsContainerV2Schema).max(64),
	images: z.array(image).max(64),
	retainedStorage: z.boolean(),
	placement: z.enum(["ecs", "eci", "unknown"]).optional(),
	ownershipReason: safeReason.nullable().optional(),
});
export const OperationsAgentV2Schema = z.strictObject({
	agentId: identifier,
	name: z.string().max(256),
	sessions: count,
	pods: count,
	volumes: count,
	usage: OperationsQuantitiesV2Schema,
	requests: OperationsQuantitiesV2Schema,
	limits: OperationsQuantitiesV2Schema,
});
export const OperationsNodeV2Schema = z.strictObject({
	uid: identifier,
	name: identifier,
	virtual: z.boolean(),
	ready: z.boolean().nullable(),
	pressures: z
		.array(
			z.enum([
				"MemoryPressure",
				"DiskPressure",
				"PIDPressure",
				"NetworkUnavailable",
			]),
		)
		.max(4),
	capacity: OperationsQuantitiesV2Schema,
	allocatable: OperationsQuantitiesV2Schema,
	usage: OperationsQuantitiesV2Schema,
	requests: OperationsQuantitiesV2Schema,
	observedAt: timestamp,
	identityObservedAt: timestamp.optional(),
});
export const OperationsQuotaV2Schema = z.strictObject({
	uid: identifier,
	name: identifier,
	namespace: OperationsScopeV2Schema.shape.namespace,
	values: z
		.array(
			z.strictObject({
				resource: z.enum([
					"requests.cpu",
					"limits.cpu",
					"requests.memory",
					"limits.memory",
					"requests.storage",
					"requests.ephemeral-storage",
					"limits.ephemeral-storage",
					"pods",
					"persistentvolumeclaims",
					"services",
					"secrets",
				]),
				unit: z.enum(["cores", "bytes", "count"]),
				used: z.number().finite().nonnegative().nullable(),
				hard: z.number().finite().nonnegative(),
			}),
		)
		.max(32),
	observedAt: timestamp,
	source: z
		.enum(["kubernetes-resourcequota", "not-configured", "unavailable"])
		.optional(),
});
export const OperationsImageCacheV2Schema = z.strictObject({
	uid: identifier,
	name: identifier,
	cacheId: identifier.nullable(),
	owner: identifier,
	phase: safeReason,
	images: z.array(image).max(64),
	expiresAt: timestamp.nullable(),
	deleting: z.boolean(),
	observedAt: timestamp,
	inventoryLimit: count.positive().nullable(),
});
export const OperationsCacheEvidenceV2Schema = z.strictObject({
	podUid: identifier,
	podName: identifier,
	images: z.array(image).max(64),
	cacheId: identifier.nullable(),
	coverage: z.enum(["covered", "partial", "missing", "unknown"]),
	hit: z.enum(["confirmed", "pull-observed", "unknown", "not-applicable"]),
	observedAt: timestamp,
});
export const OperationsEventV2Schema = z.strictObject({
	uid: identifier,
	source: z
		.enum(["kubernetes-event", "container-status"])
		.default("kubernetes-event"),
	objectUid: identifier,
	objectName: identifier,
	reason: safeReason,
	category: z.enum([
		"capacity",
		"scheduling",
		"image",
		"runtime",
		"dependency",
		"observation",
	]),
	severity: z.enum(["warning", "info"]),
	count,
	firstAt: timestamp.nullable(),
	lastAt: timestamp.nullable(),
});
export const OperationsAlertV2Schema = z.strictObject({
	id: identifier,
	objectUid: identifier.nullable(),
	objectName: identifier,
	code: z.enum([
		"MEMORY_PRESSURE",
		"NODE_PRESSURE",
		"CPU_PRESSURE",
		"QUOTA_PRESSURE",
		"RESERVE_PRESSURE",
		"CACHE_INVENTORY",
		"CACHE_EXPIRED",
		"POD_UNAVAILABLE",
		"QUEUE_BACKLOG",
		"DATABASE_PRESSURE",
		"ERROR_RATE",
		"SOURCE_UNAVAILABLE",
	]),
	severity: z.enum(["warning", "critical"]),
	state: z.enum(["firing", "resolved"]),
	firstAt: timestamp,
	lastAt: timestamp,
	resolvedAt: timestamp.nullable(),
	value: z.number().finite().nullable(),
	threshold: z.number().finite().nullable(),
});
export const OperationsLinkV2Schema = z.strictObject({
	kind: z.enum(["metrics", "logs", "traces"]),
	url: z
		.url()
		.max(2048)
		.refine((value) => {
			const url = new URL(value);
			return (
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				![...url.searchParams.keys()].some((key) =>
					/token|key|secret|authorization|password|credential|cookie|^session$|jwt/i.test(
						key,
					),
				)
			);
		}),
});

export const OperationsResourcesV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	scope: OperationsScopeV2Schema,
	generatedAt: timestamp,
	collectionStartedAt: timestamp.optional(),
	refreshSeconds: count.positive(),
	sources: z.array(OperationsSourceV2Schema).max(8),
	nodes: z.array(OperationsNodeV2Schema).max(200),
	resources: z.array(OperationsResourceV2Schema).max(2000),
	agents: z.array(OperationsAgentV2Schema).max(2000),
	quotas: z.array(OperationsQuotaV2Schema).max(100),
	quotaSource: z
		.enum(["kubernetes-resourcequota", "not-configured", "unavailable"])
		.optional(),
	budget: OperationsBudgetV2Schema.nullable(),
	imageCaches: z.array(OperationsImageCacheV2Schema).max(128),
	cacheEvidence: z.array(OperationsCacheEvidenceV2Schema).max(2000),
	events: z.array(OperationsEventV2Schema).max(1000),
	alerts: z.array(OperationsAlertV2Schema).max(1000),
	queue: z
		.strictObject({
			waiting: count,
			outboxPending: count,
			oldestWaitingAt: timestamp.nullable().default(null),
		})
		.nullable(),
	database: z
		.strictObject({
			scope: z.literal("current-role"),
			connections: count,
			active: count,
			idle: count,
			idleInTransaction: count,
			lockWaiting: count,
			databaseConnections: count,
			maxConnections: count,
			roleConnectionLimit: count.nullable(),
			observedAt: timestamp,
		})
		.nullable()
		.default(null),
	errorRates: z
		.array(
			z.strictObject({
				stage: z.enum(["http", "model", "runtime", "tool"]),
				ratio: z.number().min(0).max(1).nullable(),
				observedAt: timestamp.nullable(),
				windowSeconds: count.positive(),
			}),
		)
		.max(4)
		.optional(),
	retention: z.strictObject({
		target: OperationsRetentionV2Schema,
		effective: OperationsRetentionV2Schema.nullable(),
		configured: z
			.strictObject({
				detailDays: count.nullable(),
				aggregateDays: count.nullable(),
				aggregateStepSeconds: count.nullable(),
				logDays: count.nullable(),
				traceDays: count.nullable(),
			})
			.optional(),
	}),
	links: z.array(OperationsLinkV2Schema).max(3),
	selection: z
		.strictObject({
			agent: z.enum(["not-requested", "present", "not-found"]),
			session: z.enum(["not-requested", "present", "not-found"]),
		})
		.optional(),
	truncated: z.boolean(),
});

export type OperationsResourceQueryV2 = z.infer<
	typeof OperationsResourceQueryV2Schema
>;
export type OperationsResourcesV2 = z.infer<typeof OperationsResourcesV2Schema>;
export type OperationsSourceV2 = z.infer<typeof OperationsSourceV2Schema>;
export type OperationsQuantitiesV2 = z.infer<
	typeof OperationsQuantitiesV2Schema
>;
export type OperationsBudgetV2 = z.infer<typeof OperationsBudgetV2Schema>;
export type OperationsResourceV2 = z.infer<typeof OperationsResourceV2Schema>;

export const OperationsHistoryQueryV2Schema = z
	.strictObject({
		metric: z.enum([
			"cpu",
			"memory",
			"storage",
			"http-requests",
			"http-errors",
			"http-latency",
			"waiting",
			"outbox",
			"dependency-latency",
			"runtime-latency",
			"model-latency",
			"tool-latency",
			"model-errors",
			"tool-errors",
			"runtime-errors",
			"sse-connections",
			"sse-pending",
		]),
		start: timestamp,
		end: timestamp,
		agentId: identifier.optional(),
		sessionId: identifier.optional(),
		resourceUid: identifier.optional(),
		statistic: z.enum(["average", "maximum"]).default("average"),
	})
	.refine(
		(query) =>
			Date.parse(query.end) > Date.parse(query.start) &&
			Date.parse(query.end) - Date.parse(query.start) <= 30 * 86400_000,
		"History ranges must be positive and no longer than 30 days",
	);
export const OperationsHistoryV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	scope: OperationsScopeV2Schema,
	metric: OperationsHistoryQueryV2Schema.shape.metric,
	state: z.enum([
		"available",
		"missing",
		"unavailable",
		"not-configured",
		"not-supported",
		"outside-retention",
	]),
	start: timestamp,
	end: timestamp,
	coverage: z
		.strictObject({
			state: z.enum(["within-policy", "partial", "outside-policy"]),
			start: timestamp,
		})
		.optional(),
	stepSeconds: count.positive(),
	statistic: z.enum(["average", "maximum"]),
	series: z
		.array(
			z.strictObject({
				name: z.string().max(256),
				resourceUid: identifier.nullable(),
				points: z
					.array(
						z.strictObject({
							at: timestamp,
							value: z.number().finite().nullable(),
						}),
					)
					.max(10000),
			}),
		)
		.max(128),
	truncated: z.boolean(),
});
export type OperationsHistoryQueryV2 = z.infer<
	typeof OperationsHistoryQueryV2Schema
>;
export type OperationsHistoryV2 = z.infer<typeof OperationsHistoryV2Schema>;

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});
function parameterSchema(schema: z.ZodType) {
	const result = z.toJSONSchema(schema);
	delete result.$schema;
	return result;
}

export const operationsResourceOpenApiPathsV2 = {
	"/api/v2/ops/history": {
		get: {
			operationId: "getOperationsHistoryV2",
			summary: "Query bounded administrator resource history",
			security: [{ PlatformSession: [] }],
			parameters: Object.entries(OperationsHistoryQueryV2Schema.shape).map(
				([name, schema]) => ({
					name,
					in: "query",
					required: ["metric", "start", "end"].includes(name),
					schema: parameterSchema(schema),
				}),
			),
			responses: {
				"200": response(
					"Resource history or an explicit source gap",
					OperationsHistoryV2Schema,
				),
				"400": response("Invalid bounded query", PilotProtocolErrorV1Schema),
				"401": response("Authentication required", PilotProtocolErrorV1Schema),
				"403": response("Not authorized", PilotProtocolErrorV1Schema),
				"404": { description: "This deployment does not provide the query" },
				"503": response("Query unavailable", PilotProtocolErrorV1Schema),
			},
		},
	},
	"/api/v2/ops/resources": {
		get: {
			operationId: "getOperationsResourcesV2",
			summary: "Read administrator resource observations",
			security: [{ PlatformSession: [] }],
			parameters: Object.entries(OperationsResourceQueryV2Schema.shape).map(
				([name, schema]) => ({
					name,
					in: "query",
					required: false,
					schema: parameterSchema(schema),
				}),
			),
			responses: {
				"200": response(
					"Resource observations and individual source health",
					OperationsResourcesV2Schema,
				),
				"400": response("Invalid query", PilotProtocolErrorV1Schema),
				"401": response("Authentication required", PilotProtocolErrorV1Schema),
				"403": response("Not authorized", PilotProtocolErrorV1Schema),
				"404": { description: "This deployment does not provide the query" },
				"503": response("Query unavailable", PilotProtocolErrorV1Schema),
			},
		},
	},
} as const;
export const operationsResourceSchemasV2 = {
	OperationsResourcesV2: OperationsResourcesV2Schema,
	OperationsHistoryV2: OperationsHistoryV2Schema,
};
