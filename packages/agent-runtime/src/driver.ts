import type {
	RuntimeCapabilitiesV1,
	RuntimeDriverCommandV1,
	RuntimeDriverOperationRecordV1,
	RuntimeDriverSubmitTurnCommandV2,
	RuntimeDriverSubmitTurnOperationRecordV2,
	RuntimeEvent,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";

export type RuntimeDriverCommand =
	| RuntimeDriverCommandV1
	| RuntimeDriverSubmitTurnCommandV2;
export type RuntimeDriverOperationRecord =
	| RuntimeDriverOperationRecordV1
	| RuntimeDriverSubmitTurnOperationRecordV2;
export type RuntimeDriverLookup =
	| { state: "found"; record: RuntimeDriverOperationRecord }
	| { state: "missing" }
	| { state: "unknown" };

export interface RuntimeExternalActionAuthorization {
	readonly nativeSessionRef: string;
	readonly executionId: string;
	/** The original Driver submit command, distinct from the actual action UUID. */
	readonly runtimeOperationId: string;
	readonly operationRef: string;
	readonly attemptRef: string;
	readonly kind: "model" | "tool";
}

export interface RuntimeDriver {
	/** Bounded native protocol handshake only; no business Session/Turn or model call. */
	probeReadiness?(signal: AbortSignal): Promise<RuntimeCapabilitiesV1>;
	execute(command: RuntimeDriverCommand): Promise<RuntimeDriverOperationRecord>;
	lookupOperation(command: RuntimeDriverCommand): Promise<RuntimeDriverLookup>;
	getStatus(
		nativeSessionRef: string,
		executionId: string,
	): Promise<RuntimeStatusV1>;
	getCapabilities(): Promise<RuntimeCapabilitiesV1>;
	replayEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
	): Promise<RuntimeEvent[]>;
	/** Confirm only events committed by the platform transaction; retain until then. */
	acknowledgeEvents?(
		nativeSessionRef: string,
		executionId: string,
		throughCursor: string,
	): Promise<void>;
	subscribeEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
		signal?: AbortSignal,
	): Promise<AsyncIterable<RuntimeEvent>>;
}
