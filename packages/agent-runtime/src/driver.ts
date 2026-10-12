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
import type {
	BrowserHandoffControllerV1,
	BrowserHandoffReasonV1,
	BrowserHandoffRecordV1,
	BrowserHandoffRuntimeSnapshotV1,
} from "./browser-handoff.js";
import type {
	RuntimeFileBridgePortV1,
	RuntimeFileResultReceiptV1,
} from "./runtime-file-bridge.js";

/** Verified Browser binding supplied only for one Runtime execution. */
export interface RuntimeBrowserExecutionContextV1 {
	readonly capabilityVersion: number;
	readonly binding: {
		readonly agentId: string;
		readonly conversationId: string;
		readonly sessionGeneration: number;
		readonly resourceFence: number;
		readonly workloadRevision: number;
		readonly imageDigest: string;
	};
	readonly executeTool?: (
		request: RuntimeBrowserToolExecutionRequestV1,
		signal: AbortSignal,
	) => Promise<RuntimeBrowserToolExecutionResultV1>;
	readonly handoff?: RuntimeBrowserHandoffContextV1;
}

export interface RuntimeBrowserToolExecutionRequestV1 {
	readonly tool: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly actionId: string;
	readonly operationRef: string;
	readonly attemptRef: string;
	readonly binding: Pick<
		RuntimeBrowserExecutionContextV1["binding"],
		"agentId" | "conversationId" | "sessionGeneration" | "resourceFence"
	> & {
		readonly executionId: string;
		readonly capabilityVersion: number;
		readonly pageRevision: number;
	};
}

export interface RuntimeBrowserToolExecutionResultV1 {
	/** Response identity must echo the admitted request before it can resolve. */
	readonly actionId: string;
	readonly operationRef: string;
	readonly attemptRef: string;
	readonly binding: RuntimeBrowserToolExecutionRequestV1["binding"];
	readonly phase: "completed" | "failed" | "unknown";
	readonly contentItems: readonly {
		readonly type: "inputText";
		readonly text: string;
	}[];
	readonly success: boolean;
	readonly failureCode?: string;
}

export interface RuntimeBrowserHandoffContextV1 {
	readonly controller: BrowserHandoffControllerV1;
}

export type RuntimeBrowserHandoffRequestV1 =
	| {
			readonly kind: "request";
			readonly reason: BrowserHandoffReasonV1;
			readonly runtime: BrowserHandoffRuntimeSnapshotV1;
	  }
	| {
			readonly kind: "take-over";
			readonly handoffId: string;
			readonly operatorId: string;
			readonly subjectId: string;
			readonly runtime: BrowserHandoffRuntimeSnapshotV1;
	  }
	| {
			readonly kind: "return-to-agent";
			readonly handoffId: string;
			readonly operatorId: string;
			readonly runtime: BrowserHandoffRuntimeSnapshotV1;
	  }
	| {
			readonly kind: "revoke";
			readonly runtime: BrowserHandoffRuntimeSnapshotV1;
			readonly reason?:
				| "BROWSER_HANDOFF_REVOKED"
				| "BROWSER_HANDOFF_AUTHORIZATION_REVOKED"
				| "BROWSER_HANDOFF_OPERATOR_CHANGED";
	  }
	| {
			readonly kind: "browser-crashed";
			readonly runtime: BrowserHandoffRuntimeSnapshotV1;
	  };

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

/** Request-local execution dependencies; never part of a durable command. */
export interface RuntimeDriverExecutionContextV1 {
	readonly fileBridge?: RuntimeFileBridgePortV1;
	/** Deployment-owned Browser context; absent means Browser execution is unavailable. */
	readonly browser?: RuntimeBrowserExecutionContextV1;
}
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

export type RuntimeModelCredentialResolver = () => Promise<string>;

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
	executeBrowserHandoff?(
		nativeSessionRef: string,
		executionId: string,
		request: RuntimeBrowserHandoffRequestV1,
		context: RuntimeDriverExecutionContextV1,
	): Promise<BrowserHandoffRecordV1 | undefined>;
	executeBrowserTool?(
		nativeSessionRef: string,
		executionId: string,
		request: {
			readonly tool: string;
			readonly arguments: Readonly<Record<string, unknown>>;
			readonly pageRevision: number;
			readonly actionId?: string;
		},
		context: RuntimeDriverExecutionContextV1,
		signal?: AbortSignal,
	): Promise<RuntimeBrowserToolExecutionResultV1>;
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
	execute(
		command: RuntimeDriverCommand,
		context?: RuntimeDriverExecutionContextV1,
	): Promise<RuntimeDriverOperationRecord>;
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
	/** Persist metadata only after a request-local bridge has confirmed a result file. */
	recordResultFile?(
		command: RuntimeDriverCommand,
		result: RuntimeFileResultReceiptV1,
	): Promise<void>;
	subscribeEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
		signal?: AbortSignal,
	): Promise<AsyncIterable<RuntimeEvent>>;
}
