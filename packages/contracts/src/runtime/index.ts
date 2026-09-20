export * from "./configuration.ts";
export * from "./driver.ts";
export * from "./events.ts";
export * from "./events-v2.ts";
export * from "./grant.ts";
export * from "./grant-v2.ts";
export * from "./host.ts";
export * from "./host-v3.ts";
export * from "./legacy-migration-v1.ts";
export * from "./readiness.ts";

import {
	RuntimeDriverCommandV1Schema,
	RuntimeDriverLookupV1Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnLookupV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
} from "./driver.ts";
import {
	RuntimeCapabilitiesV1Schema,
	RuntimeEventV1Schema,
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
	RuntimeOperationResponseV1Schema,
	RuntimeOperationResponseV2Schema,
	RuntimeOperationResultV1Schema,
	RuntimeOperationResultV2Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeReplayResponseV1Schema,
	RuntimeSelectionV1Schema,
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

export const RuntimeEventV1SchemaDefinitions = {
	RuntimeCapabilitiesV1: RuntimeCapabilitiesV1Schema,
	RuntimeEventV1: RuntimeEventV1Schema,
	RuntimeStatusV1: RuntimeStatusV1Schema,
};

export const RuntimeDriverV1SchemaDefinitions = {
	RuntimeDriverCommandV1: RuntimeDriverCommandV1Schema,
	RuntimeDriverLookupV1: RuntimeDriverLookupV1Schema,
	RuntimeDriverOperationRecordV1: RuntimeDriverOperationRecordV1Schema,
};

export const RuntimeHostV2SchemaDefinitions = {
	RuntimeOperationResponseV2: RuntimeOperationResponseV2Schema,
	RuntimeOperationResultV2: RuntimeOperationResultV2Schema,
	RuntimeSelectionV1: RuntimeSelectionV1Schema,
	RuntimeSubmitTurnRequestV2: RuntimeSubmitTurnRequestV2Schema,
	RuntimeStatusRequestV2: RuntimeStatusRequestV2Schema,
	RuntimeStatusResponseV2: RuntimeStatusResponseV2Schema,
};

export const RuntimeDriverV2SchemaDefinitions = {
	RuntimeDriverSubmitTurnCommandV2: RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnLookupV2: RuntimeDriverSubmitTurnLookupV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2:
		RuntimeDriverSubmitTurnOperationRecordV2Schema,
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

import {
	RuntimeAuthorizationRenewRequestV3Schema,
	RuntimeAuthorizationRenewResponseV3Schema,
	RuntimeEventAckRequestV3Schema,
	RuntimeEventAckResponseV3Schema,
	RuntimeEventPersistRequestV3Schema,
	RuntimeGenerationCancelRequestV3Schema,
	RuntimeOperationResponseV3Schema,
	RuntimeStatusRequestV3Schema,
	RuntimeStatusResponseV3Schema,
	RuntimeStopRequestV3Schema,
	RuntimeSubmitTurnRequestV3Schema,
	RuntimeSupplementRequestV3Schema,
} from "./host-v3.ts";

export const RuntimeHostV3SchemaDefinitions = {
	RuntimeSubmitTurnRequestV3: RuntimeSubmitTurnRequestV3Schema,
	RuntimeSupplementRequestV3: RuntimeSupplementRequestV3Schema,
	RuntimeStopRequestV3: RuntimeStopRequestV3Schema,
	RuntimeStatusRequestV3: RuntimeStatusRequestV3Schema,
	RuntimeGenerationCancelRequestV3: RuntimeGenerationCancelRequestV3Schema,
	RuntimeAuthorizationRenewRequestV3: RuntimeAuthorizationRenewRequestV3Schema,
	RuntimeEventPersistRequestV3: RuntimeEventPersistRequestV3Schema,
	RuntimeEventAckRequestV3: RuntimeEventAckRequestV3Schema,
	RuntimeOperationResponseV3: RuntimeOperationResponseV3Schema,
	RuntimeStatusResponseV3: RuntimeStatusResponseV3Schema,
	RuntimeAuthorizationRenewResponseV3:
		RuntimeAuthorizationRenewResponseV3Schema,
	RuntimeEventAckResponseV3: RuntimeEventAckResponseV3Schema,
};
