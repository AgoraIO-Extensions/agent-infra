import { z } from "zod";

import {
	WorkloadBoundaryErrorV1Schema,
	WorkloadOpaqueIdV1Schema,
	WorkloadRevisionV1Schema,
	WorkloadSchemaVersionV1Schema,
	WorkloadTimestampV1Schema,
} from "./common.ts";
import { ImmutableOciDigestV1Schema } from "./registry.ts";
import {
	PlatformAdapterRuntimeManifestV1Schema,
	SelfManagedRuntimeManifestV1Schema,
} from "./runtime-manifest.ts";
import { KubernetesSecretReferenceV1Schema } from "./secret.ts";

export const KubernetesRuntimeCapabilitiesV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	statefulSetApiVersion: z.literal("apps/v1"),
	coreApiVersion: z.literal("v1"),
	networkingApiVersion: z.literal("networking.k8s.io/v1"),
	routeKind: z.enum(["ingress", "deployment-adapter"]),
	namespaceScoped: z.literal(true),
});

export const WorkloadServiceV1Schema = z.strictObject({
	name: z.string().min(1),
	port: z.number().int().min(1).max(65_535),
});

export const WorkloadHealthV1Schema = z.strictObject({
	path: z.string().min(1),
	timeoutSeconds: z.number().int().positive(),
	failureThreshold: z.number().int().positive(),
});

export const WorkloadPersistentVolumeV1Schema = z.strictObject({
	name: z.string().min(1),
	mountPath: z.string().startsWith("/"),
	storageProfileRef: WorkloadOpaqueIdV1Schema,
	accessMode: z.literal("ReadWriteOnce"),
	retention: z.literal("retain"),
});

export const WorkloadServiceAccountV1Schema = z.strictObject({
	name: z.string().min(1),
	kubernetesApiAccess: z.literal(false),
});

export const WorkloadNetworkPolicyV1Schema = z.strictObject({
	deploymentPolicyRef: WorkloadOpaqueIdV1Schema,
	ingressMode: z.enum([
		"runtime-host-client-only",
		"platform-auth-route",
		"self-managed-route",
	]),
	kubernetesApiAccess: z.literal(false),
	platformDatabaseAccess: z.literal(false),
	connectionDatabaseAccess: z.literal(false),
	decryptionKeyringAccess: z.literal(false),
});

const internalWorkloadRouteV1Schema = z.strictObject({
	name: z.string().min(1),
	exposure: z.literal("internal-only"),
	tlsRequired: z.literal(true),
});

const platformAuthWorkloadRouteV1Schema = z.strictObject({
	name: z.string().min(1),
	exposure: z.literal("platform-auth"),
	tlsRequired: z.literal(true),
});

const ownerAuthWorkloadRouteV1Schema = z.strictObject({
	name: z.string().min(1),
	exposure: z.literal("self-managed"),
	tlsRequired: z.literal(true),
});

export const WorkloadRouteV1Schema = z.union([
	internalWorkloadRouteV1Schema,
	platformAuthWorkloadRouteV1Schema,
	ownerAuthWorkloadRouteV1Schema,
]);

const desiredWorkloadBaseV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	requestId: WorkloadOpaqueIdV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	configRevision: WorkloadRevisionV1Schema,
	workloadRevision: WorkloadRevisionV1Schema,
	namespaceRef: WorkloadOpaqueIdV1Schema,
	imageDigest: ImmutableOciDigestV1Schema,
	resourceProfileRef: WorkloadOpaqueIdV1Schema,
	env: z.record(z.string().min(1), z.string()),
	service: WorkloadServiceV1Schema,
	health: WorkloadHealthV1Schema,
	persistentVolume: WorkloadPersistentVolumeV1Schema,
	serviceAccount: WorkloadServiceAccountV1Schema,
	networkPolicy: WorkloadNetworkPolicyV1Schema,
	secretRefs: z.array(KubernetesSecretReferenceV1Schema),
});

const platformAdapterWorkloadBaseV1Schema = desiredWorkloadBaseV1Schema.extend({
	runtimeManifest: PlatformAdapterRuntimeManifestV1Schema,
	route: internalWorkloadRouteV1Schema,
	networkPolicy: WorkloadNetworkPolicyV1Schema.extend({
		ingressMode: z.literal("runtime-host-client-only"),
	}),
});

const selfManagedPlatformAuthWorkloadBaseV1Schema =
	desiredWorkloadBaseV1Schema.extend({
		runtimeManifest: SelfManagedRuntimeManifestV1Schema,
		route: platformAuthWorkloadRouteV1Schema,
		networkPolicy: WorkloadNetworkPolicyV1Schema.extend({
			ingressMode: z.literal("platform-auth-route"),
		}),
	});

const selfManagedOwnerAuthWorkloadBaseV1Schema =
	desiredWorkloadBaseV1Schema.extend({
		runtimeManifest: SelfManagedRuntimeManifestV1Schema,
		route: ownerAuthWorkloadRouteV1Schema,
		networkPolicy: WorkloadNetworkPolicyV1Schema.extend({
			ingressMode: z.literal("self-managed-route"),
		}),
	});

const runningPlatformAdapterWorkloadV1Schema =
	platformAdapterWorkloadBaseV1Schema.extend({
		desiredState: z.literal("running"),
		replicas: z.literal(1),
	});

const stoppedPlatformAdapterWorkloadV1Schema =
	platformAdapterWorkloadBaseV1Schema.extend({
		desiredState: z.literal("stopped"),
		replicas: z.literal(0),
	});

const disabledPlatformAdapterWorkloadV1Schema =
	platformAdapterWorkloadBaseV1Schema.extend({
		desiredState: z.literal("disabled"),
		replicas: z.literal(0),
	});

const runningSelfManagedPlatformAuthWorkloadV1Schema =
	selfManagedPlatformAuthWorkloadBaseV1Schema.extend({
		desiredState: z.literal("running"),
		replicas: z.literal(1),
	});
const stoppedSelfManagedPlatformAuthWorkloadV1Schema =
	selfManagedPlatformAuthWorkloadBaseV1Schema.extend({
		desiredState: z.literal("stopped"),
		replicas: z.literal(0),
	});
const disabledSelfManagedPlatformAuthWorkloadV1Schema =
	selfManagedPlatformAuthWorkloadBaseV1Schema.extend({
		desiredState: z.literal("disabled"),
		replicas: z.literal(0),
	});
const runningSelfManagedOwnerAuthWorkloadV1Schema =
	selfManagedOwnerAuthWorkloadBaseV1Schema.extend({
		desiredState: z.literal("running"),
		replicas: z.literal(1),
	});
const stoppedSelfManagedOwnerAuthWorkloadV1Schema =
	selfManagedOwnerAuthWorkloadBaseV1Schema.extend({
		desiredState: z.literal("stopped"),
		replicas: z.literal(0),
	});
const disabledSelfManagedOwnerAuthWorkloadV1Schema =
	selfManagedOwnerAuthWorkloadBaseV1Schema.extend({
		desiredState: z.literal("disabled"),
		replicas: z.literal(0),
	});

export const AgentWorkloadDesiredV1Schema = z.union([
	runningPlatformAdapterWorkloadV1Schema,
	stoppedPlatformAdapterWorkloadV1Schema,
	disabledPlatformAdapterWorkloadV1Schema,
	runningSelfManagedPlatformAuthWorkloadV1Schema,
	stoppedSelfManagedPlatformAuthWorkloadV1Schema,
	disabledSelfManagedPlatformAuthWorkloadV1Schema,
	runningSelfManagedOwnerAuthWorkloadV1Schema,
	stoppedSelfManagedOwnerAuthWorkloadV1Schema,
	disabledSelfManagedOwnerAuthWorkloadV1Schema,
]);

const openWorkloadRouteAppliedV1Schema = z.strictObject({
	state: z.literal("open"),
	routeRef: WorkloadOpaqueIdV1Schema,
});
const pendingWorkloadRouteAppliedV1Schema = z.strictObject({
	state: z.literal("pending"),
	routeRef: WorkloadOpaqueIdV1Schema.optional(),
});
const closedWorkloadRouteAppliedV1Schema = z.strictObject({
	state: z.literal("closed"),
});

export const WorkloadRouteAppliedV1Schema = z.discriminatedUnion("state", [
	openWorkloadRouteAppliedV1Schema,
	pendingWorkloadRouteAppliedV1Schema,
	closedWorkloadRouteAppliedV1Schema,
]);

const healthyWorkloadAppliedV1Schema = z.strictObject({
	state: z.literal("healthy"),
	observedAt: WorkloadTimestampV1Schema,
});
const unhealthyWorkloadAppliedV1Schema = z.strictObject({
	state: z.literal("unhealthy"),
	observedAt: WorkloadTimestampV1Schema,
	error: WorkloadBoundaryErrorV1Schema.optional(),
});
const unknownWorkloadAppliedV1Schema = z.strictObject({
	state: z.literal("unknown"),
});

export const WorkloadHealthAppliedV1Schema = z.discriminatedUnion("state", [
	healthyWorkloadAppliedV1Schema,
	unhealthyWorkloadAppliedV1Schema,
	unknownWorkloadAppliedV1Schema,
]);

const appliedWorkloadBaseV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	requestId: WorkloadOpaqueIdV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	configRevision: WorkloadRevisionV1Schema,
	workloadRevision: WorkloadRevisionV1Schema,
	imageDigest: ImmutableOciDigestV1Schema,
	workloadUid: WorkloadOpaqueIdV1Schema,
	observedGeneration: WorkloadRevisionV1Schema,
	serviceRef: WorkloadOpaqueIdV1Schema,
	serviceAccountRef: WorkloadOpaqueIdV1Schema,
	persistentVolumeRef: WorkloadOpaqueIdV1Schema,
	networkPolicyRef: WorkloadOpaqueIdV1Schema,
	secretRefs: z.array(KubernetesSecretReferenceV1Schema),
});

const readyWorkloadAppliedV1Schema = appliedWorkloadBaseV1Schema.extend({
	state: z.literal("ready"),
	desiredReplicas: z.literal(1),
	readyReplicas: z.literal(1),
	route: openWorkloadRouteAppliedV1Schema,
	health: healthyWorkloadAppliedV1Schema,
	cleanupState: z.literal("not-requested"),
});

const applyingWorkloadAppliedV1Schema = appliedWorkloadBaseV1Schema.extend({
	state: z.literal("applying"),
	desiredReplicas: z.union([z.literal(0), z.literal(1)]),
	readyReplicas: z.union([z.literal(0), z.literal(1)]),
	route: z.union([
		pendingWorkloadRouteAppliedV1Schema,
		closedWorkloadRouteAppliedV1Schema,
	]),
	health: z.union([
		unknownWorkloadAppliedV1Schema,
		unhealthyWorkloadAppliedV1Schema,
	]),
	cleanupState: z.enum(["not-requested", "pending"]),
});

const degradedWorkloadAppliedV1Schema = appliedWorkloadBaseV1Schema.extend({
	state: z.literal("degraded"),
	desiredReplicas: z.literal(1),
	readyReplicas: z.literal(0),
	route: z.union([
		pendingWorkloadRouteAppliedV1Schema,
		closedWorkloadRouteAppliedV1Schema,
	]),
	health: unhealthyWorkloadAppliedV1Schema,
	cleanupState: z.enum(["not-requested", "pending"]),
});

const scaledDownWorkloadAppliedV1Schema = appliedWorkloadBaseV1Schema.extend({
	state: z.literal("scaled-down"),
	desiredReplicas: z.literal(0),
	readyReplicas: z.literal(0),
	route: closedWorkloadRouteAppliedV1Schema,
	health: unknownWorkloadAppliedV1Schema,
	cleanupState: z.literal("not-requested"),
});

export const AgentWorkloadAppliedV1Schema = z.discriminatedUnion("state", [
	applyingWorkloadAppliedV1Schema,
	readyWorkloadAppliedV1Schema,
	degradedWorkloadAppliedV1Schema,
	scaledDownWorkloadAppliedV1Schema,
]);

const reconcileCorrelationV1Shape = {
	schemaVersion: WorkloadSchemaVersionV1Schema,
	requestId: WorkloadOpaqueIdV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	configRevision: WorkloadRevisionV1Schema,
	workloadRevision: WorkloadRevisionV1Schema,
} as const;

export const KubernetesReconcileResultV1Schema = z.discriminatedUnion(
	"status",
	[
		z.strictObject({
			...reconcileCorrelationV1Shape,
			status: z.literal("applied"),
			applied: AgentWorkloadAppliedV1Schema,
		}),
		z.strictObject({
			...reconcileCorrelationV1Shape,
			status: z.literal("stale"),
			currentConfigRevision: WorkloadRevisionV1Schema,
			currentWorkloadRevision: WorkloadRevisionV1Schema,
			error: WorkloadBoundaryErrorV1Schema,
		}),
		z.strictObject({
			...reconcileCorrelationV1Shape,
			status: z.literal("rejected"),
			error: WorkloadBoundaryErrorV1Schema,
		}),
		z.strictObject({
			...reconcileCorrelationV1Shape,
			status: z.literal("failed"),
			error: WorkloadBoundaryErrorV1Schema,
		}),
	],
);

const cleanupCorrelationV1Schema = {
	schemaVersion: WorkloadSchemaVersionV1Schema,
	requestId: WorkloadOpaqueIdV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	configRevision: WorkloadRevisionV1Schema,
	workloadRevision: WorkloadRevisionV1Schema,
	workloadUid: WorkloadOpaqueIdV1Schema,
	deleteNewPersistentVolume: z.boolean(),
} as const;

export const WorkloadCleanupRequestV1Schema = z.strictObject({
	...cleanupCorrelationV1Schema,
});

const cleanupDeletedResourcesV1Schema = z.strictObject({
	workload: z.boolean(),
	service: z.boolean(),
	serviceAccount: z.boolean(),
	networkPolicy: z.boolean(),
	route: z.boolean(),
	secrets: z.boolean(),
	persistentVolume: z.boolean(),
});

export const WorkloadCleanupResultV1Schema = z.discriminatedUnion("status", [
	z.strictObject({
		...cleanupCorrelationV1Schema,
		status: z.literal("completed"),
		deleted: cleanupDeletedResourcesV1Schema,
	}),
	z.strictObject({
		...cleanupCorrelationV1Schema,
		status: z.literal("failed"),
		error: WorkloadBoundaryErrorV1Schema,
	}),
]);

export type AgentWorkloadDesiredV1 = z.infer<
	typeof AgentWorkloadDesiredV1Schema
>;
export type AgentWorkloadAppliedV1 = z.infer<
	typeof AgentWorkloadAppliedV1Schema
>;
export type KubernetesReconcileResultV1 = z.infer<
	typeof KubernetesReconcileResultV1Schema
>;
export type WorkloadCleanupRequestV1 = z.infer<
	typeof WorkloadCleanupRequestV1Schema
>;
export type WorkloadCleanupResultV1 = z.infer<
	typeof WorkloadCleanupResultV1Schema
>;

export function validateAgentWorkloadDesiredV1(
	desiredInput: unknown,
): AgentWorkloadDesiredV1 {
	const desired = AgentWorkloadDesiredV1Schema.parse(desiredInput);
	if (
		desired.service.port !== desired.runtimeManifest.service.port ||
		desired.health.path !== desired.runtimeManifest.health.path ||
		desired.secretRefs.some(
			(secretRef) =>
				secretRef.agentId !== desired.agentId ||
				secretRef.configRevision !== desired.configRevision,
		)
	) {
		throw new Error("Desired Workload correlation mismatch");
	}
	return desired;
}

export function validateAgentWorkloadAppliedV1(
	desiredInput: unknown,
	appliedInput: unknown,
): AgentWorkloadAppliedV1 {
	const desired = validateAgentWorkloadDesiredV1(desiredInput);
	const applied = AgentWorkloadAppliedV1Schema.parse(appliedInput);
	const desiredSecrets = desired.secretRefs.toSorted((left, right) =>
		left.name.localeCompare(right.name),
	);
	const appliedSecrets = applied.secretRefs.toSorted((left, right) =>
		left.name.localeCompare(right.name),
	);
	if (
		applied.requestId !== desired.requestId ||
		applied.traceId !== desired.traceId ||
		applied.agentId !== desired.agentId ||
		applied.configRevision !== desired.configRevision ||
		applied.workloadRevision !== desired.workloadRevision ||
		applied.imageDigest !== desired.imageDigest ||
		applied.desiredReplicas !== desired.replicas ||
		JSON.stringify(appliedSecrets) !== JSON.stringify(desiredSecrets)
	) {
		throw new Error("Applied Workload correlation mismatch");
	}
	return applied;
}

export function validateKubernetesReconcileResultV1(
	desiredInput: unknown,
	resultInput: unknown,
): KubernetesReconcileResultV1 {
	const desired = validateAgentWorkloadDesiredV1(desiredInput);
	const result = KubernetesReconcileResultV1Schema.parse(resultInput);
	if (
		result.requestId !== desired.requestId ||
		result.traceId !== desired.traceId ||
		result.agentId !== desired.agentId ||
		result.configRevision !== desired.configRevision ||
		result.workloadRevision !== desired.workloadRevision
	) {
		throw new Error("Kubernetes reconciliation correlation mismatch");
	}
	if (result.status === "applied") {
		validateAgentWorkloadAppliedV1(desired, result.applied);
	}
	return result;
}

export function validateWorkloadCleanupResultV1(
	requestInput: unknown,
	resultInput: unknown,
): WorkloadCleanupResultV1 {
	const request = WorkloadCleanupRequestV1Schema.parse(requestInput);
	const result = WorkloadCleanupResultV1Schema.parse(resultInput);
	if (
		result.requestId !== request.requestId ||
		result.traceId !== request.traceId ||
		result.agentId !== request.agentId ||
		result.configRevision !== request.configRevision ||
		result.workloadRevision !== request.workloadRevision ||
		result.workloadUid !== request.workloadUid ||
		result.deleteNewPersistentVolume !== request.deleteNewPersistentVolume
	) {
		throw new Error("Workload cleanup correlation mismatch");
	}
	return result;
}
