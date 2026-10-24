export * from "./browser-capability.ts";
export * from "./browser-handoff.ts";
export * from "./browser-side-effect.ts";

import {
	RuntimeBrowserHandoffRequestV3Schema,
	RuntimeBrowserHandoffResponseV3Schema,
} from "./browser-handoff.ts";
import {
	RuntimeBrowserSideEffectConfirmationRequestV3Schema,
	RuntimeBrowserSideEffectConfirmationResponseV3Schema,
} from "./browser-side-effect.ts";

export * from "./configuration.ts";
export * from "./configuration-v4.ts";
export * from "./driver.ts";
export * from "./driver-v4.ts";
export * from "./events.ts";
export * from "./events-v2.ts";
export * from "./grant.ts";
export * from "./grant-v2.ts";
export * from "./host.ts";
export * from "./host-v3.ts";
export * from "./host-v4.ts";
export * from "./host-v4-events.ts";
export * from "./host-v4-key-recovery.ts";
export * from "./host-v5.ts";
export * from "./installation.ts";
export * from "./legacy-migration-v1.ts";
export * from "./native-capability.ts";
export * from "./native-metadata-v1.ts";
export * from "./native-metadata-v2.ts";
export * from "./platform-entry-auth.ts";
export * from "./readiness.ts";
export * from "./saved-key-candidates.ts";
export * from "./skill-hub.ts";

import { RuntimeBrowserCapabilityProbeEvidenceV1Schema } from "./browser-capability.ts";
import {
	RuntimeDriverCommandV1Schema,
	RuntimeDriverCommandV2Schema,
	RuntimeDriverLookupV1Schema,
	RuntimeDriverLookupV2Schema,
	RuntimeDriverNativeCommandOperationRecordV2Schema,
	RuntimeDriverNativeCommandV1Schema,
	RuntimeDriverNativeCommandV2Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverOperationRecordV2Schema,
	RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnLookupV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
} from "./driver.ts";
import {
	RuntimeCapabilitiesV1Schema,
	RuntimeEventV1Schema,
	RuntimeSkillCapabilityV1Schema,
	RuntimeStatusV1Schema,
} from "./events.ts";
import {
	ExecutionGrantClaimsV1Schema,
	ExecutionGrantCommandV1Schema,
	ExecutionGrantV1Schema,
} from "./grant.ts";
import {
	RuntimeCapabilitiesRequestV1Schema,
	RuntimeCapabilitiesResponseV1Schema,
	RuntimeGenerationCancelRequestV1Schema,
	RuntimeInputV1Schema,
	RuntimeModelDirectoryDispatchRequestV1Schema,
	RuntimeModelDirectoryRequestV1Schema,
	RuntimeModelDirectoryResponseV1Schema,
	RuntimeOperationResponseV1Schema,
	RuntimeOperationResponseV2Schema,
	RuntimeOperationResultV1Schema,
	RuntimeOperationResultV2Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeReplayResponseV1Schema,
	RuntimeSelectionV1Schema,
	RuntimeSkillDirectoryEntryV1Schema,
	RuntimeSkillDirectoryRequestV1Schema,
	RuntimeSkillDirectoryResponseV1Schema,
	RuntimeSkillResourceReadRequestV1Schema,
	RuntimeSkillResourceReadResponseV1Schema,
	RuntimeStatusRequestV1Schema,
	RuntimeStatusRequestV2Schema,
	RuntimeStatusResponseV1Schema,
	RuntimeStatusResponseV2Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSubmitTurnRequestV2Schema,
	RuntimeSupplementRequestV1Schema,
} from "./host.ts";

export const RuntimeHostV1SchemaDefinitions = {
	ExecutionGrantClaimsV1: ExecutionGrantClaimsV1Schema,
	ExecutionGrantCommandV1: ExecutionGrantCommandV1Schema,
	ExecutionGrantV1: ExecutionGrantV1Schema,
	RuntimeCapabilitiesRequestV1: RuntimeCapabilitiesRequestV1Schema,
	RuntimeCapabilitiesResponseV1: RuntimeCapabilitiesResponseV1Schema,
	RuntimeSkillDirectoryEntryV1: RuntimeSkillDirectoryEntryV1Schema,
	RuntimeSkillDirectoryRequestV1: RuntimeSkillDirectoryRequestV1Schema,
	RuntimeSkillDirectoryResponseV1: RuntimeSkillDirectoryResponseV1Schema,
	RuntimeSkillResourceReadRequestV1: RuntimeSkillResourceReadRequestV1Schema,
	RuntimeSkillResourceReadResponseV1: RuntimeSkillResourceReadResponseV1Schema,
	RuntimeModelDirectoryRequestV1: RuntimeModelDirectoryRequestV1Schema,
	RuntimeModelDirectoryDispatchRequestV1:
		RuntimeModelDirectoryDispatchRequestV1Schema,
	RuntimeModelDirectoryResponseV1: RuntimeModelDirectoryResponseV1Schema,
	RuntimeGenerationCancelRequestV1: RuntimeGenerationCancelRequestV1Schema,
	RuntimeInputV1: RuntimeInputV1Schema,
	RuntimeOperationResponseV1: RuntimeOperationResponseV1Schema,
	RuntimeOperationResultV1: RuntimeOperationResultV1Schema,
	RuntimeReplayRequestV1: RuntimeReplayRequestV1Schema,
	RuntimeReplayResponseV1: RuntimeReplayResponseV1Schema,
	RuntimeStatusRequestV1: RuntimeStatusRequestV1Schema,
	RuntimeStatusResponseV1: RuntimeStatusResponseV1Schema,
	RuntimeStopRequestV1: RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1: RuntimeSubmitTurnRequestV1Schema,
	RuntimeSupplementRequestV1: RuntimeSupplementRequestV1Schema,
};

export { RuntimeNativeMetadataV1SchemaDefinitions } from "./native-metadata-v1.ts";

export const RuntimeEventV1SchemaDefinitions = {
	RuntimeCapabilitiesV1: RuntimeCapabilitiesV1Schema,
	RuntimeBrowserCapabilityProbeEvidenceV1:
		RuntimeBrowserCapabilityProbeEvidenceV1Schema,
	RuntimeSkillCapabilityV1: RuntimeSkillCapabilityV1Schema,
	RuntimeEventV1: RuntimeEventV1Schema,
	RuntimeStatusV1: RuntimeStatusV1Schema,
};

export const RuntimeDriverV1SchemaDefinitions = {
	RuntimeDriverCommandV1: RuntimeDriverCommandV1Schema,
	RuntimeDriverNativeCommandV1: RuntimeDriverNativeCommandV1Schema,
	RuntimeDriverLookupV1: RuntimeDriverLookupV1Schema,
	RuntimeDriverOperationRecordV1: RuntimeDriverOperationRecordV1Schema,
};

export const RuntimeDriverV2SchemaDefinitions = {
	RuntimeDriverCommandV2: RuntimeDriverCommandV2Schema,
	RuntimeDriverNativeCommandV2: RuntimeDriverNativeCommandV2Schema,
	RuntimeDriverNativeCommandOperationRecordV2:
		RuntimeDriverNativeCommandOperationRecordV2Schema,
	RuntimeDriverOperationRecordV2: RuntimeDriverOperationRecordV2Schema,
	RuntimeDriverSubmitTurnCommandV2: RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnLookupV2: RuntimeDriverSubmitTurnLookupV2Schema,
	RuntimeDriverLookupV2: RuntimeDriverLookupV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2:
		RuntimeDriverSubmitTurnOperationRecordV2Schema,
};

export const RuntimeHostV2SchemaDefinitions = {
	RuntimeOperationResponseV2: RuntimeOperationResponseV2Schema,
	RuntimeOperationResultV2: RuntimeOperationResultV2Schema,
	RuntimeSelectionV1: RuntimeSelectionV1Schema,
	RuntimeSubmitTurnRequestV2: RuntimeSubmitTurnRequestV2Schema,
	RuntimeStatusRequestV2: RuntimeStatusRequestV2Schema,
	RuntimeStatusResponseV2: RuntimeStatusResponseV2Schema,
};

import {
	RuntimeBusinessCommandV2Schema,
	RuntimeBusinessGrantClaimsV2Schema,
	RuntimeControlCommandV2Schema,
	RuntimeControlGrantClaimsV2Schema,
	RuntimeControlReasonV2Schema,
	RuntimeExecutionGrantClaimsV2Schema,
	RuntimeExecutionGrantV2Schema,
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
	VerifiedRuntimeExecutionGrantV2Schema,
} from "./grant-v2.ts";

export const RuntimeGrantV2SchemaDefinitions = {
	RuntimePrincipalV1: RuntimePrincipalV1Schema,
	RuntimeOperationBindingV2: RuntimeOperationBindingV2Schema,
	RuntimeExecutionGrantV2: RuntimeExecutionGrantV2Schema,
	RuntimeBusinessCommandV2: RuntimeBusinessCommandV2Schema,
	RuntimeControlCommandV2: RuntimeControlCommandV2Schema,
	RuntimeControlReasonV2: RuntimeControlReasonV2Schema,
	RuntimeBusinessGrantClaimsV2: RuntimeBusinessGrantClaimsV2Schema,
	RuntimeControlGrantClaimsV2: RuntimeControlGrantClaimsV2Schema,
	RuntimeExecutionGrantClaimsV2: RuntimeExecutionGrantClaimsV2Schema,
	VerifiedRuntimeExecutionGrantV2: VerifiedRuntimeExecutionGrantV2Schema,
};

import { RuntimeModelConfigurationV4Schema } from "./configuration-v4.ts";
import { RuntimeKeyedHandleScopeV4Schema } from "./driver-v4.ts";
import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeExecutionGrantV4Schema,
	RuntimeExecutionSourceV1Schema,
	RuntimeNativeCapabilityRequestV4Schema,
	RuntimeNativeCapabilityTransportV4Schema,
	RuntimeOperationResponseV4Schema,
	RuntimePrivateRelayKeyContextV1Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
	RuntimeRelayKeyBindingV1Schema,
	RuntimeRelayKeyDeliveryV1Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSubmitTurnTransportV4Schema,
	RuntimeSupplementRequestV4Schema,
	RuntimeSupplementTransportV4Schema,
	VerifiedRuntimeExecutionGrantV4Schema,
} from "./host-v4.ts";
import {
	RuntimeRestoreExecutionKeyGrantClaimsV4Schema,
	RuntimeRestoreExecutionKeyRequestV4Schema,
	RuntimeRestoreExecutionKeyResponseV4Schema,
	RuntimeRestoreExecutionKeyTransportV4Schema,
} from "./host-v4-key-recovery.ts";
import {
	RuntimeExecutionGrantV5Schema,
	RuntimeNativeCapabilityRequestV5Schema,
	RuntimeNativeCapabilityTransportV5Schema,
	RuntimeOperationResponseV5Schema,
	RuntimeReadOnlyTextAttachmentV5Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV5Schema,
	RuntimeRestoreExecutionKeyRequestV5Schema,
	RuntimeRestoreExecutionKeyResponseV5Schema,
	RuntimeRestoreExecutionKeyTransportV5Schema,
} from "./host-v5.ts";

export const RuntimeHostV4SchemaDefinitions = {
	RuntimeBusinessGrantClaimsV4: RuntimeBusinessGrantClaimsV4Schema,
	RuntimeExecutionGrantV4: RuntimeExecutionGrantV4Schema,
	VerifiedRuntimeExecutionGrantV4: VerifiedRuntimeExecutionGrantV4Schema,
	RuntimeKeyedHandleScopeV4: RuntimeKeyedHandleScopeV4Schema,
	RuntimeExecutionSourceV1: RuntimeExecutionSourceV1Schema,
	RuntimeRelayKeyBindingV1: RuntimeRelayKeyBindingV1Schema,
	RuntimeRelayKeyDeliveryV1: RuntimeRelayKeyDeliveryV1Schema,
	RuntimePrivateRelayKeyContextV1: RuntimePrivateRelayKeyContextV1Schema,
	RuntimePrivateRelayKeyFieldV1: RuntimePrivateRelayKeyFieldV1Schema,
	RuntimeOperationResponseV4: RuntimeOperationResponseV4Schema,
	RuntimeSubmitTurnRequestV4: RuntimeSubmitTurnRequestV4Schema,
	RuntimeSubmitTurnTransportV4: RuntimeSubmitTurnTransportV4Schema,
	RuntimeSupplementRequestV4: RuntimeSupplementRequestV4Schema,
	RuntimeSupplementTransportV4: RuntimeSupplementTransportV4Schema,
	RuntimeNativeCapabilityRequestV4: RuntimeNativeCapabilityRequestV4Schema,
	RuntimeNativeCapabilityTransportV4: RuntimeNativeCapabilityTransportV4Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV4:
		RuntimeRestoreExecutionKeyGrantClaimsV4Schema,
	RuntimeRestoreExecutionKeyRequestV4:
		RuntimeRestoreExecutionKeyRequestV4Schema,
	RuntimeRestoreExecutionKeyTransportV4:
		RuntimeRestoreExecutionKeyTransportV4Schema,
	RuntimeRestoreExecutionKeyResponseV4:
		RuntimeRestoreExecutionKeyResponseV4Schema,
};

export const RuntimeHostV5SchemaDefinitions = {
	// V5 reuses the V4 business Grant, claims and private Key transport.
	RuntimeBusinessGrantClaimsV4: RuntimeBusinessGrantClaimsV4Schema,
	RuntimeExecutionGrantV4: RuntimeExecutionGrantV4Schema,
	VerifiedRuntimeExecutionGrantV4: VerifiedRuntimeExecutionGrantV4Schema,
	RuntimeExecutionSourceV1: RuntimeExecutionSourceV1Schema,
	RuntimeRelayKeyBindingV1: RuntimeRelayKeyBindingV1Schema,
	RuntimeRelayKeyDeliveryV1: RuntimeRelayKeyDeliveryV1Schema,
	RuntimePrivateRelayKeyContextV1: RuntimePrivateRelayKeyContextV1Schema,
	RuntimePrivateRelayKeyFieldV1: RuntimePrivateRelayKeyFieldV1Schema,
	// V5 adds only the ordered read-only text attachment contract.
	RuntimeExecutionGrantV5: RuntimeExecutionGrantV5Schema,
	RuntimeReadOnlyTextAttachmentV5: RuntimeReadOnlyTextAttachmentV5Schema,
	RuntimeNativeCapabilityRequestV5: RuntimeNativeCapabilityRequestV5Schema,
	RuntimeNativeCapabilityTransportV5: RuntimeNativeCapabilityTransportV5Schema,
	RuntimeOperationResponseV5: RuntimeOperationResponseV5Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV5:
		RuntimeRestoreExecutionKeyGrantClaimsV5Schema,
	RuntimeRestoreExecutionKeyRequestV5:
		RuntimeRestoreExecutionKeyRequestV5Schema,
	RuntimeRestoreExecutionKeyTransportV5:
		RuntimeRestoreExecutionKeyTransportV5Schema,
	RuntimeRestoreExecutionKeyResponseV5:
		RuntimeRestoreExecutionKeyResponseV5Schema,
};

export const RuntimeModelConfigurationV4SchemaDefinitions = {
	RuntimeModelConfigurationV4: RuntimeModelConfigurationV4Schema,
};

import {
	RuntimeAuthorizationRenewRequestV3Schema,
	RuntimeAuthorizationRenewResponseV3Schema,
	RuntimeEventAckRequestV3Schema,
	RuntimeEventAckResponseV3Schema,
	RuntimeEventPersistRequestV3Schema,
	RuntimeGenerationCancelRequestV3Schema,
	RuntimeOperationResponseV3Schema,
	RuntimeOriginalBindingResponseV3Schema,
	RuntimeStatusRequestV3Schema,
	RuntimeStatusResponseV3Schema,
	RuntimeStopRequestV3Schema,
	RuntimeSubmitTurnRequestV3Schema,
	RuntimeSupplementRequestV3Schema,
} from "./host-v3.ts";
import { RuntimeNativeCapabilityRequestV3Schema } from "./native-capability.ts";

export const RuntimeHostV3SchemaDefinitions = {
	RuntimeBrowserHandoffRequestV3: RuntimeBrowserHandoffRequestV3Schema,
	RuntimeBrowserHandoffResponseV3: RuntimeBrowserHandoffResponseV3Schema,
	RuntimeBrowserSideEffectConfirmationRequestV3:
		RuntimeBrowserSideEffectConfirmationRequestV3Schema,
	RuntimeBrowserSideEffectConfirmationResponseV3:
		RuntimeBrowserSideEffectConfirmationResponseV3Schema,
	RuntimeSubmitTurnRequestV3: RuntimeSubmitTurnRequestV3Schema,
	RuntimeNativeCapabilityRequestV3: RuntimeNativeCapabilityRequestV3Schema,
	RuntimeSupplementRequestV3: RuntimeSupplementRequestV3Schema,
	RuntimeStopRequestV3: RuntimeStopRequestV3Schema,
	RuntimeStatusRequestV3: RuntimeStatusRequestV3Schema,
	RuntimeGenerationCancelRequestV3: RuntimeGenerationCancelRequestV3Schema,
	RuntimeAuthorizationRenewRequestV3: RuntimeAuthorizationRenewRequestV3Schema,
	RuntimeEventPersistRequestV3: RuntimeEventPersistRequestV3Schema,
	RuntimeEventAckRequestV3: RuntimeEventAckRequestV3Schema,
	RuntimeOperationResponseV3: RuntimeOperationResponseV3Schema,
	RuntimeStatusResponseV3: RuntimeStatusResponseV3Schema,
	RuntimeOriginalBindingResponseV3: RuntimeOriginalBindingResponseV3Schema,
	RuntimeAuthorizationRenewResponseV3:
		RuntimeAuthorizationRenewResponseV3Schema,
	RuntimeEventAckResponseV3: RuntimeEventAckResponseV3Schema,
};

export * from "./installation.ts";
export * from "./oauth.ts";

export { canonicalRuntimeRequestSigningPayload } from "./request-signing.ts";
