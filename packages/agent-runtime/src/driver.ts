import type {
	RuntimeCapabilitiesV1,
	RuntimeDriverCommandV1,
	RuntimeDriverLookupV1,
	RuntimeDriverOperationRecordV1,
	RuntimeEventV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";

export type RuntimeDriverLookup = RuntimeDriverLookupV1;

export interface RuntimeDriver {
	execute(
		command: RuntimeDriverCommandV1,
	): Promise<RuntimeDriverOperationRecordV1>;
	lookupOperation(operationId: string): Promise<RuntimeDriverLookupV1>;
	getStatus(
		nativeSessionRef: string,
		executionId: string,
	): Promise<RuntimeStatusV1>;
	getCapabilities(): Promise<RuntimeCapabilitiesV1>;
	replayEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
	): Promise<RuntimeEventV1[]>;
	subscribeEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
		signal?: AbortSignal,
	): Promise<AsyncIterable<RuntimeEventV1>>;
}
