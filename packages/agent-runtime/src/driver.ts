import type {
	RuntimeCapabilitiesV1,
	RuntimeDriverCommandV1,
	RuntimeDriverOperationRecordV1,
	RuntimeDriverSubmitTurnCommandV2,
	RuntimeDriverSubmitTurnOperationRecordV2,
	RuntimeEvent,
	RuntimePrincipalV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";

export interface RuntimeModelDirectoryOption {
	readonly modelOptionId: string;
	readonly modelId: string;
	readonly displayName: string;
	readonly reasoningLevels: readonly string[];
}

export interface RuntimeModelDirectory {
	readonly options: readonly RuntimeModelDirectoryOption[];
	readonly current: {
		readonly modelOptionId: string;
		readonly reasoningLevel: string;
	};
}

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
	/** Source reservation/binding may arrive after its parent operation has a terminal outcome. */
	readonly purpose?: "source-reserve" | "source-bind";
}

/** Host authority and credential are request-local; never part of durable commands. */
export interface RuntimeExternalActionAuthorizationResult {
	readonly relayKey?: string;
	readonly revalidate?: () => void;
}

export type RuntimeExternalActionAuthorizer = (
	action: RuntimeExternalActionAuthorization,
) =>
	| Promise<void>
	| Promise<RuntimeExternalActionAuthorizationResult | undefined>;

export interface RuntimeOriginalEvidenceBinding {
	readonly principal: RuntimePrincipalV1;
	readonly scope: {
		readonly agentId: string;
		readonly conversationId: string;
		readonly executionId: string;
		readonly sessionGeneration: number;
	};
}

export interface RuntimeOriginalEvidenceRecoveryRef {
	readonly nativeSessionRef: string;
	readonly executionId: string;
	readonly recoveryRequestId: string;
}

/** Host-owned authority for one bounded query; never serialized or a business permit. */
export interface RuntimeOriginalEvidenceReadContext {
	readonly signal: AbortSignal;
	readonly expiresAt: number;
	assertCurrent(): RuntimeOriginalEvidenceBinding;
	/** Acquire Host ordering before the Driver's durable-file queue. */
	commit<T>(write: () => Promise<T>): Promise<T>;
}

export interface RuntimeDriver {
	/** Validate the action refs against the Driver's durable operation journal. */
	validateExternalAction?(
		action: RuntimeExternalActionAuthorization,
	): Promise<void>;
	recoverOriginalEvidence?(
		reference: RuntimeOriginalEvidenceRecoveryRef,
		read: RuntimeOriginalEvidenceReadContext,
	): Promise<void>;
	/** Bounded native protocol handshake only; no business Session/Turn or model call. */
	probeReadiness?(signal: AbortSignal): Promise<RuntimeCapabilitiesV1>;
	execute(command: RuntimeDriverCommand): Promise<RuntimeDriverOperationRecord>;
	lookupOperation(command: RuntimeDriverCommand): Promise<RuntimeDriverLookup>;
	getStatus(
		nativeSessionRef: string,
		executionId: string,
	): Promise<RuntimeStatusV1>;
	getCapabilities(): Promise<RuntimeCapabilitiesV1>;
	/** Read-only model choices for an existing native Session; never opens or mutates one. */
	getModelDirectory(nativeSessionRef: string): Promise<RuntimeModelDirectory>;
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
