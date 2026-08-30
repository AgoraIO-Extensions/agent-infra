import { z } from "zod";

import {
	WorkloadFenceV1Schema,
	WorkloadOpaqueIdV1Schema,
	WorkloadRevisionV1Schema,
	WorkloadSchemaVersionV1Schema,
	WorkloadTimestampV1Schema,
} from "./common.ts";
import {
	ImageAdmissionPolicyEvidenceV1Schema,
	ImmutableOciDigestV1Schema,
	RuntimeManifestParsingEvidenceV1Schema,
} from "./registry.ts";
import {
	PlatformAdapterRuntimeManifestV1Schema,
	RuntimeManifestV1Schema,
	SelfManagedRuntimeManifestV1Schema,
} from "./runtime-manifest.ts";
import { KubernetesSecretReferenceV1Schema } from "./secret.ts";

const kubernetesErrorBaseV1Shape = {
	schemaVersion: WorkloadSchemaVersionV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
} as const;

const kubernetesPolicyRejectedErrorV1Schema = z.strictObject({
	...kubernetesErrorBaseV1Shape,
	code: z.literal("KUBERNETES_POLICY_REJECTED"),
	message: z.literal("Kubernetes policy rejected the Workload"),
	retryable: z.literal(false),
});
const kubernetesStaleRevisionErrorV1Schema = z.strictObject({
	...kubernetesErrorBaseV1Shape,
	code: z.literal("KUBERNETES_STALE_REVISION"),
	message: z.literal("A newer Workload revision is already current"),
	retryable: z.literal(false),
});
const kubernetesApplyIncompleteErrorV1Schema = z.strictObject({
	...kubernetesErrorBaseV1Shape,
	code: z.literal("KUBERNETES_APPLY_INCOMPLETE"),
	message: z.literal("Kubernetes Workload did not fully converge"),
	retryable: z.literal(true),
});
const kubernetesHealthCheckFailedErrorV1Schema = z.strictObject({
	...kubernetesErrorBaseV1Shape,
	code: z.literal("KUBERNETES_HEALTH_CHECK_FAILED"),
	message: z.literal("Kubernetes Workload failed its health check"),
	retryable: z.literal(true),
});
const kubernetesRouteSwitchFailedErrorV1Schema = z.strictObject({
	...kubernetesErrorBaseV1Shape,
	code: z.literal("KUBERNETES_ROUTE_SWITCH_FAILED"),
	message: z.literal("Kubernetes route switch did not converge"),
	retryable: z.literal(true),
});
const kubernetesCleanupFailedErrorV1Schema = z.strictObject({
	...kubernetesErrorBaseV1Shape,
	code: z.literal("KUBERNETES_CLEANUP_FAILED"),
	message: z.literal("Kubernetes Workload cleanup did not complete"),
	retryable: z.literal(true),
});
const kubernetesAdapterUnavailableErrorV1Schema = z.strictObject({
	...kubernetesErrorBaseV1Shape,
	code: z.literal("KUBERNETES_ADAPTER_UNAVAILABLE"),
	message: z.literal("Kubernetes reconciliation is temporarily unavailable"),
	retryable: z.literal(true),
});

export const KubernetesBoundaryErrorV1Schema = z.discriminatedUnion("code", [
	kubernetesPolicyRejectedErrorV1Schema,
	kubernetesStaleRevisionErrorV1Schema,
	kubernetesApplyIncompleteErrorV1Schema,
	kubernetesHealthCheckFailedErrorV1Schema,
	kubernetesRouteSwitchFailedErrorV1Schema,
	kubernetesCleanupFailedErrorV1Schema,
	kubernetesAdapterUnavailableErrorV1Schema,
]);

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

export const WorkloadIdentityV1Schema = z.strictObject({
	workloadUid: WorkloadOpaqueIdV1Schema,
	workloadGeneration: WorkloadRevisionV1Schema,
});

export const WorkloadExpectationV1Schema = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("absent") }),
	WorkloadIdentityV1Schema.extend({ state: z.literal("present") }),
]);

export const WorkloadRegistryAdmissionV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	immutableDigest: ImmutableOciDigestV1Schema,
	runtimeManifest: RuntimeManifestV1Schema,
	policyEvidence: ImageAdmissionPolicyEvidenceV1Schema,
	runtimeManifestParsingEvidence: RuntimeManifestParsingEvidenceV1Schema,
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
	fence: WorkloadFenceV1Schema,
	expectedWorkload: WorkloadExpectationV1Schema,
	namespaceRef: WorkloadOpaqueIdV1Schema,
	imageDigest: ImmutableOciDigestV1Schema,
	registryAdmission: WorkloadRegistryAdmissionV1Schema,
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
	workloadUid: WorkloadOpaqueIdV1Schema,
	workloadRevision: WorkloadRevisionV1Schema,
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
	error: KubernetesBoundaryErrorV1Schema.optional(),
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
	fence: WorkloadFenceV1Schema,
	imageDigest: ImmutableOciDigestV1Schema,
	workloadUid: WorkloadOpaqueIdV1Schema,
	observedGeneration: WorkloadRevisionV1Schema,
	resourceProfileRef: WorkloadOpaqueIdV1Schema,
	service: WorkloadServiceV1Schema,
	healthCheck: WorkloadHealthV1Schema,
	routeIntent: WorkloadRouteV1Schema,
	persistentVolume: WorkloadPersistentVolumeV1Schema,
	serviceAccount: WorkloadServiceAccountV1Schema,
	networkPolicy: WorkloadNetworkPolicyV1Schema,
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
	fence: WorkloadFenceV1Schema,
} as const;

export const KubernetesReconcileResultV1Schema = z.discriminatedUnion(
	"status",
	[
		z.strictObject({
			...reconcileCorrelationV1Shape,
			status: z.literal("applied"),
			workloadUid: WorkloadOpaqueIdV1Schema,
			workloadGeneration: WorkloadRevisionV1Schema,
			applied: AgentWorkloadAppliedV1Schema,
		}),
		z.strictObject({
			...reconcileCorrelationV1Shape,
			status: z.literal("stale"),
			currentConfigRevision: WorkloadRevisionV1Schema,
			currentWorkloadRevision: WorkloadRevisionV1Schema,
			error: kubernetesStaleRevisionErrorV1Schema,
		}),
		z.strictObject({
			...reconcileCorrelationV1Shape,
			status: z.literal("rejected"),
			error: kubernetesPolicyRejectedErrorV1Schema,
		}),
		z.strictObject({
			...reconcileCorrelationV1Shape,
			status: z.literal("failed"),
			error: z.union([
				kubernetesApplyIncompleteErrorV1Schema,
				kubernetesHealthCheckFailedErrorV1Schema,
				kubernetesAdapterUnavailableErrorV1Schema,
			]),
		}),
	],
);

export const WorkloadRouteTargetV1Schema = z.strictObject({
	routeRef: WorkloadOpaqueIdV1Schema,
	workloadUid: WorkloadOpaqueIdV1Schema,
	workloadRevision: WorkloadRevisionV1Schema,
	workloadGeneration: WorkloadRevisionV1Schema,
});

const routeSwitchCorrelationV1Shape = {
	schemaVersion: WorkloadSchemaVersionV1Schema,
	requestId: WorkloadOpaqueIdV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	fence: WorkloadFenceV1Schema,
} as const;

const promoteWorkloadRouteRequestV1Schema = z.strictObject({
	...routeSwitchCorrelationV1Shape,
	action: z.literal("promote"),
	previousRoute: WorkloadRouteTargetV1Schema.optional(),
	candidateRoute: WorkloadRouteTargetV1Schema,
	candidateValidated: z.literal(true),
});
const rollbackWorkloadRouteRequestV1Schema = z.strictObject({
	...routeSwitchCorrelationV1Shape,
	action: z.literal("rollback"),
	previousRoute: WorkloadRouteTargetV1Schema,
	candidateRoute: WorkloadRouteTargetV1Schema,
});

export const WorkloadRouteSwitchRequestV1Schema = z.discriminatedUnion(
	"action",
	[promoteWorkloadRouteRequestV1Schema, rollbackWorkloadRouteRequestV1Schema],
);

const routeSwitchResultBaseV1Shape = {
	...routeSwitchCorrelationV1Shape,
	action: z.enum(["promote", "rollback"]),
	routedWorkloads: z.array(WorkloadRouteTargetV1Schema).max(1),
} as const;

export const WorkloadRouteSwitchResultV1Schema = z.discriminatedUnion(
	"status",
	[
		z.strictObject({
			...routeSwitchResultBaseV1Shape,
			status: z.literal("completed"),
		}),
		z.strictObject({
			...routeSwitchResultBaseV1Shape,
			status: z.literal("failed"),
			error: kubernetesRouteSwitchFailedErrorV1Schema,
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
	workloadGeneration: WorkloadRevisionV1Schema,
	fence: WorkloadFenceV1Schema,
	persistentVolumeIntent: z.enum(["delete-new", "retain-existing"]),
} as const;

export const WorkloadCleanupRequestV1Schema = z.strictObject({
	...cleanupCorrelationV1Schema,
});

const cleanupResourcesV1Shape = {
	route: z.literal(true),
	workload: z.literal(true),
	service: z.literal(true),
	serviceAccount: z.literal(true),
	networkPolicy: z.literal(true),
	configuration: z.literal(true),
	secrets: z.literal(true),
} as const;

const pendingCleanupResourcesV1Schema = z.strictObject({
	route: z.boolean(),
	workload: z.boolean(),
	service: z.boolean(),
	serviceAccount: z.boolean(),
	networkPolicy: z.boolean(),
	configuration: z.boolean(),
	secrets: z.boolean(),
	persistentVolume: z.boolean(),
});

const untouchedCleanupResourcesV1Schema = z.strictObject({
	route: z.literal(false),
	workload: z.literal(false),
	service: z.literal(false),
	serviceAccount: z.literal(false),
	networkPolicy: z.literal(false),
	configuration: z.literal(false),
	secrets: z.literal(false),
	persistentVolume: z.literal(false),
});

const completedCleanupWithVolumeV1Schema = z.strictObject({
	...cleanupCorrelationV1Schema,
	persistentVolumeIntent: z.literal("delete-new"),
	status: z.literal("completed"),
	routeClosed: z.literal(true),
	removed: z.strictObject({
		...cleanupResourcesV1Shape,
		persistentVolume: z.literal(true),
	}),
});

const completedCleanupWithoutVolumeV1Schema = z.strictObject({
	...cleanupCorrelationV1Schema,
	persistentVolumeIntent: z.literal("retain-existing"),
	status: z.literal("completed"),
	routeClosed: z.literal(true),
	removed: z.strictObject({
		...cleanupResourcesV1Shape,
		persistentVolume: z.literal(false),
	}),
});

export const WorkloadCleanupResultV1Schema = z.union([
	z.strictObject({
		...cleanupCorrelationV1Schema,
		status: z.literal("in-progress"),
		phase: z.literal("closing-route"),
		routeClosed: z.literal(false),
		removed: untouchedCleanupResourcesV1Schema,
	}),
	z.strictObject({
		...cleanupCorrelationV1Schema,
		status: z.literal("in-progress"),
		phase: z.literal("removing-resources"),
		routeClosed: z.literal(true),
		removed: pendingCleanupResourcesV1Schema,
	}),
	completedCleanupWithVolumeV1Schema,
	completedCleanupWithoutVolumeV1Schema,
	z.strictObject({
		...cleanupCorrelationV1Schema,
		status: z.literal("failed"),
		phase: z.enum(["closing-route", "removing-resources"]),
		routeClosed: z.boolean(),
		removed: pendingCleanupResourcesV1Schema,
		error: kubernetesCleanupFailedErrorV1Schema,
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
export type WorkloadRouteSwitchRequestV1 = z.infer<
	typeof WorkloadRouteSwitchRequestV1Schema
>;
export type WorkloadRouteSwitchResultV1 = z.infer<
	typeof WorkloadRouteSwitchResultV1Schema
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
		desired.registryAdmission.immutableDigest !== desired.imageDigest ||
		desired.registryAdmission.policyEvidence.agentId !== desired.agentId ||
		desired.registryAdmission.policyEvidence.imageDigest !==
			desired.imageDigest ||
		JSON.stringify(desired.registryAdmission.runtimeManifest) !==
			JSON.stringify(desired.runtimeManifest) ||
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
		applied.fence !== desired.fence ||
		applied.imageDigest !== desired.imageDigest ||
		applied.resourceProfileRef !== desired.resourceProfileRef ||
		applied.service.name !== desired.service.name ||
		applied.service.port !== desired.service.port ||
		applied.healthCheck.path !== desired.health.path ||
		applied.healthCheck.timeoutSeconds !== desired.health.timeoutSeconds ||
		applied.healthCheck.failureThreshold !== desired.health.failureThreshold ||
		JSON.stringify(applied.routeIntent) !== JSON.stringify(desired.route) ||
		JSON.stringify(applied.persistentVolume) !==
			JSON.stringify(desired.persistentVolume) ||
		JSON.stringify(applied.serviceAccount) !==
			JSON.stringify(desired.serviceAccount) ||
		JSON.stringify(applied.networkPolicy) !==
			JSON.stringify(desired.networkPolicy) ||
		applied.desiredReplicas !== desired.replicas ||
		(desired.expectedWorkload.state === "present" &&
			(applied.workloadUid !== desired.expectedWorkload.workloadUid ||
				applied.observedGeneration <
					desired.expectedWorkload.workloadGeneration)) ||
		(applied.route.state === "open" &&
			(applied.route.workloadUid !== applied.workloadUid ||
				applied.route.workloadRevision !== applied.workloadRevision)) ||
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
		result.workloadRevision !== desired.workloadRevision ||
		result.fence !== desired.fence
	) {
		throw new Error("Kubernetes reconciliation correlation mismatch");
	}
	if (result.status === "applied") {
		if (
			result.workloadUid !== result.applied.workloadUid ||
			result.workloadGeneration !== result.applied.observedGeneration
		) {
			throw new Error("Kubernetes reconciliation correlation mismatch");
		}
		validateAgentWorkloadAppliedV1(desired, result.applied);
	} else if (result.error.traceId !== desired.traceId) {
		throw new Error("Kubernetes reconciliation correlation mismatch");
	}
	if (
		result.status === "stale" &&
		(result.currentConfigRevision < desired.configRevision ||
			result.currentWorkloadRevision < desired.workloadRevision ||
			(result.currentConfigRevision === desired.configRevision &&
				result.currentWorkloadRevision === desired.workloadRevision))
	) {
		throw new Error("Kubernetes reconciliation correlation mismatch");
	}
	return result;
}

function workloadRouteTargetMatchesV1(
	left: z.infer<typeof WorkloadRouteTargetV1Schema>,
	right: z.infer<typeof WorkloadRouteTargetV1Schema>,
): boolean {
	return (
		left.routeRef === right.routeRef &&
		left.workloadUid === right.workloadUid &&
		left.workloadRevision === right.workloadRevision &&
		left.workloadGeneration === right.workloadGeneration
	);
}

export function validateWorkloadRouteSwitchRequestV1(
	requestInput: unknown,
): WorkloadRouteSwitchRequestV1 {
	const request = WorkloadRouteSwitchRequestV1Schema.parse(requestInput);
	if (
		request.previousRoute !== undefined &&
		request.candidateRoute.workloadRevision <=
			request.previousRoute.workloadRevision
	) {
		throw new Error("Kubernetes route switch correlation mismatch");
	}
	return request;
}

export function validateWorkloadRouteSwitchResultV1(
	requestInput: unknown,
	resultInput: unknown,
): WorkloadRouteSwitchResultV1 {
	const request = validateWorkloadRouteSwitchRequestV1(requestInput);
	const result = WorkloadRouteSwitchResultV1Schema.parse(resultInput);
	const expectedRoute =
		request.action === "promote"
			? request.candidateRoute
			: request.previousRoute;
	const routedWorkload = result.routedWorkloads[0];
	if (
		result.requestId !== request.requestId ||
		result.traceId !== request.traceId ||
		result.agentId !== request.agentId ||
		result.fence !== request.fence ||
		result.action !== request.action ||
		(result.status === "completed" &&
			(routedWorkload === undefined ||
				!workloadRouteTargetMatchesV1(routedWorkload, expectedRoute))) ||
		(result.status === "failed" &&
			(result.error.traceId !== request.traceId ||
				(routedWorkload !== undefined &&
					(request.previousRoute === undefined ||
						!workloadRouteTargetMatchesV1(
							routedWorkload,
							request.previousRoute,
						)))))
	) {
		throw new Error("Kubernetes route switch correlation mismatch");
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
		result.workloadGeneration !== request.workloadGeneration ||
		result.fence !== request.fence ||
		result.persistentVolumeIntent !== request.persistentVolumeIntent ||
		(result.persistentVolumeIntent === "retain-existing" &&
			result.removed.persistentVolume) ||
		(result.status === "failed" &&
			(result.error.traceId !== request.traceId ||
				(result.phase === "closing-route" &&
					(result.routeClosed ||
						Object.values(result.removed).some(Boolean))) ||
				(result.phase === "removing-resources" && !result.routeClosed)))
	) {
		throw new Error("Workload cleanup correlation mismatch");
	}
	return result;
}
