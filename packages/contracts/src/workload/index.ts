import {
	WorkloadBoundaryErrorV1Schema,
	WorkloadFenceV1Schema,
	WorkloadOpaqueIdV1Schema,
	WorkloadRevisionV1Schema,
	WorkloadSchemaVersionV1Schema,
	WorkloadTimestampV1Schema,
} from "./common.ts";
import {
	AgentWorkloadDesiredV1Schema,
	KubernetesReconcileResultV1Schema,
	KubernetesRuntimeCapabilitiesV1Schema,
	WorkloadCleanupRequestV1Schema,
	WorkloadCleanupResultV1Schema,
	WorkloadRouteSwitchRequestV1Schema,
	WorkloadRouteSwitchResultV1Schema,
} from "./kubernetes.ts";
import {
	ImageAdmissionPolicyEvidenceV1Schema,
	ImageRegistryAdmissionErrorV1Schema,
	ImageRegistryAdmissionRequestV1Schema,
	ImageRegistryAdmissionResultV1Schema,
	ImmutableOciDigestV1Schema,
	OciDeclaredEnvironmentKeyV1Schema,
	OciImageConfigV1Schema,
	OciImageReferenceV1Schema,
	RuntimeManifestParsingEvidenceV1Schema,
} from "./registry.ts";
import {
	RuntimeCapabilitySetV1Schema,
	RuntimeHealthV1Schema,
	RuntimeManifestV1Schema,
	RuntimeServiceV1Schema,
} from "./runtime-manifest.ts";
import {
	KubernetesSecretReferenceV1Schema,
	PlatformSecretRecordV1Schema,
	SecretAadBindingV1Schema,
	SecretActivationFenceV1Schema,
	SecretActivationObservationV1Schema,
	SecretAuditEventV1Schema,
	SecretCryptoMetadataV1Schema,
	SecretEncryptionKeySetV1Schema,
	SecretKeyRotationV1Schema,
	SecretLifecycleErrorV1Schema,
	SecretPublicKeyDescriptorV1Schema,
	SecretWorkerKeyringDescriptorV1Schema,
} from "./secret.ts";
import {
	WorkerWorkloadErrorV1Schema,
	WorkerWorkloadExpectedRevisionV1Schema,
	WorkerWorkloadResultV1Schema,
} from "./worker-result.ts";

export * from "./common.ts";
export * from "./kubernetes.ts";
export * from "./registry.ts";
export {
	type RuntimeCapabilitySetV1,
	RuntimeCapabilitySetV1Schema,
	RuntimeHealthV1Schema,
	type RuntimeManifestV1,
	RuntimeManifestV1Schema,
	RuntimeServiceV1Schema,
	resolveRuntimeManifestCapabilitiesV1,
} from "./runtime-manifest.ts";
export * from "./secret.ts";
export * from "./worker-result.ts";

export const kubernetesWorkloadSchemasV1 = {
	AgentWorkloadDesiredV1: AgentWorkloadDesiredV1Schema,
	KubernetesReconcileResultV1: KubernetesReconcileResultV1Schema,
	KubernetesRuntimeCapabilitiesV1: KubernetesRuntimeCapabilitiesV1Schema,
	WorkloadCleanupRequestV1: WorkloadCleanupRequestV1Schema,
	WorkloadCleanupResultV1: WorkloadCleanupResultV1Schema,
	WorkloadRouteSwitchRequestV1: WorkloadRouteSwitchRequestV1Schema,
	WorkloadRouteSwitchResultV1: WorkloadRouteSwitchResultV1Schema,
} as const;

export const registryManifestSchemasV1 = {
	ImageAdmissionPolicyEvidenceV1: ImageAdmissionPolicyEvidenceV1Schema,
	ImageRegistryAdmissionErrorV1: ImageRegistryAdmissionErrorV1Schema,
	ImageRegistryAdmissionRequestV1: ImageRegistryAdmissionRequestV1Schema,
	ImageRegistryAdmissionResultV1: ImageRegistryAdmissionResultV1Schema,
	ImmutableOciDigestV1: ImmutableOciDigestV1Schema,
	OciDeclaredEnvironmentKeyV1: OciDeclaredEnvironmentKeyV1Schema,
	OciImageConfigV1: OciImageConfigV1Schema,
	OciImageReferenceV1: OciImageReferenceV1Schema,
	RuntimeCapabilitySetV1: RuntimeCapabilitySetV1Schema,
	RuntimeHealthV1: RuntimeHealthV1Schema,
	RuntimeManifestParsingEvidenceV1: RuntimeManifestParsingEvidenceV1Schema,
	RuntimeManifestV1: RuntimeManifestV1Schema,
	RuntimeServiceV1: RuntimeServiceV1Schema,
	WorkloadBoundaryErrorV1: WorkloadBoundaryErrorV1Schema,
	WorkloadFenceV1: WorkloadFenceV1Schema,
	WorkloadOpaqueIdV1: WorkloadOpaqueIdV1Schema,
	WorkloadRevisionV1: WorkloadRevisionV1Schema,
	WorkloadSchemaVersionV1: WorkloadSchemaVersionV1Schema,
	WorkloadTimestampV1: WorkloadTimestampV1Schema,
} as const;

export const secretLifecycleSchemasV1 = {
	KubernetesSecretReferenceV1: KubernetesSecretReferenceV1Schema,
	PlatformSecretRecordV1: PlatformSecretRecordV1Schema,
	SecretAadBindingV1: SecretAadBindingV1Schema,
	SecretActivationFenceV1: SecretActivationFenceV1Schema,
	SecretActivationObservationV1: SecretActivationObservationV1Schema,
	SecretAuditEventV1: SecretAuditEventV1Schema,
	SecretCryptoMetadataV1: SecretCryptoMetadataV1Schema,
	SecretEncryptionKeySetV1: SecretEncryptionKeySetV1Schema,
	SecretKeyRotationV1: SecretKeyRotationV1Schema,
	SecretLifecycleErrorV1: SecretLifecycleErrorV1Schema,
	SecretPublicKeyDescriptorV1: SecretPublicKeyDescriptorV1Schema,
	SecretWorkerKeyringDescriptorV1: SecretWorkerKeyringDescriptorV1Schema,
	WorkloadBoundaryErrorV1: WorkloadBoundaryErrorV1Schema,
	WorkloadFenceV1: WorkloadFenceV1Schema,
	WorkloadOpaqueIdV1: WorkloadOpaqueIdV1Schema,
	WorkloadRevisionV1: WorkloadRevisionV1Schema,
	WorkloadSchemaVersionV1: WorkloadSchemaVersionV1Schema,
	WorkloadTimestampV1: WorkloadTimestampV1Schema,
} as const;

export const workerResultSchemasV1 = {
	WorkerWorkloadErrorV1: WorkerWorkloadErrorV1Schema,
	WorkerWorkloadExpectedRevisionV1: WorkerWorkloadExpectedRevisionV1Schema,
	WorkerWorkloadResultV1: WorkerWorkloadResultV1Schema,
} as const;
