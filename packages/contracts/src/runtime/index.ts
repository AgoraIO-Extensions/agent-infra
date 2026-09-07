export * from "./driver.ts";
export * from "./events.ts";
export * from "./grant.ts";
export * from "./host.ts";

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
