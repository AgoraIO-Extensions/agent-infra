import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
	BrowserCapabilityBindingV1,
	BrowserCapabilityDeclarationV1,
	NativeMetadataObjectScopeV1,
	RuntimeAuthorizationRenewRequestV3,
	RuntimeBrowserCapabilityProbeEvidenceV1,
	RuntimeBrowserHandoffRequestV3,
	RuntimeBusinessGrantClaimsV4,
	RuntimeBusinessRequestV4,
	RuntimeCapabilitiesRequestV1,
	RuntimeCapabilitiesResponseV1,
	RuntimeCapabilitiesV1,
	RuntimeEventAckRequestV3,
	RuntimeEventAckRequestV4,
	RuntimeEventPersistRequestV3,
	RuntimeEventReadRequestV4,
	RuntimeEventV1,
	RuntimeGenerationCancelRequestV1,
	RuntimeGenerationCancelRequestV3,
	RuntimeModelDirectoryRequestV1,
	RuntimeModelDirectoryResponseV1,
	RuntimeNativeCapabilityRequestV3,
	RuntimeNativeCapabilityRequestV5,
	RuntimeNativeCapabilityTransportV5,
	RuntimeNativeMetadataReadRequestV1,
	RuntimeNativeMetadataReadResponseV1,
	RuntimeOperationResponseV1,
	RuntimeOperationResponseV2,
	RuntimePinnedExecutionKeyScopeV4,
	RuntimePrincipalV1,
	RuntimeReplayRequestV1,
	RuntimeReplayResponseV1,
	RuntimeRestoreExecutionKeyGrantClaimsV5,
	RuntimeRestoreExecutionKeyRequestV5,
	RuntimeRestoreExecutionKeyTransportV4,
	RuntimeRestoreExecutionKeyTransportV5,
	RuntimeSkillDirectoryRequestV1,
	RuntimeSkillDirectoryResponseV1,
	RuntimeSkillResourceReadRequestV1,
	RuntimeSkillResourceReadResponseV1,
	RuntimeStatusRequestV1,
	RuntimeStatusRequestV2,
	RuntimeStatusRequestV3,
	RuntimeStatusResponseV1,
	RuntimeStatusResponseV2,
	RuntimeStatusV1,
	RuntimeStopRequestV1,
	RuntimeStopRequestV3,
	RuntimeSubmitTurnRequestV1,
	RuntimeSubmitTurnRequestV2,
	RuntimeSubmitTurnRequestV3,
	RuntimeSubmitTurnTransportV4,
	RuntimeSupplementRequestV1,
	RuntimeSupplementRequestV3,
	RuntimeSupplementTransportV4,
	WorkloadReadinessRequestV1,
	WorkloadReadinessResponseV1,
} from "@agent-infra/contracts/runtime";
import {
	maximumRuntimeEventReplayPageBytesV4,
	NativeMetadataProjectionV1Schema,
	RuntimeCapabilitiesRequestV1Schema,
	RuntimeCapabilitiesV1Schema,
	RuntimeDriverLookupV1Schema,
	RuntimeDriverLookupV2Schema,
	RuntimeDriverNativeCommandOperationRecordV2Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
	RuntimeEventAckRequestV4Schema,
	RuntimeEventAckResponseV4Schema,
	RuntimeEventReadRequestV4Schema,
	RuntimeEventReplayResponseV4Schema,
	RuntimeEventSchema,
	RuntimeGenerationCancelRequestV1Schema,
	RuntimeModelDirectoryRequestV1Schema,
	RuntimeModelDirectoryResponseV1Schema,
	RuntimeNativeCapabilityTransportV5Schema,
	RuntimeNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataReadResponseV1Schema,
	RuntimeOperationResponseV5Schema,
	RuntimePinnedExecutionKeyScopeV4Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeRestoreExecutionKeyResponseV5Schema,
	RuntimeRestoreExecutionKeyTransportV5Schema,
	RuntimeSkillDirectoryRequestV1Schema,
	RuntimeSkillDirectoryResponseV1Schema,
	RuntimeSkillResourceReadRequestV1Schema,
	RuntimeSkillResourceReadResponseV1Schema,
	RuntimeStatusRequestV1Schema,
	RuntimeStatusRequestV2Schema,
	RuntimeStatusV1Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSubmitTurnRequestV2Schema,
	RuntimeSupplementRequestV1Schema,
	runtimeOperationDigestInputV5,
	VerifiedRuntimeExecutionGrantV2Schema,
	validateRuntimeBusinessBindingV5,
	validateRuntimeEventAccessV4,
	validateRuntimePrivateRelayKeyFieldV5,
	validateRuntimeRestoreExecutionKeyBindingV5,
	validateRuntimeRestoreExecutionKeyPrivateFieldV5,
	WorkloadReadinessRequestV1Schema,
	WorkloadReadinessResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import type { RuntimeBrowserCapabilityAssemblyFailureV1 } from "./browser-capability.js";
import type {
	RuntimeBrowserExecutionContextV1,
	RuntimeDriver,
	RuntimeDriverCommand,
	RuntimeDriverExecutionContextV1,
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
	RuntimeNativeMetadataReadContextV1,
	RuntimeNativeSkillReadContextV1,
	RuntimeNativeSkillReaderV1,
	RuntimeOperationFactInputV1,
	RuntimeOriginalEvidenceBinding,
} from "./driver.js";
import {
	type NativeSessionUnavailableDiagnostic,
	RuntimeHostError,
} from "./errors.js";
import {
	type FileRuntimeStore,
	requestDigest,
	type StoredOperation,
	type StoredSession,
} from "./file-runtime-store.js";
import {
	type ExecutionGrantValidationOptions,
	validateRuntimeExecutionGrant,
} from "./grant.js";
import type { RuntimeGrantValidationOptionsV2 } from "./grant-v2.js";
import type { createWorkloadReadinessVerifierV1 } from "./readiness.js";
import {
	type RuntimeOriginalExecutionRef,
	runtimeAccessDenialCause,
	runtimeAuthorizationDenied,
} from "./runtime-authorization.js";
import {
	createRuntimeFileBridgeBindingV1,
	createRuntimeNativeTextInputBindingV5,
	createRuntimeNativeTextInputPortV1,
	type RuntimeFileBridgeFactoryV1,
	type RuntimeFileBridgePortV1,
	type RuntimeFileBridgeWithNativeTextInputV1,
	RuntimeFileResultUnconfirmedError,
	type RuntimeNativeTextInputExecutionContextV1,
	type RuntimeNativeTextInputPortV1,
} from "./runtime-file-bridge.js";
import { RuntimeHostV3 } from "./runtime-host-v3.js";
import { RuntimeHostV4 } from "./runtime-host-v4.js";

export interface RuntimeHostOptions {
	grantValidationV2?: RuntimeGrantValidationOptionsV2;
	allowLegacyBusiness?: boolean;
	validateGrantV4?: (request: unknown) => Promise<{
		request: RuntimeBusinessRequestV4;
		claims: import("@agent-infra/contracts/runtime").RuntimeBusinessGrantClaimsV4;
	}>;
	validateRecoveryGrantV4?: (request: unknown) => Promise<{
		request: RuntimeRestoreExecutionKeyTransportV4["recoveryRequest"];
		claims: import("@agent-infra/contracts/runtime").RuntimeRestoreExecutionKeyGrantClaimsV4;
	}>;
	/**
	 * Deployment-owned JWS verification for the Native V5 Skill request. It must
	 * return the parsed request and the verified V4 business Grant claims; the
	 * Host revalidates the full V5 binding and private Key field itself.
	 */
	validateGrantV5?: (request: unknown) => Promise<{
		readonly request: RuntimeNativeCapabilityRequestV5;
		readonly claims: RuntimeBusinessGrantClaimsV4;
	}>;
	/** Deployment-owned JWS verification for the V5 existing-accepted recovery. */
	validateRecoveryGrantV5?: (request: unknown) => Promise<{
		readonly request: RuntimeRestoreExecutionKeyRequestV5;
		readonly claims: RuntimeRestoreExecutionKeyGrantClaimsV5;
	}>;
	readinessVerifier?: ReturnType<typeof createWorkloadReadinessVerifierV1>;
	/** Deployment-owned local Browser readiness probe; caller-supplied inputs are already signed. */
	probeBrowserCapability?: (input: {
		readonly declaration: BrowserCapabilityDeclarationV1;
		readonly binding: BrowserCapabilityBindingV1;
		readonly signal: AbortSignal;
	}) => Promise<RuntimeBrowserCapabilityProbeEvidenceV1 | undefined>;
	/** Request-local Browser context plus the admitted Execution identity. */
	createBrowserExecutionContext?: (
		input: RuntimeBrowserExecutionContextFactoryInputV1,
	) =>
		| RuntimeBrowserExecutionContextV1
		| undefined
		| Promise<RuntimeBrowserExecutionContextV1 | undefined>;
	/** Deployment-owned Browser controller factory; receives only verified readiness binding. */
	onBrowserCapabilityAssembly?: (
		input:
			| {
					readonly declaration: BrowserCapabilityDeclarationV1;
					readonly binding: BrowserCapabilityBindingV1;
					readonly manifestDigest: string;
					readonly probe: RuntimeBrowserCapabilityProbeEvidenceV1;
			  }
			| RuntimeBrowserCapabilityAssemblyFailureV1
			| undefined,
	) => void;
	store: FileRuntimeStore;
	driver: RuntimeDriver;
	/** Factory for a bridge bound to the validated request supplied to getFileBridge. */
	fileBridge?: RuntimeFileBridgeFactoryV1;
	grantValidation: ExecutionGrantValidationOptions;
	afterOperationPrepared?: (operationId: string) => void | Promise<void>;
	afterDriverResult?: (operationId: string) => void | Promise<void>;
	afterOperationResolved?: (operationId: string) => void | Promise<void>;
}

/**
 * Host-supplied current/proof authority for one native metadata read.
 * The context is request-local and must never be serialized or reused.
 */
export interface RuntimeHostNativeMetadataReadContextV1
	extends RuntimeNativeMetadataReadContextV1 {
	readonly scope: NativeMetadataObjectScopeV1;
	readonly originalHostScopeRef: string;
	readonly verifyProof: (
		request: RuntimeNativeMetadataReadRequestV1,
	) => void | Promise<void>;
	readonly now?: () => number;
}

export type RuntimeBrowserExecutionContextFactoryInputV1 =
	RuntimeBrowserExecutionContextV1 & {
		/** Exact admitted Runtime Execution; never selected by caller input. */
		readonly executionId: string;
		/** Initial page revision for the newly assembled request-local context. */
		readonly pageRevision: number;
	};

function invalidRequest(): never {
	throw new RuntimeHostError(
		"RUNTIME_REQUEST_INVALID",
		"Runtime request is invalid",
		400,
	);
}

function nativeSessionRequired(
	diagnostic: NativeSessionUnavailableDiagnostic,
): never {
	throw new RuntimeHostError(
		"RUNTIME_SESSION_UNAVAILABLE",
		"Runtime session could not be recovered",
		503,
		false,
		undefined,
		diagnostic,
	);
}

/**
 * 从 StoredSession 推断原生会话不可用时的状态类别（#3017）。
 * 不含 ID、路径或会话内容，只反映操作和恢复的粗粒度状态。
 */
function nativeSessionStateCategory(
	session: StoredSession,
): NativeSessionUnavailableDiagnostic extends `${infer _}:${infer S}`
	? S
	: never {
	if (session.recovery?.status === "blocked") return "recovery_blocked";
	const ops = Object.values(session.operations);
	if (ops.length === 0) return "no_operations";
	if (ops.some((op) => op.state === "prepared")) return "prepared_no_native";
	if (
		ops.some(
			(op) => op.state === "resolved" && op.result?.outcome === "unknown",
		)
	)
		return "unknown_no_native";
	return "unbound";
}

function nativeTextInputUnsupported(): never {
	throw new RuntimeHostError(
		"RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
		"Native Skill text input execution is unavailable for this runtime",
		409,
	);
}

function isTerminalRuntimeStatus(status: RuntimeStatusV1) {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

/** A replay page always keeps the first eight events, as before #1637. */
const minimumReplayPageEvents = 8;
const maximumReplayPageEvents = 64;

/**
 * One replay page: the first eight events, then more only while the page stays
 * within the event bytes the Worker accepts. A busy Host answers each read
 * slowly, so a page that carries the waiting backlog keeps the drain ahead of
 * a streaming reply (#1637).
 */
function replayPage<T>(events: readonly T[]) {
	const page: T[] = [];
	let bytes = 0;
	for (const event of events) {
		if (page.length === maximumReplayPageEvents) break;
		bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
		if (
			page.length >= minimumReplayPageEvents &&
			bytes > maximumRuntimeEventReplayPageBytesV4
		)
			break;
		page.push(event);
	}
	return page;
}

function driverInvalid(): never {
	throw new RuntimeHostError(
		"RUNTIME_DRIVER_INVALID",
		"Runtime Driver response is invalid",
		503,
		true,
	);
}

function acceptanceUnknown() {
	return {
		outcome: "unknown" as const,
		code: "RUNTIME_ACCEPTANCE_UNKNOWN",
		message: "Runtime command acceptance could not be confirmed",
	} as const;
}

function isInterruption(operation: Pick<StoredOperation, "kind">) {
	return operation.kind === "stop" || operation.kind === "generation-cancel";
}

/**
 * Bind Browser execution context only to the exact admitted Session command.
 * A Runtime Host may serve historical or foreign requests while its current
 * readiness assembly is still live; those requests must execute without a
 * Browser context and fail closed in the Driver.
 */
export function runtimeBrowserExecutionContextForCommand(
	browser: RuntimeBrowserExecutionContextV1 | undefined,
	command: Pick<
		RuntimeDriverCommand,
		"agentId" | "conversationId" | "sessionGeneration"
	>,
): RuntimeBrowserExecutionContextV1 | undefined {
	if (
		browser?.binding.agentId !== command.agentId ||
		browser.binding.conversationId !== command.conversationId ||
		browser.binding.sessionGeneration !== command.sessionGeneration
	)
		return undefined;
	return browser;
}

async function createBrowserExecutionContextForCommand(
	factory: RuntimeHostOptions["createBrowserExecutionContext"],
	browser: RuntimeBrowserExecutionContextV1 | undefined,
	executionId: string,
	principal: RuntimeBrowserExecutionContextV1["principal"] = undefined,
): Promise<RuntimeBrowserExecutionContextV1 | undefined> {
	if (!browser) return undefined;
	const admittedVersion = browser.capabilityVersion;
	const admittedBinding = structuredClone(browser.binding);
	const admittedPrincipal = principal
		? Object.freeze(structuredClone(principal))
		: undefined;
	const admittedContext: RuntimeBrowserExecutionContextV1 = {
		...browser,
		binding: structuredClone(admittedBinding),
		...(admittedPrincipal ? { principal: admittedPrincipal } : {}),
	};
	// The Driver only receives a principal through the deployment factory, and
	// only the current operation scope may supply one. A readiness snapshot may
	// still carry a principal from an earlier authority, so an unadmitted or
	// factory-less context must never reach the factory or the Driver with one.
	if (!factory || !admittedPrincipal)
		delete (admittedContext as { principal?: RuntimePrincipalV1 }).principal;
	if (!factory) return admittedContext;
	const created = await factory({
		...admittedContext,
		binding: structuredClone(admittedBinding),
		executionId,
		pageRevision: 1,
	});
	if (
		!created ||
		created.capabilityVersion !== admittedVersion ||
		!isDeepStrictEqual(created.binding, admittedBinding) ||
		!isDeepStrictEqual(created.principal, admittedPrincipal)
	)
		return undefined;
	return Object.freeze({
		...created,
		capabilityVersion: admittedVersion,
		binding: Object.freeze(structuredClone(admittedBinding)),
		...(admittedPrincipal
			? { principal: Object.freeze(structuredClone(admittedPrincipal)) }
			: {}),
	});
}

type RuntimeOperationResponse =
	| RuntimeOperationResponseV1
	| RuntimeOperationResponseV2;

function operationResponse(
	hostSessionRef: string,
	operation: StoredOperation,
	result: RuntimeOperationResponse["result"],
): RuntimeOperationResponse {
	if (operation.command.schemaVersion === 2) {
		return {
			schemaVersion: 2,
			hostSessionRef,
			operationId: operation.operationId,
			result,
		};
	}
	if (
		result.outcome === "rejected" &&
		(result.code === "RUNTIME_MODEL_SELECTION_UNSUPPORTED" ||
			// submit V1 的结果枚举不扩展：会话阻塞拒绝对 V1 调用方保持失败关闭。
			result.code === "RUNTIME_SESSION_BLOCKED" ||
			result.code === "RUNTIME_FILE_INPUT_REJECTED")
	) {
		driverInvalid();
	}
	return {
		schemaVersion: 1,
		hostSessionRef,
		operationId: operation.operationId,
		result,
	};
}

function unknownOperationResponse(
	hostSessionRef: string,
	operation: StoredOperation,
) {
	return operationResponse(hostSessionRef, operation, acceptanceUnknown());
}

function v1OperationResponse(
	response: RuntimeOperationResponse,
): RuntimeOperationResponseV1 {
	if (response.schemaVersion !== 1) driverInvalid();
	return response;
}

function v2OperationResponse(
	response: RuntimeOperationResponse,
): RuntimeOperationResponseV2 {
	if (response.schemaVersion !== 2) driverInvalid();
	return response;
}

const driverUncertain = Symbol("driverUncertain");

function isUncertainDriverFailure(error: unknown) {
	return (
		error instanceof RuntimeHostError &&
		error.driverFailureKind === "unavailable"
	);
}

async function callDriver<T>(work: () => Promise<T>) {
	try {
		return await work();
	} catch (error) {
		throwSessionRecoveryFailure(error);
		driverInvalid();
	}
}

function nativeSkillReadDenied(): never {
	throw new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Runtime Skill read is no longer authorized",
		403,
	);
}

async function boundedNativeSkillRead<T>(input: {
	readonly read: RuntimeNativeSkillReadContextV1;
	readonly pending: Promise<T>;
}): Promise<T> {
	if (input.read.signal.aborted) {
		void input.pending.catch(() => undefined);
		nativeSkillReadDenied();
	}
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (complete: () => void) => {
				if (settled) return;
				settled = true;
				input.read.signal.removeEventListener("abort", onAbort as () => void);
				complete();
			};
			onAbort = () => {
				void input.pending.catch(() => undefined);
				finish(() =>
					reject(
						new RuntimeHostError(
							"RUNTIME_GRANT_INVALID",
							"Runtime Skill read is no longer authorized",
							403,
						),
					),
				);
			};
			input.read.signal.addEventListener("abort", onAbort, { once: true });
			void input.pending.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
		});
	} finally {
		if (onAbort) input.read.signal.removeEventListener("abort", onAbort);
	}
}

async function callBoundedNativeSkillDriver<T>(input: {
	readonly read: RuntimeNativeSkillReadContextV1;
	readonly work: () => Promise<T>;
}): Promise<T> {
	try {
		return await boundedNativeSkillRead({
			read: input.read,
			pending: input.work(),
		});
	} catch (error) {
		if (error instanceof RuntimeHostError && error.httpStatus === 403)
			throw error;
		throwSessionRecoveryFailure(error);
		driverInvalid();
	}
}

function nativeMetadataReadDenied(): never {
	runtimeAuthorizationDenied("native-metadata-read-invalid");
}

function nativeMetadataReadDeniedError() {
	return new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Runtime authorization is unavailable or does not authorize this operation",
		403,
	);
}

async function callBoundedNativeMetadataDriver<T>(input: {
	readonly read: RuntimeNativeMetadataReadContextV1;
	readonly work: () => Promise<T>;
}): Promise<T> {
	if (input.read.signal.aborted) nativeMetadataReadDenied();
	let onAbort: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(nativeMetadataReadDeniedError());
		input.read.signal.addEventListener("abort", onAbort, { once: true });
		if (input.read.signal.aborted) onAbort();
	});
	if (input.read.signal.aborted) nativeMetadataReadDenied();
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(nativeMetadataReadDeniedError()),
			Math.max(0, input.read.expiresAt - Date.now()),
		);
		timer.unref?.();
	});
	// The native request may outlive a cancelled caller; consume its rejection
	// while the bounded authorization promise returns the denial.
	const pending = Promise.resolve().then(input.work);
	void pending.catch(() => undefined);
	try {
		return await Promise.race([pending, aborted, deadline]);
	} finally {
		if (onAbort) input.read.signal.removeEventListener("abort", onAbort);
		if (timer !== undefined) clearTimeout(timer);
	}
}

function throwSessionRecoveryFailure(error: unknown) {
	if (
		error instanceof RuntimeHostError &&
		error.driverFailureKind === "session_recovery_failed"
	) {
		throw new RuntimeHostError(
			"RUNTIME_SESSION_RECOVERY_FAILED",
			"Runtime Session recovery failed",
			503,
			false,
			"session_recovery_failed",
		);
	}
}

async function callDriverWithUncertainty<T>(work: () => Promise<T>) {
	try {
		return await work();
	} catch (error) {
		throwSessionRecoveryFailure(error);
		if (isUncertainDriverFailure(error)) return driverUncertain;
		driverInvalid();
	}
}

const driverFileInputRejected = Symbol("driverFileInputRejected");

/**
 * #3314：`execute` 额外识别 Driver 声明的“附件读取在原生副作用前被平台明确拒绝”。
 * 只有 Driver 在物化点主动转换的错误才算；FileBridge 的原始错误从别处逃逸时仍不可判定。
 */
async function callDriverExecute<T>(work: () => Promise<T>) {
	try {
		return await work();
	} catch (error) {
		if (
			error instanceof RuntimeHostError &&
			error.driverFailureKind === "file_input_rejected"
		)
			return driverFileInputRejected;
		throwSessionRecoveryFailure(error);
		if (isUncertainDriverFailure(error)) return driverUncertain;
		driverInvalid();
	}
}

function fileInputRejected() {
	return {
		outcome: "rejected" as const,
		code: "RUNTIME_FILE_INPUT_REJECTED" as const,
		message: "Runtime file input was rejected" as const,
		retryable: false as const,
	};
}

async function* validatedDriverEventStream(
	events: AsyncIterable<unknown>,
	executionId: string,
) {
	let iterator: AsyncIterator<unknown>;
	try {
		iterator = events[Symbol.asyncIterator]();
	} catch {
		driverInvalid();
	}
	try {
		while (true) {
			let next: IteratorResult<unknown>;
			try {
				next = await iterator.next();
			} catch {
				driverInvalid();
			}
			if (next.done) return;
			const event = RuntimeEventSchema.safeParse(next.value);
			if (!event.success || event.data.executionId !== executionId) {
				driverInvalid();
			}
			yield event.data;
		}
	} finally {
		try {
			await iterator.return?.();
		} catch {
			driverInvalid();
		}
	}
}

function parseDriverRecord(
	value: unknown,
	operation: StoredOperation,
	persistedNativeSessionRef?: string,
) {
	const parsed = (
		operation.command.schemaVersion === 2
			? operation.command.kind === "native-command"
				? RuntimeDriverNativeCommandOperationRecordV2Schema
				: RuntimeDriverSubmitTurnOperationRecordV2Schema
			: RuntimeDriverOperationRecordV1Schema
	).safeParse(value);
	const expectedNativeSessionRef =
		persistedNativeSessionRef ??
		("nativeSessionRef" in operation.command
			? operation.command.nativeSessionRef
			: undefined);
	if (
		!parsed.success ||
		parsed.data.agentId !== operation.command.agentId ||
		parsed.data.conversationId !== operation.command.conversationId ||
		parsed.data.sessionGeneration !== operation.command.sessionGeneration ||
		parsed.data.kind !== operation.command.kind ||
		parsed.data.operationId !== operation.operationId ||
		(expectedNativeSessionRef !== undefined &&
			parsed.data.nativeSessionRef !== expectedNativeSessionRef)
	)
		driverInvalid();
	return parsed.data;
}

function parseDriverLookup(
	value: unknown,
	operation: StoredOperation,
	persistedNativeSessionRef?: string,
) {
	const parsed = (
		operation.command.schemaVersion === 2
			? RuntimeDriverLookupV2Schema
			: RuntimeDriverLookupV1Schema
	).safeParse(value);
	if (!parsed.success) driverInvalid();
	if (parsed.data.state === "found") {
		return {
			state: "found" as const,
			record: parseDriverRecord(
				parsed.data.record,
				operation,
				persistedNativeSessionRef,
			),
		};
	}
	return parsed.data;
}

export class RuntimeHost {
	private readonly queues = new Map<string, Promise<void>>();
	private readonly lifetime = new AbortController();
	private readonly readinessGuards = new Set<{
		controller: AbortController;
		done: Promise<void>;
	}>();
	private browserAssemblyEpoch = 0;
	private browserExecutionContext?: RuntimeBrowserExecutionContextV1;
	private closed = false;

	private readonly v3?: RuntimeHostV3;
	private readonly v4?: RuntimeHostV4;
	private readonly executionKeys = new Map<
		string,
		{
			readonly scope: RuntimePinnedExecutionKeyScopeV4;
			readonly hostSessionRef: string;
			readonly relayKey: string;
		}
	>();
	private constructor(private readonly options: RuntimeHostOptions) {
		if (options.grantValidationV2)
			this.v3 = new RuntimeHostV3({
				store: options.store,
				driver: options.driver,
				grantValidation: options.grantValidationV2,
				dispatch: (ref, operation, allowBusinessExecution) =>
					this.dispatch(ref, operation, allowBusinessExecution),
				serialize: (key, work) => this.serialize(key, work),
				executeBrowserHandoff: (request, claims, signal) =>
					this.executeBrowserHandoffV3(request, claims, signal),
				executeBrowserSideEffect: (request, claims, signal) =>
					this.executeBrowserSideEffectV3(request, claims, signal),
			});
		if (options.validateGrantV4)
			this.v4 = new RuntimeHostV4({
				store: options.store,
				driver: options.driver,
				assertOpen: () => {
					if (this.closed) runtimeAuthorizationDenied();
				},
				validateGrant: options.validateGrantV4,
				validateRecoveryGrant: async (request) => {
					if (!options.validateRecoveryGrantV4) runtimeAuthorizationDenied();
					return options.validateRecoveryGrantV4(request);
				},
				dispatch: (ref, operation, allowBusinessExecution, context) =>
					this.dispatch(ref, operation, allowBusinessExecution, context),
				...(options.fileBridge
					? {
							createFileBridge: (
								request: RuntimeBusinessRequestV4,
								claims: import("@agent-infra/contracts/runtime").RuntimeBusinessGrantClaimsV4,
							) => {
								if (!("input" in request)) runtimeAuthorizationDenied();
								return this.createFileBridgeFor(request, claims);
							},
						}
					: {}),
				serialize: (key, work) => this.serialize(key, work),
				installKey: (scope, hostSessionRef, relayKey) => {
					this.installExecutionKey(scope, hostSessionRef, relayKey);
				},
				now: options.grantValidationV2?.now,
			});
	}

	private installExecutionKey(
		scope: RuntimePinnedExecutionKeyScopeV4,
		hostSessionRef: string,
		relayKey: string,
	) {
		const original = this.options.store.readOriginalExecutionKeyScopeV4(scope);
		if (
			!original?.scope ||
			original.hostSessionRef !== hostSessionRef ||
			!isDeepStrictEqual(original.scope, scope)
		)
			runtimeAuthorizationDenied();
		if (
			original.operation.result &&
			!(
				original.operation.result.outcome === "accepted" &&
				original.operation.result.status === "running"
			)
		) {
			this.clearFinishedExecutionKey(
				original.operation,
				original.operation.result,
			);
			return;
		}
		const previous = this.executionKeys.get(scope.executionId);
		if (
			previous &&
			(!isDeepStrictEqual(previous.scope, scope) ||
				previous.hostSessionRef !== hostSessionRef ||
				previous.relayKey !== relayKey)
		)
			runtimeAuthorizationDenied();
		this.executionKeys.set(scope.executionId, {
			scope,
			hostSessionRef,
			relayKey,
		});
	}

	private trustedHost() {
		if (this.closed) runtimeAuthorizationDenied();
		return this.v3 ?? runtimeAuthorizationDenied();
	}
	private async executeBrowserHandoffV3(
		request: RuntimeBrowserHandoffRequestV3,
		claims: import("@agent-infra/contracts/runtime").RuntimeExecutionGrantClaimsV2,
		signal: AbortSignal,
	) {
		if (!this.v3 || !this.options.driver.executeBrowserHandoff)
			runtimeAuthorizationDenied();
		const session = await this.options.store.authorizeRequestV3(
			claims,
			"query",
			this.options.grantValidationV2?.now ?? Date.now,
		);
		const nativeSessionRef =
			session.session.nativeSessionRef ??
			nativeSessionRequired(
				`executeBrowserHandoffV3:${nativeSessionStateCategory(session.session)}`,
			);
		const admitted = runtimeBrowserExecutionContextForCommand(
			this.browserExecutionContext,
			request,
		);
		const browser = await createBrowserExecutionContextForCommand(
			this.options.createBrowserExecutionContext,
			admitted,
			request.executionId,
			claims.principal,
		);
		if (!browser) runtimeAuthorizationDenied();
		signal.throwIfAborted();
		const record = await this.options.driver.executeBrowserHandoff(
			nativeSessionRef,
			request.executionId,
			request.handoff as import("./driver.js").RuntimeBrowserHandoffRequestV1,
			{ browser },
		);
		return record ?? null;
	}
	private async executeBrowserSideEffectV3(
		request: import("@agent-infra/contracts/runtime").RuntimeBrowserSideEffectConfirmationRequestV3,
		claims: import("@agent-infra/contracts/runtime").RuntimeExecutionGrantClaimsV2,
		signal: AbortSignal,
	) {
		if (!this.v3 || !this.options.driver.executeBrowserSideEffect)
			runtimeAuthorizationDenied();
		const session = await this.options.store.authorizeRequestV3(
			claims,
			"query",
			this.options.grantValidationV2?.now ?? Date.now,
		);
		const nativeSessionRef =
			session.session.nativeSessionRef ??
			nativeSessionRequired(
				`executeBrowserSideEffectV3:${nativeSessionStateCategory(session.session)}`,
			);
		const admitted = runtimeBrowserExecutionContextForCommand(
			this.browserExecutionContext,
			request,
		);
		const browser = await createBrowserExecutionContextForCommand(
			this.options.createBrowserExecutionContext,
			admitted,
			request.executionId,
			claims.principal,
		);
		if (!browser) runtimeAuthorizationDenied();
		signal.throwIfAborted();
		return this.options.driver.executeBrowserSideEffect(
			nativeSessionRef,
			request.executionId,
			request,
			{ browser },
			signal,
		);
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		this.lifetime.abort(
			new RuntimeHostError(
				"RUNTIME_READINESS_UNAVAILABLE",
				"Workload readiness was interrupted",
				503,
				true,
			),
		);
		for (const guard of this.readinessGuards) guard.controller.abort();
		await Promise.allSettled(
			[...this.readinessGuards].map((guard) => guard.done),
		);
		await this.v3?.close();
		// RuntimeHostV3 rejects new V3 work before draining its own recovery
		// guards. Drain the shared legacy queue as well so an already admitted
		// operation cannot outlive host shutdown.
		while (this.queues.size > 0) {
			await Promise.allSettled([...this.queues.values()]);
		}
		// A closed Host cannot authorize another request. Release its Key references
		// without changing running/unknown receipts or claiming native drain.
		// In-flight requests retain their own credential until Driver close drains them.
		this.executionKeys.clear();
	}
	/**
	 * Return the request-scoped file port only when deployment wiring supplied
	 * one. A missing bridge stays fail-closed and never enables Driver media.
	 */
	async getFileBridge(
		request: RuntimeBusinessRequestV4,
	): Promise<RuntimeFileBridgePortV1> {
		this.requireLegacyHost();
		if (!this.options.fileBridge || !this.options.validateGrantV4)
			runtimeAuthorizationDenied();
		const accepted = await this.options.validateGrantV4(request);
		if (!("input" in accepted.request)) runtimeAuthorizationDenied();
		return this.createFileBridgeFor(accepted.request, accepted.claims);
	}

	private async createFileBridgeFor(
		request:
			| RuntimeSubmitTurnTransportV4["businessRequest"]
			| RuntimeSupplementTransportV4["businessRequest"],
		claims: import("@agent-infra/contracts/runtime").RuntimeBusinessGrantClaimsV4,
	): Promise<RuntimeFileBridgePortV1> {
		this.requireLegacyHost();
		const fileBridge = this.options.fileBridge;
		if (!fileBridge) runtimeAuthorizationDenied();
		const binding = await createRuntimeFileBridgeBindingV1({
			request,
			claims,
			// The bridge decides expiry on the deployment clock that validated the
			// grant, not on the wall clock.
			now: (this.options.grantValidationV2?.now ?? Date.now)(),
		});

		// Both binding validation and factory creation await. A Host closed while
		// they were pending must not issue new file authority afterwards.
		this.requireLegacyHost();

		// The Platform exchange needs the original signed V4 Grant as its only
		// positive evidence. It is passed beside the binding so no token can leak
		// into a Driver context, receipt or durable record.
		const evidence = Object.freeze({
			executionGrant: Object.freeze({ ...request.grant }),
		});
		const port = fileBridge(binding, evidence);
		const operationId = request.operation.id;
		const assertOperationCurrent = () =>
			this.options.store.assertOperationAuthorityCurrent(
				operationId,
				binding.executionId,
				binding.sessionGeneration,
				this.options.grantValidationV2?.now ?? Date.now,
			);
		return {
			readInput: (fileId, signal) => port.readInput(fileId, signal),
			writeResult: async (descriptor, body, options) => {
				// #3226：结果写入以当前可续期的执行授权为准，而不是签名 Grant 的窗口；
				// 停止、撤权或代次变化后不再发起写入。
				assertOperationCurrent();
				const receipt = await port.writeResult(descriptor, body, options);
				try {
					assertOperationCurrent();
				} catch (error) {
					throw new RuntimeFileResultUnconfirmedError({ cause: error });
				}
				return receipt;
			},
			revalidate: () => {
				// A deployment port holds the binding, not Runtime authority: re-check
				// that this exact operation is still current before bytes that were
				// already materialized cross the native submission boundary.
				assertOperationCurrent();
				port.revalidate();
			},
		};
	}

	private requireLegacyHost() {
		if (this.closed) runtimeAuthorizationDenied();
	}
	private requireLegacyBusiness() {
		this.requireLegacyHost();
		if (this.options.allowLegacyBusiness === false)
			runtimeAuthorizationDenied();
	}

	submitTurnV3(value: RuntimeSubmitTurnRequestV3, verification: unknown) {
		this.requireLegacyBusiness();
		return this.trustedHost().submitTurn(value, verification);
	}
	supplementV3(value: RuntimeSupplementRequestV3, verification: unknown) {
		this.requireLegacyBusiness();
		return this.trustedHost().supplement(value, verification);
	}
	nativeCapabilityV3(
		value: RuntimeNativeCapabilityRequestV3,
		verification: unknown,
		signal: AbortSignal,
	) {
		this.requireLegacyBusiness();
		return this.trustedHost().nativeCapability(value, verification, signal);
	}
	submitTurnV4(value: RuntimeSubmitTurnTransportV4) {
		if (this.closed || !this.v4) runtimeAuthorizationDenied();
		return this.v4.submitTurn(value);
	}
	supplementV4(value: RuntimeSupplementTransportV4) {
		if (this.closed || !this.v4) runtimeAuthorizationDenied();
		return this.v4.supplement(value);
	}
	nativeCapabilityV4(
		value: import("@agent-infra/contracts/runtime").RuntimeNativeCapabilityTransportV4,
	) {
		if (this.closed || !this.v4) runtimeAuthorizationDenied();
		return this.v4.nativeCapability(value);
	}
	restoreExecutionKeyV4(value: RuntimeRestoreExecutionKeyTransportV4) {
		if (this.closed || !this.v4 || !this.options.validateRecoveryGrantV4)
			runtimeAuthorizationDenied();
		return this.v4.restoreExecutionKey(value);
	}

	/**
	 * Authenticated Native V5 Skill invocation for the exact ordered text input
	 * set. The Host revalidates the full business binding and private Key field
	 * and only then binds the FileBridge. A Driver that has not declared the V5
	 * text-input port fails closed before any file is read.
	 */
	async nativeCapabilityV5(value: RuntimeNativeCapabilityTransportV5) {
		if (this.closed || !this.options.validateGrantV5)
			runtimeAuthorizationDenied();
		const parsed = RuntimeNativeCapabilityTransportV5Schema.parse(value);
		const accepted = await this.options.validateGrantV5(parsed.businessRequest);
		if (!isDeepStrictEqual(accepted.request, parsed.businessRequest))
			runtimeAuthorizationDenied();
		const request = accepted.request;
		const claims = accepted.claims;
		await validateRuntimeBusinessBindingV5(request, claims);
		if (
			claims.purpose !== "business" ||
			request.operation.kind !== "execution" ||
			request.operation.id !== request.executionId ||
			request.operation.deliveryFence !==
				request.operation.executionDeliveryFence ||
			createHash("sha256").update(request.parameters).digest("hex") !==
				request.parametersDigest
		)
			runtimeAuthorizationDenied();
		const privateField = validateRuntimePrivateRelayKeyFieldV5(
			parsed.privateKeyField,
			{
				request,
				grantId: claims.grantId,
				requestDigest: claims.requestDigest,
			},
		);
		const driver = this.options.driver;
		if (
			!driver.createNativeSkillCommand ||
			!driver.resolveNativeSkillBinding ||
			!this.options.fileBridge
		)
			nativeTextInputUnsupported();
		const pinnedScope = this.pinnedScopeForV5(request);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.operation.deliveryFence,
			true,
		);
		const nativeSessionRef =
			session.nativeSessionRef ??
			nativeSessionRequired(
				`executeNativeCapabilityV5:${nativeSessionStateCategory(session)}`,
			);
		const now = this.options.grantValidationV2?.now ?? Date.now;
		const expiresAt = Math.min(claims.expiresAt, now() + 30_000);
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= now())
			nativeSessionRequired(
				`executeNativeCapabilityV5:${nativeSessionStateCategory(session)}`,
			);
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			Math.max(0, expiresAt - now()),
		);
		timer.unref();
		const evidence: RuntimeOriginalEvidenceBinding = {
			principal: request.principal,
			scope: {
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				sessionGeneration: request.sessionGeneration,
			},
		};
		const read = {
			nativeSessionRef,
			allowUnboundExecution: true,
			signal: controller.signal,
			expiresAt,
			assertCurrent: () => {
				if (controller.signal.aborted || expiresAt <= now())
					nativeSessionRequired(
						`executeNativeCapabilityV5:${nativeSessionStateCategory(session)}`,
					);
				this.requireLegacyHost();
				const current = this.options.store.getSessionForQuery(
					request.hostSessionRef,
					request,
					request.operation.deliveryFence,
					true,
				);
				if (current.nativeSessionRef !== nativeSessionRef)
					nativeSessionRequired(
						`executeNativeCapabilityV5:${nativeSessionStateCategory(current)}`,
					);
				return evidence;
			},
			revalidate: async () => {
				const current = read.assertCurrent();
				const reverified = await this.options.validateGrantV5?.(request);
				if (!reverified || !isDeepStrictEqual(reverified.request, request))
					runtimeAuthorizationDenied();
				await validateRuntimeBusinessBindingV5(request, reverified.claims);
				return current;
			},
		};
		try {
			read.assertCurrent();
			const metadataReader = this.options.driver.readNativeMetadataV1;
			if (!metadataReader) nativeTextInputUnsupported();
			const selector = "skills" as const;
			const projection = await metadataReader.call(
				this.options.driver,
				selector,
				read,
			);
			await read.revalidate();
			if (projection.selector !== selector) nativeTextInputUnsupported();
			if (projection.revision !== request.directoryRevision)
				throw new RuntimeHostError(
					"RUNTIME_NATIVE_CAPABILITY_STALE",
					"Native capability directory is no longer current",
					409,
				);
			const capability = projection.capabilities.find(
				(entry) => entry.id === request.capabilityId && entry.kind === "skill",
			);
			if (
				!capability ||
				capability.availability !== "discovered" ||
				capability.source.version !== request.capabilitySourceVersion
			)
				throw new RuntimeHostError(
					"RUNTIME_NATIVE_CAPABILITY_UNAVAILABLE",
					"Native capability is unavailable",
					409,
				);
			const capabilityName = capability.name;
			const response = await this.serialize(
				this.options.store.sessionQueueKey(request),
				async () => {
					this.requireLegacyHost();
					const revalidated = await this.options.validateGrantV5?.(request);
					if (!revalidated || !isDeepStrictEqual(revalidated.request, request))
						runtimeAuthorizationDenied();
					await validateRuntimeBusinessBindingV5(request, revalidated.claims);
					const latest = await metadataReader.call(
						this.options.driver,
						selector,
						read,
					);
					if (
						latest.selector !== selector ||
						latest.revision !== request.directoryRevision
					)
						throw new RuntimeHostError(
							"RUNTIME_NATIVE_CAPABILITY_STALE",
							"Native capability directory is no longer current",
							409,
						);
					const latestCapability = latest.capabilities.find(
						(entry) =>
							entry.id === request.capabilityId && entry.kind === "skill",
					);
					if (
						!latestCapability ||
						latestCapability.name !== capabilityName ||
						latestCapability.availability !== "discovered" ||
						latestCapability.source.version !== request.capabilitySourceVersion
					)
						throw new RuntimeHostError(
							"RUNTIME_NATIVE_CAPABILITY_STALE",
							"Native capability is no longer current",
							409,
						);
					const prepared = await this.options.store.prepareOperation({
						authorization: this.businessAuthorityForV5(revalidated.claims),
						now,
						requestedHostSessionRef: request.hostSessionRef,
						binding: request,
						operationId: request.executionId,
						kind: "submit-turn",
						scope: `execution:${request.executionId}`,
						deliveryFence: request.operation.deliveryFence,
						requestDigest: requestDigest(
							runtimeOperationDigestInputV5(request),
						),
						keyScopeV4: pinnedScope,
						command: (commandNativeSessionRef) => {
							if (commandNativeSessionRef !== nativeSessionRef)
								nativeSessionRequired(
									`executeNativeCapabilityV5:${nativeSessionStateCategory(session)}`,
								);
							const resolveSkill = driver.resolveNativeSkillBinding;
							const skillCreate = driver.createNativeSkillCommand;
							if (!resolveSkill || !skillCreate) nativeTextInputUnsupported();
							const skillBinding = resolveSkill.call(driver, {
								nativeSessionRef: commandNativeSessionRef,
								capabilityName,
								capabilitySourceVersion: request.capabilitySourceVersion,
								directoryRevision: request.directoryRevision,
							});
							const command = skillCreate.call(driver, {
								schemaVersion: 1,
								kind: "native-capability",
								operationId: request.executionId,
								agentId: request.agentId,
								conversationId: request.conversationId,
								executionId: request.executionId,
								turnId: request.turnId,
								sessionGeneration: request.sessionGeneration,
								nativeSessionRef: commandNativeSessionRef,
								capabilityId: request.capabilityId,
								directoryRevision: request.directoryRevision,
								parameters: request.parameters,
								parametersDigest: request.parametersDigest,
								capabilityName,
								capabilitySourceVersion: request.capabilitySourceVersion,
								packageDigest: skillBinding.packageDigest,
								manifestDigest: skillBinding.manifestDigest,
							});
							// The Driver builds its ordinary Skill command without
							// attachments; V5 adds exactly the admitted ordered ids. The
							// Driver resolves their bytes through the request-scoped bridge.
							return {
								...command,
								input: {
									...command.input,
									attachments: request.attachments.map(
										(attachment) => attachment.attachmentId,
									),
								},
							};
						},
					});
					this.requireLegacyHost();
					if (prepared.operation.state === "resolved") {
						const replayed = RuntimeOperationResponseV5Schema.parse({
							schemaVersion: 5,
							hostSessionRef: prepared.session.hostSessionRef,
							operationId: prepared.operation.operationId,
							result: prepared.operation.result,
						});
						if (
							replayed.result.outcome === "accepted" &&
							replayed.result.status === "running"
						)
							this.installExecutionKey(
								pinnedScope,
								prepared.session.hostSessionRef,
								privateField.keyDelivery.relayKey,
							);
						return replayed;
					}
					this.installExecutionKey(
						pinnedScope,
						prepared.session.hostSessionRef,
						privateField.keyDelivery.relayKey,
					);
					const dispatch = await this.withNativeTextInputBridge({
						request,
						claims: revalidated.claims,
						hostSessionRef: prepared.session.hostSessionRef,
						operationId: prepared.operation.operationId,
						executionId: request.executionId,
						sessionGeneration: request.sessionGeneration,
						now,
						dispatch: (context) =>
							this.dispatch(
								prepared.session.hostSessionRef,
								prepared.operation,
								true,
								context,
							),
					});
					const result = RuntimeOperationResponseV5Schema.shape.result.parse(
						dispatch.result,
					);
					return RuntimeOperationResponseV5Schema.parse({
						schemaVersion: 5,
						hostSessionRef: prepared.session.hostSessionRef,
						operationId: prepared.operation.operationId,
						result,
					});
				},
			);
			return response;
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}

	/**
	 * Existing-accepted-only V5 Key restore. It never creates a new execution or
	 * native intent, never rematerializes attachments and never grants file
	 * access; it only reinstates the frozen private Key context of the original
	 * accepted Native V5 request.
	 */
	async restoreExecutionKeyV5(value: RuntimeRestoreExecutionKeyTransportV5) {
		if (this.closed || !this.options.validateRecoveryGrantV5)
			runtimeAuthorizationDenied();
		const parsed = RuntimeRestoreExecutionKeyTransportV5Schema.parse(value);
		const accepted = await this.options.validateRecoveryGrantV5(
			parsed.recoveryRequest,
		);
		if (!isDeepStrictEqual(accepted.request, parsed.recoveryRequest))
			runtimeAuthorizationDenied();
		const request = accepted.request;
		const claims = accepted.claims;
		await validateRuntimeRestoreExecutionKeyBindingV5(request, claims);
		const privateField = validateRuntimeRestoreExecutionKeyPrivateFieldV5(
			parsed.privateKeyField,
			{ request, claims },
		);
		const original = request.originalRequest;
		const operationDigest = requestDigest(
			runtimeOperationDigestInputV5(original),
		);
		if (
			request.acceptedOperationDigest !== operationDigest ||
			(original.hostSessionRef !== null &&
				original.hostSessionRef !== request.acceptedHostSessionRef)
		)
			runtimeAuthorizationDenied();
		const pinnedScope = this.pinnedScopeForV5(original);
		const indexed =
			this.options.store.readOriginalExecutionKeyScopeV4(pinnedScope);
		if (
			!indexed?.scope ||
			indexed.hostSessionRef !== request.acceptedHostSessionRef ||
			!isDeepStrictEqual(indexed.scope, pinnedScope) ||
			indexed.operation.requestDigest !== operationDigest ||
			indexed.operation.state !== "resolved" ||
			indexed.operation.result?.outcome !== "accepted" ||
			indexed.operation.result.status !== "running"
		)
			runtimeAuthorizationDenied();
		this.requireLegacyHost();
		const observed = await this.dispatch(
			request.acceptedHostSessionRef,
			indexed.operation,
			false,
		);
		if (
			observed.result.outcome !== "accepted" ||
			observed.result.status !== "running"
		)
			runtimeAuthorizationDenied();
		// Re-read the accepted original after the Driver observation; a concurrent
		// terminal transition must not install a Key for a finished execution.
		const current =
			this.options.store.readOriginalExecutionKeyScopeV4(pinnedScope);
		if (
			!current?.scope ||
			current.hostSessionRef !== request.acceptedHostSessionRef ||
			!isDeepStrictEqual(current.scope, pinnedScope) ||
			current.operation.requestDigest !== operationDigest ||
			current.operation.state !== "resolved" ||
			current.operation.result?.outcome !== "accepted" ||
			current.operation.result.status !== "running"
		)
			runtimeAuthorizationDenied();
		this.requireLegacyHost();
		this.installExecutionKey(
			pinnedScope,
			request.acceptedHostSessionRef,
			privateField.keyDelivery.relayKey,
		);
		return RuntimeRestoreExecutionKeyResponseV5Schema.parse({
			schemaVersion: 5,
			hostSessionRef: request.acceptedHostSessionRef,
			operationId: current.operation.operationId,
			result: "restored",
		});
	}

	private pinnedScopeForV5(request: RuntimeNativeCapabilityRequestV5) {
		return RuntimePinnedExecutionKeyScopeV4Schema.parse({
			principal: request.principal,
			executionSource: request.executionSource,
			channelId: request.channelId,
			agentId: request.agentId,
			conversationId: request.conversationId,
			executionId: request.executionId,
			turnId: request.turnId,
			sessionGeneration: request.sessionGeneration,
			hostSessionRef: request.hostSessionRef,
			keyBinding: request.keyBinding,
		});
	}

	private businessAuthorityForV5(claims: RuntimeBusinessGrantClaimsV4) {
		const {
			schemaVersion: _schemaVersion,
			executionSource: _executionSource,
			relayKeyBinding: _relayKeyBinding,
			...common
		} = claims;
		return {
			...common,
			schemaVersion: 2 as const,
		};
	}

	/**
	 * Build the FileBridge and the narrow ordered text-input port for exactly one
	 * admitted V5 request, then dispatch with both. The bridge is never created
	 * when the grant, attachment set or current operation authority is stale.
	 */
	private async withNativeTextInputBridge(input: {
		readonly request: RuntimeNativeCapabilityRequestV5;
		readonly claims: RuntimeBusinessGrantClaimsV4;
		readonly hostSessionRef: string;
		readonly operationId: string;
		readonly executionId: string;
		readonly sessionGeneration: number;
		readonly now: () => number;
		readonly dispatch: (
			context: RuntimeDriverExecutionContextV1 &
				RuntimeNativeTextInputExecutionContextV1,
		) => Promise<RuntimeOperationResponse>;
	}) {
		const fileBridge = this.options.fileBridge;
		if (!fileBridge) nativeTextInputUnsupported();
		const { binding, inputs } = await createRuntimeNativeTextInputBindingV5({
			request: input.request,
			claims: input.claims,
			now: input.now(),
		});
		this.requireLegacyHost();
		// The Platform's formal V4 exchange needs the original signed Grant as
		// its only positive evidence; it never enters the binding or receipts.
		const evidence = Object.freeze({
			executionGrant: Object.freeze({ ...input.request.grant }),
		});
		const port = fileBridge(binding, evidence);
		const assertOperationCurrent = () =>
			this.options.store.assertOperationAuthorityCurrent(
				input.operationId,
				input.executionId,
				input.sessionGeneration,
				input.now,
			);
		const authorityBridge: RuntimeFileBridgePortV1 = {
			readInput: (fileId, signal) => port.readInput(fileId, signal),
			writeResult: async (descriptor, body, options) => {
				// #3226：与 V4 相同，结果写入以当前执行授权为准。
				assertOperationCurrent();
				const receipt = await port.writeResult(descriptor, body, options);
				try {
					assertOperationCurrent();
				} catch (error) {
					throw new RuntimeFileResultUnconfirmedError({ cause: error });
				}
				return receipt;
			},
			revalidate: () => {
				assertOperationCurrent();
				port.revalidate();
			},
		};
		const nativeTextInput: RuntimeNativeTextInputPortV1 =
			createRuntimeNativeTextInputPortV1({
				binding,
				inputs,
				bridge: authorityBridge,
				now: input.now,
			});
		// P4 reads this method from the same object it receives as
		// RuntimeFileBridgePortV1, so the ordered text input seam must travel on
		// the bridge rather than in a side channel.
		const bridge: RuntimeFileBridgeWithNativeTextInputV1 = {
			...authorityBridge,
			schemaVersion: 1,
			inputs: nativeTextInput.inputs,
			readNativeTextInput: (attachmentId, signal) =>
				nativeTextInput.readNativeTextInput(attachmentId, signal),
		};
		this.requireLegacyHost();
		return input.dispatch({ fileBridge: bridge, nativeTextInput });
	}

	private async eventAuthorityV4(
		request: RuntimeEventReadRequestV4 | RuntimeEventAckRequestV4,
		verification: unknown,
	) {
		if (this.closed) runtimeAuthorizationDenied("host-closed");
		if (!this.v4 || !this.options.grantValidationV2)
			runtimeAuthorizationDenied("v4-unconfigured");
		const original =
			this.options.store.readOriginalExecutionKeyScopeV4(request);
		const verified =
			VerifiedRuntimeExecutionGrantV2Schema.safeParse(verification);
		if (!original?.scope)
			runtimeAuthorizationDenied("v4-original-scope-missing");
		if (original.hostSessionRef !== request.hostSessionRef)
			runtimeAuthorizationDenied("v4-original-session-mismatch");
		if (
			original.operation.kind !== "submit-turn" &&
			original.operation.kind !== "native-command"
		)
			runtimeAuthorizationDenied("v4-original-operation-kind");
		if (!verified.success)
			runtimeAuthorizationDenied("v4-verification-invalid");
		try {
			await validateRuntimeEventAccessV4(
				request,
				verified.data,
				original.scope,
				original.hostSessionRef,
				{
					expectedIssuer: this.options.grantValidationV2.expectedIssuer,
					expectedWorkerId: this.options.grantValidationV2.expectedWorkerId,
					now: (this.options.grantValidationV2.now ?? Date.now)(),
					trustedOperation: {
						kind: "execution",
						id: original.operation.operationId,
						deliveryFence: original.operation.deliveryFence,
						executionDeliveryFence: original.operation.deliveryFence,
					},
				},
			);
		} catch (error) {
			runtimeAuthorizationDenied(
				`v4-event-access:${runtimeAccessDenialCause(error)}`,
			);
		}
		return verified.data.claims;
	}

	async readEventsV4(value: RuntimeEventReadRequestV4, verification: unknown) {
		const parsed = RuntimeEventReadRequestV4Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const claims = await this.eventAuthorityV4(request, verification);
				const { session } = await this.options.store.authorizeRequestV3(
					claims,
					"query",
					this.options.grantValidationV2?.now ?? Date.now,
				);
				const nativeSessionRef =
					session.nativeSessionRef ??
					nativeSessionRequired(
						`readEventsV4:${nativeSessionStateCategory(session)}`,
					);
				const replay = RuntimeEventSchema.array().safeParse(
					await callDriver(() =>
						this.options.driver.replayEvents(
							nativeSessionRef,
							request.executionId,
							request.afterCursor ?? undefined,
						),
					),
				);
				if (
					!replay.success ||
					replay.data.some((event) => event.executionId !== request.executionId)
				)
					driverInvalid();
				await this.finalizeEventExecutionKey(
					request.hostSessionRef,
					request.executionId,
				);
				const events = replayPage(replay.data);
				if (events.length > 0) {
					// One authority check and one durable write cover the whole page.
					await this.eventAuthorityV4(request, verification);
					await this.options.store.recordDeliveredCursors(
						claims,
						events.map((event) => event.cursor),
						this.options.grantValidationV2?.now ?? Date.now,
					);
				}
				return RuntimeEventReplayResponseV4Schema.parse({
					schemaVersion: 4,
					hostSessionRef: request.hostSessionRef,
					executionId: request.executionId,
					events,
				});
			},
		);
	}

	async acknowledgeEventsV4(
		value: RuntimeEventAckRequestV4,
		verification: unknown,
	) {
		const parsed = RuntimeEventAckRequestV4Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const claims = await this.eventAuthorityV4(request, verification);
				await this.options.store.authorizeRequestV3(
					claims,
					"query",
					this.options.grantValidationV2?.now ?? Date.now,
				);
				const session = this.options.store.checkAcknowledgableCursor(
					claims,
					request.confirmedCursor,
				);
				await this.options.store.acknowledgeCursor(
					claims,
					request.confirmedCursor,
					this.options.grantValidationV2?.now ?? Date.now,
				);
				await this.eventAuthorityV4(request, verification);
				await this.options.driver.acknowledgeEvents?.(
					session.nativeSessionRef ??
						nativeSessionRequired(
							`acknowledgeEventsV4:${nativeSessionStateCategory(session)}`,
						),
					request.executionId,
					request.confirmedCursor,
				);
				await this.finalizeEventExecutionKey(
					request.hostSessionRef,
					request.executionId,
				);
				return RuntimeEventAckResponseV4Schema.parse({
					schemaVersion: 4,
					executionId: request.executionId,
					confirmedCursor: request.confirmedCursor,
				});
			},
		);
	}
	stopV3(value: RuntimeStopRequestV3, verification: unknown) {
		return this.trustedHost().stop(value, verification);
	}
	browserHandoff(
		value: RuntimeBrowserHandoffRequestV3,
		verification: unknown,
		signal: AbortSignal,
	) {
		return this.trustedHost().browserHandoff(value, verification, signal);
	}
	browserSideEffect(
		value: import("@agent-infra/contracts/runtime").RuntimeBrowserSideEffectConfirmationRequestV3,
		verification: unknown,
		signal: AbortSignal,
	) {
		return this.trustedHost().browserSideEffect(value, verification, signal);
	}
	recoverStatusV3(
		value: RuntimeStatusRequestV3,
		verification: unknown,
		signal?: AbortSignal,
	) {
		return this.trustedHost().recoverStatus(value, verification, signal);
	}
	readOriginalBinding(value: RuntimeStatusRequestV3, verification: unknown) {
		return this.trustedHost().readOriginalBinding(value, verification);
	}
	cancelGenerationV3(
		value: RuntimeGenerationCancelRequestV3,
		verification: unknown,
	) {
		return this.trustedHost().cancelGeneration(value, verification);
	}
	renewAuthorizationV3(
		value: RuntimeAuthorizationRenewRequestV3,
		verification: unknown,
	) {
		return this.trustedHost().renewAuthorization(value, verification);
	}
	streamEventsV3(
		value: RuntimeEventPersistRequestV3,
		verification: unknown,
		signal?: AbortSignal,
	) {
		return this.trustedHost().streamEvents(value, verification, signal);
	}
	acknowledgeEventsV3(value: RuntimeEventAckRequestV3, verification: unknown) {
		return this.trustedHost().acknowledgeEvents(value, verification);
	}
	async authorizeExternalAction(
		action: RuntimeExternalActionAuthorization,
	): Promise<
		| (RuntimeExternalActionAuthorizationResult & {
				readonly revalidate: () => void;
		  })
		| undefined
	> {
		this.trustedHost();
		if (!this.options.driver.validateExternalAction)
			runtimeAuthorizationDenied();
		const originalAction = { ...action };
		await this.bindOriginalNativeSession(originalAction);
		const delivery =
			await this.currentExternalActionAuthorization(originalAction);
		if (!delivery) {
			if (originalAction.kind !== "tool") return;
			return {
				revalidate: () => {
					this.trustedHost();
					this.options.store.assertExternalActionCurrent(
						originalAction,
						this.options.grantValidationV2?.now ?? Date.now,
					);
				},
			};
		}
		return {
			...delivery,
			revalidate: () =>
				this.assertCurrentModelKey(originalAction, delivery.relayKey),
		};
	}

	/**
	 * Persist one metadata-only operation fact after the caller has completed
	 * the existing external-action authorization handshake.
	 */
	async recordOperationFact(input: RuntimeOperationFactInputV1): Promise<void> {
		this.trustedHost();
		if (!this.options.driver.recordOperationFact) runtimeAuthorizationDenied();
		const action: RuntimeExternalActionAuthorization = {
			nativeSessionRef: input.nativeSessionRef,
			executionId: input.executionId,
			runtimeOperationId: input.executionId,
			operationRef: input.fact.operationRef,
			attemptRef: input.fact.attemptRef,
			kind: input.fact.kind,
		};
		if (input.fact.phase === "intent") {
			await this.options.store.authorizeExternalAction(
				action,
				this.options.grantValidationV2?.now ?? Date.now,
			);
			this.trustedHost();
		} else await this.authorizeExternalAction(action);
		await this.options.driver.recordOperationFact(input);
	}

	private async currentExternalActionAuthorization(
		action: RuntimeExternalActionAuthorization,
	) {
		this.trustedHost();
		if (!this.options.driver.validateExternalAction)
			runtimeAuthorizationDenied();
		await this.options.store.authorizeExternalAction(
			action,
			this.options.grantValidationV2?.now ?? Date.now,
		);
		await this.options.driver.validateExternalAction(action);
		// Native validation may yield while the lease expires, a stop commits or
		// the Host closes. Keep this final check next to the authorization result.
		this.trustedHost();
		await this.options.store.authorizeExternalAction(
			action,
			this.options.grantValidationV2?.now ?? Date.now,
		);
		this.trustedHost();
		if (action.kind === "model" && this.v4) {
			const entry = this.executionKeys.get(action.executionId);
			if (!entry) runtimeAuthorizationDenied();
			this.assertCurrentModelKey(action, entry.relayKey);
			return { relayKey: entry.relayKey };
		}
	}

	private assertCurrentModelKey(
		action: RuntimeExternalActionAuthorization,
		relayKey: string,
	) {
		this.trustedHost();
		this.options.store.assertExternalActionCurrent(
			action,
			this.options.grantValidationV2?.now ?? Date.now,
		);
		const entry = this.executionKeys.get(action.executionId);
		if (!entry || entry.relayKey !== relayKey) runtimeAuthorizationDenied();
		const original = this.options.store.readOriginalExecutionKeyScopeV4(
			entry.scope,
		);
		if (
			!original?.scope ||
			original.hostSessionRef !== entry.hostSessionRef ||
			!isDeepStrictEqual(original.scope, entry.scope) ||
			this.options.store.nativeSessionRef(entry.hostSessionRef) !==
				action.nativeSessionRef ||
			!(
				(original.operation.state === "prepared" &&
					original.operation.result === undefined) ||
				(original.operation.result?.outcome === "accepted" &&
					original.operation.result.status === "running")
			)
		)
			runtimeAuthorizationDenied();
	}

	private async bindOriginalNativeSession(action: {
		nativeSessionRef: string;
		executionId: string;
		runtimeOperationId: string;
	}) {
		const candidates = this.options.store
			.listRecoverableOperations()
			.filter(
				({ operation }) =>
					operation.kind === "submit-turn" &&
					operation.operationId === action.runtimeOperationId &&
					operation.executionId === action.executionId,
			);
		const candidate = candidates[0];
		if (
			candidates.length !== 1 ||
			!candidate ||
			candidate.session.nativeSessionRef !== undefined ||
			candidate.operation.state !== "prepared" ||
			candidate.operation.result !== undefined ||
			action.runtimeOperationId !== action.executionId
		)
			return;
		const { session, operation } = candidate;
		const reference = {
			agentId: session.agentId,
			conversationId: session.conversationId,
			sessionGeneration: session.sessionGeneration,
			executionId: action.executionId,
		};
		const readNow = this.options.grantValidationV2?.now ?? Date.now;
		// The first native action can arrive while execute still awaits its result.
		// Use the original durable command, never the callback ref, as lookup authority.
		await this.options.store.resolveOriginalExecutionBinding(
			reference,
			readNow,
		);
		const lookup = parseDriverLookup(
			await this.options.driver.lookupOperation(operation.command),
			operation,
			action.nativeSessionRef,
		);
		this.trustedHost();
		await this.options.store.resolveOriginalExecutionBinding(
			reference,
			readNow,
		);
		if (
			lookup.state !== "found" ||
			lookup.record.result.outcome !== "accepted" ||
			lookup.record.result.status !== "running"
		)
			runtimeAuthorizationDenied();
		this.trustedHost();
		const resolved = await this.options.store.resolveOperation(
			session.hostSessionRef,
			operation.operationId,
			lookup.record.result,
			lookup.record.nativeSessionRef,
		);
		this.trustedHost();
		if (
			resolved.operation.result?.outcome !== "accepted" ||
			resolved.operation.result.status !== "running" ||
			resolved.session.nativeSessionRef !== lookup.record.nativeSessionRef
		)
			runtimeAuthorizationDenied();
	}

	/** Resolve the accepted original principal; this is not a Connection grant. */
	async resolveOriginalExecutionBinding(
		reference: RuntimeOriginalExecutionRef,
	) {
		this.trustedHost();
		return this.options.store.resolveOriginalExecutionBinding(
			reference,
			this.options.grantValidationV2?.now ?? Date.now,
		);
	}

	/**
	 * Resolve a native Session only after checking the durable original
	 * Execution authority.  This is a read-only production assembly seam for
	 * native metadata; it does not create or renew a Runtime Session.
	 */
	async resolveNativeMetadataSessionRef(
		reference: NativeMetadataObjectScopeV1,
		hostSessionRef: string,
	) {
		this.trustedHost();
		return this.options.store.resolveNativeSessionRefForOriginalExecution(
			reference,
			hostSessionRef,
		);
	}

	static async open(options: RuntimeHostOptions) {
		const host = new RuntimeHost(options);
		await host.recoverOperations();
		return host;
	}

	async submitTurn(
		value: RuntimeSubmitTurnRequestV1,
		verification: unknown,
	): Promise<RuntimeOperationResponseV1> {
		this.requireLegacyBusiness();
		const parsed = RuntimeSubmitTurnRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"turn.submit",
			verification,
			this.options.grantValidation,
		);
		return v1OperationResponse(await this.submit(request));
	}

	async submitTurnV2(
		value: RuntimeSubmitTurnRequestV2,
		verification: unknown,
	): Promise<RuntimeOperationResponseV2> {
		this.requireLegacyBusiness();
		const parsed = RuntimeSubmitTurnRequestV2Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"turn.submit",
			verification,
			this.options.grantValidation,
		);
		return v2OperationResponse(await this.submit(request));
	}

	private submit(
		request: RuntimeSubmitTurnRequestV1 | RuntimeSubmitTurnRequestV2,
	) {
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const prepared = await this.options.store.prepareOperation({
					requestedHostSessionRef: request.hostSessionRef,
					binding: request,
					operationId: request.executionId,
					kind: "submit-turn",
					scope: `execution:${request.executionId}`,
					deliveryFence: request.deliveryFence,
					requestDigest: requestDigest({
						kind: "submit-turn",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						input: request.input,
						...(request.schemaVersion === 2
							? { selection: request.selection }
							: {}),
					}),
					command: (nativeSessionRef) => {
						const command = {
							kind: "submit-turn" as const,
							operationId: request.executionId,
							agentId: request.agentId,
							conversationId: request.conversationId,
							executionId: request.executionId,
							turnId: request.turnId,
							sessionGeneration: request.sessionGeneration,
							...(nativeSessionRef ? { nativeSessionRef } : {}),
							input: request.input,
						};
						return request.schemaVersion === 2
							? {
									schemaVersion: 2 as const,
									...command,
									selection: request.selection,
								}
							: { schemaVersion: 1 as const, ...command };
					},
				});
				return this.dispatch(
					prepared.session.hostSessionRef,
					prepared.operation,
				);
			},
		);
	}

	async status(
		value: RuntimeStatusRequestV1,
		verification: unknown,
	): Promise<RuntimeStatusResponseV1> {
		this.requireLegacyHost();
		const parsed = RuntimeStatusRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"session.status",
			verification,
			this.options.grantValidation,
		);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		return {
			schemaVersion: 1,
			hostSessionRef: request.hostSessionRef,
			executionId: request.executionId,
			status: await this.readStatus(session, request.executionId),
		};
	}

	async recoverStatusV2(
		value: RuntimeStatusRequestV2,
		verification: unknown,
	): Promise<RuntimeStatusResponseV2> {
		this.requireLegacyHost();
		const parsed = RuntimeStatusRequestV2Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		for (const command of ["session.status", "turn.submit"] as const) {
			validateRuntimeExecutionGrant(
				request,
				command,
				verification,
				this.options.grantValidation,
			);
		}
		const session = await this.options.store.recoverOperation({
			requestedHostSessionRef: request.hostSessionRef,
			binding: request,
			operationId: request.executionId,
			kind: "submit-turn",
			scope: `execution:${request.executionId}`,
			deliveryFence: request.deliveryFence,
			requestDigest: requestDigest({
				kind: "submit-turn",
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				input: request.recovery.input,
				...(request.recovery.selection
					? { selection: request.recovery.selection }
					: {}),
			}),
		});
		if (!session) {
			return {
				schemaVersion: 2,
				hostSessionRef: request.hostSessionRef,
				executionId: request.executionId,
				outcome: "not_found",
			};
		}
		return {
			schemaVersion: 2,
			hostSessionRef: request.hostSessionRef,
			executionId: request.executionId,
			outcome: "found",
			status: await this.readStatus(session, request.executionId),
		};
	}

	private async readStatus(session: StoredSession, executionId: string) {
		if (session.recovery?.status === "blocked") return "unavailable" as const;
		const nativeSessionRef =
			session.nativeSessionRef ??
			nativeSessionRequired(
				`readStatus:${nativeSessionStateCategory(session)}`,
			);
		const status = RuntimeStatusV1Schema.safeParse(
			await callDriver(() =>
				this.options.driver.getStatus(nativeSessionRef, executionId),
			),
		);
		if (!status.success) driverInvalid();
		return status.data;
	}

	async readiness(
		value: WorkloadReadinessRequestV1,
		authenticatedWorkerId: string,
		signal: AbortSignal,
	): Promise<WorkloadReadinessResponseV1> {
		if (this.closed)
			throw new RuntimeHostError(
				"RUNTIME_READINESS_UNAVAILABLE",
				"Workload readiness is unavailable",
				503,
				true,
			);
		const parsed = WorkloadReadinessRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		const verify = this.options.readinessVerifier;
		if (!verify)
			throw new RuntimeHostError(
				"RUNTIME_READINESS_UNAVAILABLE",
				"Workload readiness is not configured",
				503,
				true,
			);
		verify(request, authenticatedWorkerId);
		const browserAssemblyEpoch = ++this.browserAssemblyEpoch;
		const publishBrowserAssembly = (
			input:
				| {
						readonly declaration: BrowserCapabilityDeclarationV1;
						readonly binding: BrowserCapabilityBindingV1;
						readonly manifestDigest: string;
						readonly probe: RuntimeBrowserCapabilityProbeEvidenceV1;
				  }
				| RuntimeBrowserCapabilityAssemblyFailureV1
				| undefined,
		) => {
			if (browserAssemblyEpoch !== this.browserAssemblyEpoch) return;
			this.browserExecutionContext =
				input && "binding" in input && "probe" in input
					? {
							capabilityVersion: input.probe.capabilityVersion,
							binding: {
								agentId: input.binding.agentId,
								conversationId: input.binding.sessionId,
								sessionGeneration: input.binding.sessionGeneration,
								resourceFence: input.binding.resourceFence,
								workloadRevision: input.binding.workloadRevision,
								imageDigest: input.binding.imageDigest,
							},
						}
					: undefined;
			this.options.onBrowserCapabilityAssembly?.(input);
		};
		publishBrowserAssembly(
			request.browserDeclaration
				? {
						failure: {
							status: "unavailable",
							errorCode: "BROWSER_CAPABILITY_UNAVAILABLE",
							reason: "Browser capability readiness is pending",
							retryable: true,
						},
					}
				: undefined,
		);
		if (!this.options.driver.probeReadiness) driverInvalid();
		const controller = new AbortController();
		const bounded = AbortSignal.any([
			signal,
			this.lifetime.signal,
			controller.signal,
			AbortSignal.timeout(10_000),
		]);
		const interrupted = () =>
			new RuntimeHostError(
				"RUNTIME_READINESS_UNAVAILABLE",
				"Workload readiness was interrupted",
				503,
				true,
			);
		if (bounded.aborted) throw interrupted();
		let abort = () => {};
		const guard = {
			controller,
			done: Promise.resolve(),
		};
		this.readinessGuards.add(guard);
		try {
			let probe: Promise<RuntimeCapabilitiesV1>;
			try {
				probe = this.options.driver.probeReadiness(bounded);
			} catch {
				probe = Promise.reject(
					new RuntimeHostError(
						"RUNTIME_READINESS_UNAVAILABLE",
						"Workload readiness is unavailable",
						503,
						true,
					),
				);
			}
			let drainTimer: ReturnType<typeof setTimeout> | undefined;
			const drainDeadline = new Promise<void>((resolve) => {
				drainTimer = setTimeout(resolve, 10_000);
			});
			guard.done = Promise.race([
				probe.then(
					() => undefined,
					() => undefined,
				),
				drainDeadline,
			]).finally(() => {
				if (drainTimer !== undefined) clearTimeout(drainTimer);
				this.readinessGuards.delete(guard);
			});
			let capabilities: RuntimeCapabilitiesV1;
			try {
				capabilities = await Promise.race([
					new Promise<never>((_resolve, reject) => {
						abort = () => reject(interrupted());
						bounded.addEventListener("abort", abort, { once: true });
					}),
					probe,
				]);
			} catch {
				if (bounded.aborted) throw interrupted();
				throw new RuntimeHostError(
					"RUNTIME_READINESS_UNAVAILABLE",
					"Workload readiness is unavailable",
					503,
					true,
				);
			}
			const parsedCapabilities =
				RuntimeCapabilitiesV1Schema.safeParse(capabilities);
			if (!parsedCapabilities.success)
				throw new RuntimeHostError(
					"RUNTIME_READINESS_UNAVAILABLE",
					"Workload readiness is unavailable",
					503,
					true,
				);
			capabilities = parsedCapabilities.data;
			if (bounded.aborted) throw interrupted();
			if (this.closed)
				throw new RuntimeHostError(
					"RUNTIME_READINESS_UNAVAILABLE",
					"Workload readiness is unavailable",
					503,
					true,
				);
			verify(request, authenticatedWorkerId);
			const browserBinding = request.browserBinding;
			let browserProbe = capabilities.browser;
			if (
				!browserProbe?.binding &&
				request.browserDeclaration &&
				browserBinding &&
				this.options.probeBrowserCapability
			) {
				try {
					browserProbe = await this.options.probeBrowserCapability({
						declaration: request.browserDeclaration,
						binding: browserBinding,
						signal: bounded,
					});
				} catch {
					browserProbe = undefined;
				}
			}
			if (browserProbe)
				capabilities = { ...capabilities, browser: browserProbe };
			if (!request.browserDeclaration) {
				publishBrowserAssembly(undefined);
			} else if (
				browserBinding &&
				browserBinding.agentId === request.agentId &&
				browserBinding.workloadRevision === request.workloadRevision &&
				browserBinding.resourceFence === request.fence &&
				browserBinding.imageDigest === request.imageDigest &&
				browserProbe?.binding &&
				isDeepStrictEqual(browserBinding, browserProbe.binding)
			) {
				publishBrowserAssembly({
					declaration: request.browserDeclaration,
					binding: browserBinding,
					manifestDigest: request.imageDigest,
					probe: browserProbe,
				});
			} else {
				publishBrowserAssembly({
					failure: {
						status: "unavailable",
						errorCode: "BROWSER_CAPABILITY_UNAVAILABLE",
						reason:
							"Browser capability evidence does not match the admitted Sandbox binding",
						retryable: true,
					},
				});
			}
			const { grant: _proof, ...binding } = request;
			return WorkloadReadinessResponseV1Schema.parse({
				...binding,
				core: "passed",
				capabilities,
			});
		} catch (error) {
			publishBrowserAssembly(
				request.browserDeclaration
					? {
							failure: {
								status: "unavailable",
								errorCode: "BROWSER_CAPABILITY_UNAVAILABLE",
								reason:
									"Browser capability readiness probe did not complete successfully",
								retryable: true,
							},
						}
					: undefined,
			);
			throw error;
		} finally {
			bounded.removeEventListener("abort", abort);
		}
	}

	async capabilities(
		value: RuntimeCapabilitiesRequestV1,
		verification: unknown,
	): Promise<RuntimeCapabilitiesResponseV1> {
		this.requireLegacyHost();
		const parsed = RuntimeCapabilitiesRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"capabilities.read",
			verification,
			this.options.grantValidation,
		);
		if (request.hostSessionRef) {
			this.options.store.getSessionForQuery(
				request.hostSessionRef,
				request,
				request.deliveryFence,
			);
		}
		const capabilities = RuntimeCapabilitiesV1Schema.safeParse(
			await callDriver(() => this.options.driver.getCapabilities()),
		);
		if (!capabilities.success) driverInvalid();
		return {
			schemaVersion: 1,
			capabilities: capabilities.data,
		};
	}

	private nativeSkillReadContext(
		request: RuntimeSkillDirectoryRequestV1 | RuntimeSkillResourceReadRequestV1,
		verification: unknown,
		signal: AbortSignal,
		claims: ReturnType<typeof validateRuntimeExecutionGrant>,
	) {
		const now = () =>
			Date.parse(
				(
					this.options.grantValidation.now ?? (() => new Date().toISOString())
				)(),
			);
		const expiresAt = Math.min(Date.parse(claims.expiresAt), now() + 30_000);
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= now())
			runtimeAuthorizationDenied();
		const nativeSkillSession = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		const nativeSessionRef =
			nativeSkillSession.nativeSessionRef ??
			nativeSessionRequired(
				`nativeSkillReadContext:${nativeSessionStateCategory(nativeSkillSession)}`,
			);
		const deadline = new AbortController();
		const readSignal = AbortSignal.any([signal, deadline.signal]);
		const deadlineTimer = setTimeout(
			() => deadline.abort(),
			Math.max(0, expiresAt - now()),
		);
		const assertCurrent = () => {
			if (readSignal.aborted || expiresAt <= now())
				runtimeAuthorizationDenied();
			this.requireLegacyHost();
			this.options.store.getSessionForQuery(
				request.hostSessionRef,
				request,
				request.deliveryFence,
			);
		};
		return {
			nativeSessionRef,
			signal: readSignal,
			expiresAt,
			assertCurrent,
			revalidate: async () => {
				assertCurrent();
				// The current Grant and durable session are checked again after every
				// Driver await. This is a read-only context, never a business permit.
				validateRuntimeExecutionGrant(
					request,
					"skills.read",
					verification,
					this.options.grantValidation,
				);
				assertCurrent();
			},
			close: () => {
				clearTimeout(deadlineTimer);
				deadline.abort();
			},
		};
	}

	/**
	 * Receive one authenticated native metadata projection. The caller supplies
	 * the current/proof context; this Host method owns the request and response
	 * schema checks and never grants commands or Skill reads.
	 */
	async readNativeMetadataV1(
		value: RuntimeNativeMetadataReadRequestV1,
		context: RuntimeHostNativeMetadataReadContextV1,
	): Promise<RuntimeNativeMetadataReadResponseV1> {
		this.requireLegacyHost();
		const parsed = RuntimeNativeMetadataReadRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		if (
			!context ||
			typeof context !== "object" ||
			!context.signal ||
			typeof context.assertCurrent !== "function" ||
			typeof context.revalidate !== "function" ||
			typeof context.verifyProof !== "function" ||
			!Number.isSafeInteger(context.expiresAt) ||
			typeof context.originalHostScopeRef !== "string" ||
			(context.now !== undefined && typeof context.now !== "function")
		)
			nativeMetadataReadDenied();

		const now = context.now ?? Date.now;
		const assertAuthority = (
			authority: ReturnType<
				RuntimeNativeMetadataReadContextV1["assertCurrent"]
			>,
		) => {
			if (
				!isDeepStrictEqual(authority.principal, request.scope.principal) ||
				!isDeepStrictEqual(authority.scope, {
					agentId: request.scope.agentId,
					conversationId: request.scope.conversationId,
					executionId: request.scope.executionId,
					sessionGeneration: request.scope.sessionGeneration,
				})
			)
				nativeMetadataReadDenied();
		};
		const assertContext = () => {
			this.requireLegacyHost();
			if (
				context.signal.aborted ||
				context.expiresAt !== request.expiresAt ||
				request.readStartedAt > now() ||
				request.expiresAt <= now() ||
				context.originalHostScopeRef !== request.originalHostScopeRef ||
				// The Host caller's proof/current context owns the exact
				// authorizationRevision; compare the complete scope before I/O.
				!isDeepStrictEqual(context.scope, request.scope)
			)
				nativeMetadataReadDenied();
			assertAuthority(context.assertCurrent());
		};
		const revalidateContext = async () => {
			assertContext();
			const authority = await callBoundedNativeMetadataDriver({
				read: context,
				work: () => context.revalidate(),
			});
			assertAuthority(authority);
			assertContext();
		};

		try {
			assertContext();
			await callBoundedNativeMetadataDriver({
				read: context,
				work: async () => {
					await context.verifyProof(request);
				},
			});
			await revalidateContext();
		} catch {
			nativeMetadataReadDenied();
		}

		const reader = this.options.driver.readNativeMetadataV1;
		if (!reader) driverInvalid();
		let projection: unknown;
		try {
			projection = await callBoundedNativeMetadataDriver({
				read: context,
				work: () => reader.call(this.options.driver, request.selector, context),
			});
		} catch (error) {
			if (error instanceof RuntimeHostError && error.httpStatus === 403)
				nativeMetadataReadDenied();
			throwSessionRecoveryFailure(error);
			driverInvalid();
		}
		const parsedProjection =
			NativeMetadataProjectionV1Schema.safeParse(projection);
		if (
			!parsedProjection.success ||
			parsedProjection.data.selector !== request.selector
		)
			driverInvalid();

		try {
			await revalidateContext();
		} catch {
			nativeMetadataReadDenied();
		}
		const {
			proof: _proof,
			apiRequestSourceRef: _source,
			...identity
		} = request;
		const response = RuntimeNativeMetadataReadResponseV1Schema.safeParse({
			...identity,
			projection: parsedProjection.data,
		});
		if (!response.success) driverInvalid();
		return response.data;
	}

	async skillDirectory(
		value: RuntimeSkillDirectoryRequestV1,
		verification: unknown,
		signal: AbortSignal = this.lifetime.signal,
	): Promise<RuntimeSkillDirectoryResponseV1> {
		this.requireLegacyHost();
		const request = RuntimeSkillDirectoryRequestV1Schema.parse(value);
		const claims = validateRuntimeExecutionGrant(
			request,
			"skills.read",
			verification,
			this.options.grantValidation,
		);
		const driver = (
			this.options.driver as RuntimeDriver & Partial<RuntimeNativeSkillReaderV1>
		).discoverNativeSkills;
		if (!driver) driverInvalid();
		const lease = this.nativeSkillReadContext(
			request,
			verification,
			signal,
			claims,
		);
		let raw: unknown;
		try {
			raw = await callBoundedNativeSkillDriver({
				read: lease,
				work: () => driver.call(this.options.driver, lease),
			});
			await lease.revalidate();
		} finally {
			lease.close();
		}
		if (
			!raw ||
			typeof raw !== "object" ||
			!Array.isArray((raw as { entries?: unknown }).entries) ||
			typeof (raw as { generationId?: unknown }).generationId !== "string"
		)
			driverInvalid();
		const skills = (
			raw as { entries: readonly Record<string, unknown>[] }
		).entries.map((entry) => ({
			schemaVersion: 1 as const,
			name: entry.name,
			version: entry.version,
			manifestSha256: entry.manifestDigest,
			packageDigest: entry.packageDigest,
			readOnly: true as const,
		}));
		return RuntimeSkillDirectoryResponseV1Schema.parse({
			schemaVersion: 1,
			hostSessionRef: request.hostSessionRef,
			generationId: (raw as { generationId: string }).generationId,
			skills,
		});
	}

	async readSkillResource(
		value: RuntimeSkillResourceReadRequestV1,
		verification: unknown,
		signal: AbortSignal = this.lifetime.signal,
	): Promise<RuntimeSkillResourceReadResponseV1> {
		this.requireLegacyHost();
		const request = RuntimeSkillResourceReadRequestV1Schema.parse(value);
		const claims = validateRuntimeExecutionGrant(
			request,
			"skills.read",
			verification,
			this.options.grantValidation,
		);
		const driver = (
			this.options.driver as RuntimeDriver & Partial<RuntimeNativeSkillReaderV1>
		).readNativeSkill;
		const directoryReader = (
			this.options.driver as RuntimeDriver & Partial<RuntimeNativeSkillReaderV1>
		).discoverNativeSkills;
		if (!driver || !directoryReader) driverInvalid();
		const lease = this.nativeSkillReadContext(
			request,
			verification,
			signal,
			claims,
		);
		let bytes: Uint8Array;
		try {
			const assertGeneration = async () => {
				const directory = await callBoundedNativeSkillDriver({
					read: lease,
					work: () => directoryReader.call(this.options.driver, lease),
				});
				if (
					!directory ||
					typeof directory !== "object" ||
					(directory as { generationId?: unknown }).generationId !==
						request.generationId ||
					!Array.isArray((directory as { entries?: unknown }).entries) ||
					!(
						directory as { entries: readonly { name?: unknown }[] }
					).entries.some((entry) => entry?.name === request.skillName)
				)
					driverInvalid();
			};
			await assertGeneration();
			bytes = await callBoundedNativeSkillDriver({
				read: lease,
				work: () =>
					driver.call(
						this.options.driver,
						lease,
						request.skillName,
						request.relativePath,
					),
			});
			await lease.revalidate();
			await assertGeneration();
		} finally {
			lease.close();
		}
		if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1_048_576)
			driverInvalid();
		const encoded = Buffer.from(bytes);
		return RuntimeSkillResourceReadResponseV1Schema.parse({
			schemaVersion: 1,
			hostSessionRef: request.hostSessionRef,
			generationId: request.generationId,
			skillName: request.skillName,
			relativePath: request.relativePath,
			sizeBytes: encoded.byteLength,
			sha256: createHash("sha256").update(encoded).digest("hex"),
			bytesBase64: encoded.toString("base64"),
		});
	}

	/** Read-only public model choices for an already-bound Host Session. */
	async modelDirectory(
		value: RuntimeModelDirectoryRequestV1,
		verification: unknown,
	): Promise<RuntimeModelDirectoryResponseV1> {
		this.requireLegacyHost();
		const parsed = RuntimeModelDirectoryRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"model-directory.read",
			verification,
			this.options.grantValidation,
		);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		const nativeSessionRef =
			session.nativeSessionRef ??
			nativeSessionRequired(
				`modelDirectory:${nativeSessionStateCategory(session)}`,
			);
		const directory = await callDriver(() =>
			this.options.driver.getModelDirectory(nativeSessionRef),
		);
		return RuntimeModelDirectoryResponseV1Schema.parse({
			schemaVersion: 1,
			hostSessionRef: request.hostSessionRef,
			executionId: request.executionId,
			options: directory.options.map((option) => ({
				schemaVersion: 1,
				modelOptionId: option.modelOptionId,
				modelId: option.modelId,
				displayName: option.displayName,
				reasoningLevels: [...option.reasoningLevels],
			})),
			current: directory.current,
		});
	}

	async replay(
		value: RuntimeReplayRequestV1,
		verification: unknown,
	): Promise<RuntimeReplayResponseV1> {
		this.requireLegacyHost();
		const parsed = RuntimeReplayRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"events.replay",
			verification,
			this.options.grantValidation,
		);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		const nativeSessionRef =
			session.nativeSessionRef ??
			nativeSessionRequired(`replay:${nativeSessionStateCategory(session)}`);
		const events = RuntimeEventSchema.array().safeParse(
			await callDriver(() =>
				this.options.driver.replayEvents(
					nativeSessionRef,
					request.executionId,
					request.afterCursor,
				),
			),
		);
		if (
			!events.success ||
			events.data.some((event) => event.executionId !== request.executionId)
		) {
			driverInvalid();
		}
		return {
			schemaVersion: 1,
			// The legacy replay response is still V1-only. Operation facts cross the
			// process boundary through the streaming endpoint below, whose event
			// contract preserves the versioned RuntimeEvent union.
			// #2979：思考过程同为 V2 事件，按版本过滤，不会进入 V1 replay。
			events: events.data.filter(
				(event): event is RuntimeEventV1 => event.schemaVersion === 1,
			),
		};
	}

	async streamEvents(
		value: RuntimeReplayRequestV1,
		verification: unknown,
		signal?: AbortSignal,
	) {
		this.requireLegacyHost();
		const parsed = RuntimeReplayRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"events.replay",
			verification,
			this.options.grantValidation,
		);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		const nativeSessionRef =
			session.nativeSessionRef ??
			nativeSessionRequired(
				`streamEvents:${nativeSessionStateCategory(session)}`,
			);
		const events = await callDriver(() =>
			this.options.driver.subscribeEvents(
				nativeSessionRef,
				request.executionId,
				request.afterCursor,
				signal,
			),
		);
		const store = this.options.store;
		return (async function* () {
			for await (const event of validatedDriverEventStream(
				events,
				request.executionId,
			)) {
				store.getSessionForQuery(
					request.hostSessionRef,
					request,
					request.deliveryFence,
				);
				yield event;
			}
		})();
	}

	async supplement(
		value: RuntimeSupplementRequestV1,
		verification: unknown,
	): Promise<RuntimeOperationResponseV1> {
		this.requireLegacyBusiness();
		const parsed = RuntimeSupplementRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"turn.supplement",
			verification,
			this.options.grantValidation,
		);
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const prepared = await this.options.store.prepareOperation({
					requestedHostSessionRef: request.hostSessionRef,
					binding: request,
					operationId: request.messageId,
					kind: "supplement",
					scope: `message:${request.messageId}`,
					deliveryFence: request.deliveryFence,
					executionDeliveryFence: request.executionDeliveryFence,
					requestDigest: requestDigest({
						kind: "supplement",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						messageId: request.messageId,
						input: request.input,
					}),
					command: (nativeSessionRef) => ({
						schemaVersion: 1,
						kind: "supplement",
						operationId: request.messageId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						nativeSessionRef:
							nativeSessionRef ?? nativeSessionRequired("supplement:unbound"),
						input: request.input,
					}),
				});
				return v1OperationResponse(
					await this.dispatch(request.hostSessionRef, prepared.operation),
				);
			},
		);
	}

	async stop(
		value: RuntimeStopRequestV1,
		verification: unknown,
	): Promise<RuntimeOperationResponseV1> {
		this.requireLegacyHost();
		const parsed = RuntimeStopRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"turn.stop",
			verification,
			this.options.grantValidation,
		);
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const prepared = await this.options.store.prepareOperation({
					requestedHostSessionRef: request.hostSessionRef,
					binding: request,
					operationId: request.stopRequestId,
					kind: "stop",
					scope: `stop:${request.stopRequestId}`,
					deliveryFence: request.deliveryFence,
					executionDeliveryFence: request.executionDeliveryFence,
					requestDigest: requestDigest({
						kind: "stop",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						stopRequestId: request.stopRequestId,
					}),
					command: (nativeSessionRef) => ({
						schemaVersion: 1,
						kind: "stop",
						operationId: request.stopRequestId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						nativeSessionRef:
							nativeSessionRef ?? nativeSessionRequired("stop:unbound"),
					}),
				});
				return v1OperationResponse(
					await this.dispatch(request.hostSessionRef, prepared.operation),
				);
			},
		);
	}

	async cancelGeneration(
		value: RuntimeGenerationCancelRequestV1,
		verification: unknown,
	): Promise<RuntimeOperationResponseV1> {
		this.requireLegacyHost();
		const parsed = RuntimeGenerationCancelRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"generation.cancel",
			verification,
			this.options.grantValidation,
		);
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const prepared = await this.options.store.prepareOperation({
					requestedHostSessionRef: request.hostSessionRef,
					binding: request,
					operationId: request.tombstoneId,
					kind: "generation-cancel",
					scope: `generation:${request.sessionGeneration}`,
					deliveryFence: request.deliveryFence,
					requestDigest: requestDigest({
						kind: "generation-cancel",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						tombstoneId: request.tombstoneId,
					}),
					command: (nativeSessionRef) => ({
						schemaVersion: 1,
						kind: "generation-cancel",
						operationId: request.tombstoneId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						nativeSessionRef:
							nativeSessionRef ??
							nativeSessionRequired("cancelGeneration:unbound"),
					}),
				});
				await this.options.store.activateGenerationBarrier(
					request.hostSessionRef,
					request,
					request.tombstoneId,
				);
				const response = await this.dispatch(
					request.hostSessionRef,
					prepared.operation,
				);
				if (
					response.result.outcome === "accepted" &&
					isTerminalRuntimeStatus(response.result.status)
				) {
					await this.options.store.confirmGenerationBarrier(
						request.hostSessionRef,
						request.tombstoneId,
					);
					await this.options.store.clearRecoveryBlocked(request.hostSessionRef);
				}
				return v1OperationResponse(response);
			},
		);
	}

	private clearFinishedExecutionKey(
		operation: StoredOperation,
		result: RuntimeOperationResponse["result"],
	) {
		if (operation.kind !== "submit-turn" && operation.kind !== "native-command")
			return;
		if (
			(result.outcome === "accepted" &&
				isTerminalRuntimeStatus(result.status)) ||
			result.outcome === "busy" ||
			result.outcome === "rejected"
		)
			this.executionKeys.delete(operation.executionId);
	}

	private async finalizeEventExecutionKey(
		hostSessionRef: string,
		executionId: string,
	) {
		const entry = this.executionKeys.get(executionId);
		if (!entry || entry.hostSessionRef !== hostSessionRef) return;
		const original = this.options.store.readOriginalExecutionKeyScopeV4(
			entry.scope,
		);
		if (
			!original?.scope ||
			original.hostSessionRef !== hostSessionRef ||
			!isDeepStrictEqual(original.scope, entry.scope)
		)
			runtimeAuthorizationDenied();
		// Read the original Driver status/operation and persist its trusted terminal result.
		// Business execution is disabled: missing or unknown evidence cannot dispatch a Turn.
		await this.dispatch(hostSessionRef, original.operation, false);
	}

	private async dispatch(
		hostSessionRef: string,
		operation: StoredOperation,
		allowBusinessExecution = true,
		context?: RuntimeDriverExecutionContextV1,
	): Promise<RuntimeOperationResponse> {
		if (
			operation.state === "resolved" &&
			operation.result &&
			operation.result.outcome !== "unknown"
		) {
			let result: RuntimeOperationResponse["result"] = operation.result;
			if (result.outcome === "accepted" && result.status === "running") {
				const nativeSessionRef =
					this.options.store.nativeSessionRef(hostSessionRef) ??
					nativeSessionRequired("dispatch:running_unbound");
				result = await this.currentDriverResult(
					{ nativeSessionRef, result },
					operation,
				);
				if (isInterruption(operation) && result.outcome === "unknown") {
					return unknownOperationResponse(hostSessionRef, operation);
				}
				await this.options.store.resolveOperation(
					hostSessionRef,
					operation.operationId,
					result,
					nativeSessionRef,
				);
			}
			this.clearFinishedExecutionKey(operation, result);
			return operationResponse(hostSessionRef, operation, result);
		}
		await this.options.afterOperationPrepared?.(operation.operationId);
		const rawLookup = await callDriverWithUncertainty(() =>
			this.options.driver.lookupOperation(operation.command),
		);
		if (rawLookup === driverUncertain) {
			if (isInterruption(operation)) {
				return unknownOperationResponse(hostSessionRef, operation);
			}
			driverInvalid();
		}
		const lookup = parseDriverLookup(
			rawLookup,
			operation,
			this.options.store.nativeSessionRef(hostSessionRef),
		);
		if (lookup.state === "unknown") {
			if (isInterruption(operation)) {
				return unknownOperationResponse(hostSessionRef, operation);
			}
			const result = acceptanceUnknown();
			await this.options.store.resolveOperation(
				hostSessionRef,
				operation.operationId,
				result,
			);
			return operationResponse(hostSessionRef, operation, result);
		}
		let rawDriverRecord: Awaited<ReturnType<RuntimeDriver["execute"]>>;
		if (lookup.state === "found") {
			rawDriverRecord = lookup.record;
		} else {
			// Unknown acceptance remains queryable, but missing evidence cannot
			// turn a later lookup into a second business execution.
			if (
				(!allowBusinessExecution || operation.result?.outcome === "unknown") &&
				!isInterruption(operation)
			)
				return unknownOperationResponse(hostSessionRef, operation);
			if (this.v3 && !isInterruption(operation))
				await this.options.store.authorizePreparedOperation(
					hostSessionRef,
					operation,
					(this.options.grantValidationV2?.now ?? Date.now)(),
				);
			const recordResultFile = this.options.driver.recordResultFile?.bind(
				this.options.driver,
			);
			const originalFileBridge = context?.fileBridge;
			const readNativeTextInput = (
				originalFileBridge as
					| (RuntimeFileBridgePortV1 & Partial<RuntimeNativeTextInputPortV1>)
					| undefined
			)?.readNativeTextInput;
			const driverContext =
				originalFileBridge && recordResultFile
					? {
							...context,
							fileBridge: {
								// The result-recording wrapper must keep the V5 text-input
								// method on the same object the Driver receives.
								...(readNativeTextInput
									? {
											readNativeTextInput:
												readNativeTextInput.bind(originalFileBridge),
										}
									: {}),
								readInput(fileId: string, signal?: AbortSignal) {
									return originalFileBridge.readInput(fileId, signal);
								},
								revalidate() {
									originalFileBridge.revalidate();
								},
								async writeResult(
									descriptor: Parameters<
										RuntimeFileBridgePortV1["writeResult"]
									>[0],
									body: Parameters<RuntimeFileBridgePortV1["writeResult"]>[1],
									options?: Parameters<
										RuntimeFileBridgePortV1["writeResult"]
									>[2],
								) {
									const result = await originalFileBridge.writeResult(
										descriptor,
										body,
										options,
									);
									try {
										await recordResultFile(operation.command, result);
									} catch (error) {
										// #3226：平台已确认对象但本地记账失败，结果只能是 unknown。
										throw new RuntimeFileResultUnconfirmedError({
											cause: error,
										});
									}
									return result;
								},
							},
						}
					: context;
			const admittedBrowser = runtimeBrowserExecutionContextForCommand(
				this.browserExecutionContext,
				operation.command,
			);
			const browser = await createBrowserExecutionContextForCommand(
				this.options.createBrowserExecutionContext,
				admittedBrowser,
				operation.command.executionId,
				operation.keyScopeV4?.principal,
			);
			const executionContext = browser
				? { ...(driverContext ?? {}), browser }
				: driverContext;
			const executed = await callDriverExecute(() =>
				this.options.driver.execute(operation.command, executionContext),
			);
			if (executed === driverFileInputRejected)
				return this.resolveFileInputRejection(hostSessionRef, operation);
			if (executed === driverUncertain) {
				if (isInterruption(operation)) {
					return unknownOperationResponse(hostSessionRef, operation);
				}
				driverInvalid();
			}
			rawDriverRecord = executed;
		}
		const driverRecord = parseDriverRecord(
			rawDriverRecord,
			operation,
			this.options.store.nativeSessionRef(hostSessionRef),
		);
		if (
			operation.kind === "submit-turn" &&
			driverRecord.result.outcome === "accepted" &&
			driverRecord.result.status === "running" &&
			!this.options.store.nativeSessionRef(hostSessionRef)
		) {
			// Status observation can admit the first model request. Bind its
			// validated native receipt before that request crosses Host authority.
			await this.options.store.resolveOperation(
				hostSessionRef,
				operation.operationId,
				driverRecord.result,
				driverRecord.nativeSessionRef,
			);
		}
		await this.options.afterDriverResult?.(operation.operationId);
		const result = await this.currentDriverResult(driverRecord, operation);
		if (isInterruption(operation) && result.outcome === "unknown") {
			return unknownOperationResponse(hostSessionRef, operation);
		}
		await this.options.store.resolveOperation(
			hostSessionRef,
			operation.operationId,
			result,
			driverRecord.nativeSessionRef,
		);
		this.clearFinishedExecutionKey(operation, result);
		await this.options.afterOperationResolved?.(operation.operationId);
		return operationResponse(hostSessionRef, operation, result);
	}

	/**
	 * #3314：Driver 声明附件读取在任何原生副作用之前被平台明确拒绝。Host 先按同一操作只读
	 * 核实 Driver 没有该操作的记录，再把不可重试的 rejected 与该操作持久化，重放直接返回原
	 * 结果。只有 submit V2 及以上的结果枚举包含该成员；其他操作、或 Driver 已有记录、查询
	 * 不确定时都无法排除副作用，仍按原有的可重试失败处理，不推断为失败。
	 */
	private async resolveFileInputRejection(
		hostSessionRef: string,
		operation: StoredOperation,
	): Promise<RuntimeOperationResponse> {
		if (
			operation.kind !== "submit-turn" ||
			operation.command.schemaVersion !== 2
		)
			driverInvalid();
		const lookup = await callDriverWithUncertainty(() =>
			this.options.driver.lookupOperation(operation.command),
		);
		if (
			lookup === driverUncertain ||
			parseDriverLookup(
				lookup,
				operation,
				this.options.store.nativeSessionRef(hostSessionRef),
			).state !== "missing"
		)
			driverInvalid();
		await this.options.afterDriverResult?.(operation.operationId);
		const result = fileInputRejected();
		await this.options.store.resolveOperation(
			hostSessionRef,
			operation.operationId,
			result,
		);
		this.clearFinishedExecutionKey(operation, result);
		await this.options.afterOperationResolved?.(operation.operationId);
		return operationResponse(hostSessionRef, operation, result);
	}

	private async recoverOperations() {
		const attemptedSessions = new Set<string>();
		const blockedSessions = new Set<string>();
		for (const {
			session,
			operation,
		} of this.options.store.listRecoverableOperations()) {
			if (blockedSessions.has(session.hostSessionRef)) continue;
			attemptedSessions.add(session.hostSessionRef);
			try {
				await this.serialize(session.hostSessionRef, async () => {
					let recoveredResult: RuntimeOperationResponse["result"];
					if (operation.kind === "generation-cancel") {
						await this.options.store.activateGenerationBarrier(
							session.hostSessionRef,
							session,
							operation.operationId,
						);
					}
					// V3 native recovery needs a current query/control Grant. Even
					// interruption lookup can query or stop native sources, so defer it.
					if (this.v3 && isInterruption(operation)) return;
					if (operation.state === "prepared" && !this.v3) {
						recoveredResult = (
							await this.dispatch(session.hostSessionRef, operation, !this.v3)
						).result;
					} else {
						const lookup = parseDriverLookup(
							await callDriver(() =>
								this.options.driver.lookupOperation(operation.command),
							),
							operation,
							session.nativeSessionRef,
						);
						if (lookup.state === "found") {
							recoveredResult = this.v3
								? lookup.record.result
								: await this.currentDriverResult(lookup.record, operation);
							if (
								!isInterruption(operation) ||
								recoveredResult.outcome !== "unknown"
							) {
								await this.options.store.resolveOperation(
									session.hostSessionRef,
									operation.operationId,
									recoveredResult,
									lookup.record.nativeSessionRef,
								);
							}
						} else {
							recoveredResult = acceptanceUnknown();
							if (!isInterruption(operation)) {
								await this.options.store.resolveOperation(
									session.hostSessionRef,
									operation.operationId,
									recoveredResult,
								);
							}
						}
					}
					this.clearFinishedExecutionKey(operation, recoveredResult);
					if (
						operation.kind === "generation-cancel" &&
						recoveredResult.outcome === "accepted" &&
						isTerminalRuntimeStatus(recoveredResult.status)
					) {
						await this.options.store.confirmGenerationBarrier(
							session.hostSessionRef,
							operation.operationId,
						);
					}
				});
			} catch {
				await this.options.store.markRecoveryBlocked(
					session.hostSessionRef,
					operation.operationId,
				);
				blockedSessions.add(session.hostSessionRef);
			}
		}
		for (const hostSessionRef of attemptedSessions) {
			if (!blockedSessions.has(hostSessionRef)) {
				await this.options.store.clearRecoveryBlocked(hostSessionRef);
			}
		}
	}

	private async currentDriverResult(
		record: Pick<
			Awaited<ReturnType<RuntimeDriver["execute"]>>,
			"nativeSessionRef" | "result"
		>,
		operation: Pick<StoredOperation, "executionId" | "kind">,
	) {
		if (record.result.outcome !== "accepted") {
			return record.result;
		}
		if (operation.kind === "native-command") return record.result;
		// A terminal generation-cancel receipt proves the durable barrier completed.
		// The original Turn may remain unknown or unreadable after native Session loss.
		if (
			operation.kind === "generation-cancel" &&
			isTerminalRuntimeStatus(record.result.status)
		) {
			return record.result;
		}
		const rawStatus = await callDriverWithUncertainty(() =>
			this.options.driver.getStatus(
				record.nativeSessionRef,
				operation.executionId,
			),
		);
		if (rawStatus === driverUncertain) {
			if (isInterruption(operation)) return acceptanceUnknown();
			driverInvalid();
		}
		const status = RuntimeStatusV1Schema.safeParse(rawStatus);
		if (!status.success) driverInvalid();
		return {
			outcome: "accepted" as const,
			status: status.data,
		};
	}

	private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const result = previous.then(work, work);
		const completion = result.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(key, completion);
		return result.finally(() => {
			if (this.queues.get(key) === completion) this.queues.delete(key);
		});
	}
}
