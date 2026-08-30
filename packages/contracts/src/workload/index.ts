import {
	WorkloadBoundaryErrorV1Schema,
	WorkloadFenceV1Schema,
	WorkloadOpaqueIdV1Schema,
	WorkloadRevisionV1Schema,
	WorkloadSchemaVersionV1Schema,
	WorkloadTimestampV1Schema,
} from "./common.ts";
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

export * from "./common.ts";
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
