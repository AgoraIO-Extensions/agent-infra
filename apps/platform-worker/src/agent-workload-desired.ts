import {
	type AgentWorkloadDesiredV1,
	type ImageRegistryAdmissionResultV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import type { WorkloadReconciliationStateV1 } from "@agent-infra/platform-core";
import {
	type KubernetesWorkloadPolicyV1,
	workloadResourceNameV1,
} from "./kubernetes-runtime-adapter.js";
import type { WorkloadSkillMaterializationResultV1 } from "./skill-materialization.js";
import {
	assertWorkloadPublicRouteV1,
	workloadInteractionRouteV1,
} from "./workload-public-route.js";

type AdmittedImageV1 = Pick<
	Extract<ImageRegistryAdmissionResultV1, { status: "admitted" }>,
	| "immutableDigest"
	| "runtimeManifest"
	| "policyEvidence"
	| "runtimeManifestParsingEvidence"
>;

/**
 * The single-image (standard or custom, no manifest) Workload Desired that
 * preflight persists. Pure: callers supply the Registry admission, Secret
 * references, Skill materialization and snapshot metadata they resolved, so
 * reconciliation and a read-only preview compose the same object.
 */
export function composeSingleImageAgentWorkloadDesiredV1(input: {
	readonly requestId: string;
	readonly traceId: string;
	readonly agentId: string;
	readonly workloadRevision: number;
	readonly fence: number;
	readonly identity: WorkloadReconciliationStateV1["identity"];
	readonly configuration: WorkloadReconciliationStateV1["candidate"]["configuration"];
	readonly policy: KubernetesWorkloadPolicyV1;
	readonly admission: AdmittedImageV1;
	readonly secretRefs: AgentWorkloadDesiredV1["secretRefs"];
	readonly materializedSkills?: WorkloadSkillMaterializationResultV1;
	readonly frozenSkillDeliveryImage?: string;
	readonly workspaceSnapshots?: readonly {
		readonly snapshotId: string;
		readonly name: string;
		readonly digest: string;
		readonly sizeBytes: number;
		readonly objectRef: string;
	}[];
}): AgentWorkloadDesiredV1 {
	const { configuration, policy, admission, materializedSkills } = input;
	const name = workloadResourceNameV1(input.agentId);
	const mode =
		configuration.source.kind === "standard"
			? "platform-adapter"
			: configuration.source.interactionMode;
	const exposure =
		mode === "platform-adapter"
			? "internal-only"
			: configuration.source.kind === "custom" &&
					configuration.source.identityResponsibility === "platform-managed"
				? "platform-auth"
				: "self-managed";
	const frozenSkillDeliveryImage = input.frozenSkillDeliveryImage;
	const deployment = validateAgentWorkloadDesiredV1({
		schemaVersion: 1,
		requestId: input.requestId,
		traceId: input.traceId,
		agentId: input.agentId,
		configRevision: configuration.revision,
		workloadRevision: input.workloadRevision,
		fence: input.fence,
		expectedWorkload: input.identity
			? {
					state: "present",
					workloadUid: input.identity.uid,
					workloadGeneration: input.identity.generation,
				}
			: { state: "absent" },
		namespaceRef: policy.namespaceRef,
		imageDigest: configuration.source.imageDigest,
		registryAdmission: {
			schemaVersion: 1,
			immutableDigest: admission.immutableDigest,
			runtimeManifest: admission.runtimeManifest,
			policyEvidence: admission.policyEvidence,
			runtimeManifestParsingEvidence: admission.runtimeManifestParsingEvidence,
		},
		runtimeManifest: admission.runtimeManifest,
		resourceProfileRef: policy.resourceProfileRef,
		env: Object.fromEntries(
			configuration.environment.map((entry) => [entry.name, entry.value]),
		),
		service: { name, port: admission.runtimeManifest.service.port },
		health: {
			path: admission.runtimeManifest.health.path,
			timeoutSeconds: 5,
			failureThreshold: 3,
		},
		persistentVolume: {
			name: `${name}-data`,
			mountPath: "/workspace",
			storageProfileRef: policy.storageProfileRef,
			accessMode: "ReadWriteOnce",
			retention: "retain",
		},
		serviceAccount: { name, kubernetesApiAccess: false },
		networkPolicy: {
			deploymentPolicyRef: policy.networkPolicyRef,
			ingressMode:
				exposure === "internal-only"
					? "runtime-host-client-only"
					: exposure === "platform-auth"
						? "platform-auth-route"
						: "self-managed-route",
			kubernetesApiAccess: false,
			platformDatabaseAccess: false,
			connectionDatabaseAccess: false,
			decryptionKeyringAccess: false,
		},
		route: {
			name,
			exposure,
			tlsRequired: true,
			...(exposure === "self-managed"
				? {
						...workloadInteractionRouteV1(policy, input.agentId),
					}
				: {}),
		},
		secretRefs: input.secretRefs,
		...(materializedSkills &&
		(!frozenSkillDeliveryImage || materializedSkills.skills.length > 0)
			? {
					...(frozenSkillDeliveryImage
						? { skillDeliveryImage: frozenSkillDeliveryImage }
						: {}),
					skills: materializedSkills.skills,
					skillAppliedBindings: materializedSkills.appliedBindings?.length
						? JSON.stringify(materializedSkills.appliedBindings)
						: undefined,
					skillGenerationId: materializedSkills.generationId,
				}
			: {}),
		...(input.workspaceSnapshots
			? {
					workspaceSnapshots: input.workspaceSnapshots.map((snapshot) => ({
						snapshotId: snapshot.snapshotId,
						name: snapshot.name,
						digest: snapshot.digest,
						sizeBytes: snapshot.sizeBytes,
						objectRef: snapshot.objectRef,
						mountPath: `/opt/agent/workspaces/${snapshot.name}`,
					})),
				}
			: {}),
		desiredState: "running",
		replicas: 1,
	});
	assertWorkloadPublicRouteV1(policy, deployment);
	return deployment;
}
