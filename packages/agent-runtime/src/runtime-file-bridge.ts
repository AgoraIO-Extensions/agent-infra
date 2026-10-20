import { createHash } from "node:crypto";
import {
	type FileDescriptorV1,
	FileProjectionV1Schema,
} from "@agent-infra/contracts/files";
import {
	type RuntimeBusinessGrantClaimsV4,
	RuntimeBusinessGrantClaimsV4Schema,
	type RuntimeBusinessRequestV4,
	type RuntimeNativeCapabilityRequestV5,
	RuntimeNativeCapabilityRequestV5Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSupplementRequestV4Schema,
	validateRuntimeBusinessBindingV4,
	validateRuntimeBusinessBindingV5,
} from "@agent-infra/contracts/runtime";

export type RuntimeFileResultV1 = ReturnType<
	typeof FileProjectionV1Schema.parse
>;

/**
 * A confirmed result projection tied to the request-local bridge that produced
 * it. The binding is kept in a private WeakMap so a plain projection, or a
 * copied/edited receipt, cannot be accepted by the Driver.
 */
export interface RuntimeFileResultReceiptV1 {
	readonly projection: RuntimeFileResultV1;
}

type RuntimeFileResultReceiptMetadataV1 = Readonly<{
	binding: RuntimeFileBridgeBindingV1;
	projection: RuntimeFileResultV1;
}>;

const runtimeFileResultReceipts = new WeakMap<
	object,
	RuntimeFileResultReceiptMetadataV1
>();

/**
 * Request-local file authority for one RuntimeHost operation.
 *
 * It intentionally contains references and binding facts only.  File Grant
 * tokens, object bytes and temporary paths stay inside the injected authority.
 */
export interface RuntimeFileBridgeBindingV1 {
	readonly actorId: string;
	readonly channelId: string;
	readonly agentId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly grantId: string;
	readonly expiresAt: number;
	readonly inputFileIds: readonly string[];
}

export type RuntimeFileBridgeOperationV1 = "read" | "write";

/**
 * Server-resolved facts for one admitted Native V5 Skill text input.
 *
 * The values come from the Request and its verified V4 business Grant; the
 * browser never supplies them. They are intentionally duplicated here (rather
 * than imported from the wire) so the Driver port stays independent of the
 * Worker -> Host transport shape.
 */
export interface RuntimeNativeTextInputV1 {
	readonly attachmentId: string;
	readonly sha256: string;
	readonly byteLength: number;
	readonly mediaType: "text/plain";
}

/**
 * Narrow Host -> Driver port for the exact ordered Native V5 text input set.
 *
 * The Driver may read only the admitted attachment ids, in any order it
 * needs, but each read is bounded by the admitted byte length and verified
 * against the admitted SHA-256 before any bytes are returned. Implementations
 * land with the Driver (P4); a Driver that does not declare
 * {@link RuntimeNativeTextInputDriverV1} must never receive this port.
 */
export interface RuntimeNativeTextInputPortV1 {
	readonly schemaVersion: 1;
	readonly inputs: readonly RuntimeNativeTextInputV1[];
	read(
		input: RuntimeNativeTextInputV1,
		signal?: AbortSignal,
	): Promise<Uint8Array>;
	revalidate(): void;
}

/**
 * Driver declaration required before the Host exposes
 * {@link RuntimeNativeTextInputPortV1}. The field is additive and fails closed:
 * a Driver without it cannot execute a Native V5 Skill with attachments.
 */
export interface RuntimeNativeTextInputDriverV1 {
	readonly nativeTextInputs?: { readonly schemaVersion: 1 };
}

/** Execution context extension consumed by a text-input-aware Driver. */
export interface RuntimeNativeTextInputExecutionContextV1 {
	readonly nativeTextInput?: RuntimeNativeTextInputPortV1;
}

/**
 * Synthetic `fileId` for the operation-local write context. The authority
 * allocates the real result object, so no file id exists before a result is
 * confirmed.
 */
export const RUNTIME_FILE_BRIDGE_RESULT_FILE_ID_V1 = "result";

/**
 * Per-call context passed to deployment-owned callbacks. It is deliberately
 * separate from the binding so the operation and file id cannot be confused
 * with the execution-wide facts.
 */
export interface RuntimeFileBridgeContextV1 extends RuntimeFileBridgeBindingV1 {
	readonly fileId: string;
	readonly operation: RuntimeFileBridgeOperationV1;
}

export interface RuntimeFileInputV1 {
	readonly fileId: string;
	readonly descriptor: FileDescriptorV1;
	readonly body: ReadableStream<Uint8Array>;
}

export interface RuntimeFileBridgePortV1 {
	readInput(fileId: string, signal?: AbortSignal): Promise<RuntimeFileInputV1>;
	writeResult(
		descriptor: FileDescriptorV1,
		body: ReadableStream<Uint8Array>,
	): Promise<RuntimeFileResultReceiptV1>;
	/**
	 * Re-checks the current Session/Execution authority before bytes that were
	 * already read cross into a native side effect.
	 */
	revalidate(): void;
}

function freezeProjection(value: RuntimeFileResultV1): RuntimeFileResultV1 {
	const projection = FileProjectionV1Schema.parse(value);
	return Object.freeze({
		...projection,
		descriptor: Object.freeze({ ...projection.descriptor }),
	});
}

/** Creates a bridge-owned result receipt after the authority confirms a projection. */
/** Adapter-only constructor for a confirmed projection; metadata remains private and frozen. */
export function createRuntimeFileResultReceiptV1(
	binding: RuntimeFileBridgeBindingV1,
	projection: RuntimeFileResultV1,
): RuntimeFileResultReceiptV1 {
	assertBinding(binding);
	const frozenBinding = Object.freeze({
		...binding,
		inputFileIds: Object.freeze([...binding.inputFileIds]),
	});
	const frozenProjection = freezeProjection(projection);
	const receipt = Object.freeze({ projection: frozenProjection });
	runtimeFileResultReceipts.set(
		receipt,
		Object.freeze({
			binding: frozenBinding,
			projection: frozenProjection,
		}),
	);
	return receipt;
}

/** Reads the private bridge metadata and rejects copied or forged receipts. */
export function readRuntimeFileResultReceiptV1(
	value: RuntimeFileResultReceiptV1,
): RuntimeFileResultReceiptMetadataV1 {
	if (!value || typeof value !== "object")
		throw new TypeError("RUNTIME_FILE_RESULT_RECEIPT_INVALID");
	const metadata = runtimeFileResultReceipts.get(value);
	if (!metadata || value.projection !== metadata.projection)
		throw new TypeError("RUNTIME_FILE_RESULT_RECEIPT_INVALID");
	return metadata;
}

/** Creates a port bound to exactly one validated Runtime business request. */
export type RuntimeFileBridgeFactoryV1 = (
	binding: RuntimeFileBridgeBindingV1,
) => RuntimeFileBridgePortV1;

type RuntimeFileBridgeBindingKey = keyof RuntimeFileBridgeBindingV1;
const bindingKeys: readonly RuntimeFileBridgeBindingKey[] = [
	"actorId",
	"channelId",
	"agentId",
	"conversationId",
	"executionId",
	"sessionGeneration",
	"grantId",
	"expiresAt",
	"inputFileIds",
];
const contextKeys = new Set([...bindingKeys, "fileId", "operation"]);

function invalidBinding(): never {
	throw new TypeError("RUNTIME_FILE_BRIDGE_BINDING_INVALID");
}

/** Bounds waiting for an upstream cancel so a refused body cannot hold the port. */
const bodyCancelTimeoutMs = 1_000;

/** Reads the body of authority output without trusting its shape. */
function resultBody(value: unknown): ReadableStream<Uint8Array> | undefined {
	const body = (value as { body?: unknown } | undefined)?.body;
	return typeof (body as ReadableStream<Uint8Array> | undefined)?.getReader ===
		"function"
		? (body as ReadableStream<Uint8Array>)
		: undefined;
}

/**
 * Cancels a body the port refuses to hand back, under bounded waiting so a
 * never-settling source cannot keep the exchange open.
 */
async function cancelBody(body: ReadableStream<Uint8Array> | undefined) {
	if (!body) return;
	const reader = body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			reader.cancel().then(
				() => undefined,
				() => undefined,
			),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, bodyCancelTimeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}

function invalidContext(): never {
	throw new TypeError("RUNTIME_FILE_BRIDGE_CONTEXT_INVALID");
}

function assertId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function assertBinding(
	value: RuntimeFileBridgeBindingV1,
	allowContextKeys = false,
): void {
	if (
		!value ||
		Object.keys(value).some((key) =>
			allowContextKeys
				? !contextKeys.has(key)
				: !bindingKeys.includes(key as RuntimeFileBridgeBindingKey),
		) ||
		!assertId(value.actorId) ||
		!assertId(value.channelId) ||
		!assertId(value.agentId) ||
		!assertId(value.conversationId) ||
		!assertId(value.executionId) ||
		!assertId(value.grantId) ||
		!Number.isSafeInteger(value.sessionGeneration) ||
		value.sessionGeneration < 1 ||
		!Number.isSafeInteger(value.expiresAt) ||
		value.expiresAt < 1 ||
		!Array.isArray(value.inputFileIds) ||
		new Set(value.inputFileIds).size !== value.inputFileIds.length ||
		value.inputFileIds.some((fileId) => !assertId(fileId))
	)
		invalidBinding();
}

export function assertRuntimeFileBridgeContextV1(
	value: RuntimeFileBridgeContextV1,
	expectedOperation?: RuntimeFileBridgeOperationV1,
): asserts value is RuntimeFileBridgeContextV1 {
	if (
		!value ||
		Object.keys(value).some((key) => !contextKeys.has(key)) ||
		Object.keys(value).length !== contextKeys.size
	)
		invalidContext();
	assertBinding(value, true);
	if (
		!assertId(value.fileId) ||
		(value.operation !== "read" && value.operation !== "write") ||
		(expectedOperation !== undefined && value.operation !== expectedOperation)
	)
		invalidContext();
	// The operation decides which file identifiers are reachable. A read may only
	// name a signed input, and a write may only name the synthetic result id.
	if (
		(value.operation === "read" &&
			!value.inputFileIds.includes(value.fileId)) ||
		(value.operation === "write" &&
			value.fileId !== RUNTIME_FILE_BRIDGE_RESULT_FILE_ID_V1)
	)
		invalidContext();
}

/** Compare a callback context with the immutable binding admitted for a request. */
export function assertRuntimeFileBridgeContextMatchesV1(
	expected: RuntimeFileBridgeBindingV1,
	actual: RuntimeFileBridgeContextV1,
	expectedOperation?: RuntimeFileBridgeOperationV1,
): asserts actual is RuntimeFileBridgeContextV1 {
	assertBinding(expected);
	assertRuntimeFileBridgeContextV1(actual, expectedOperation);
	if (
		actual.actorId !== expected.actorId ||
		actual.channelId !== expected.channelId ||
		actual.agentId !== expected.agentId ||
		actual.conversationId !== expected.conversationId ||
		actual.executionId !== expected.executionId ||
		actual.sessionGeneration !== expected.sessionGeneration ||
		actual.grantId !== expected.grantId ||
		actual.expiresAt !== expected.expiresAt ||
		actual.inputFileIds.length !== expected.inputFileIds.length ||
		actual.inputFileIds.some(
			(fileId, index) => fileId !== expected.inputFileIds[index],
		)
	)
		invalidContext();
}

function context(
	binding: RuntimeFileBridgeBindingV1,
	fileId: string,
	operation: RuntimeFileBridgeOperationV1,
): RuntimeFileBridgeContextV1 {
	const value = Object.freeze({ ...binding, fileId, operation });
	assertRuntimeFileBridgeContextV1(value, operation);
	return value;
}

/**
 * Builds an ephemeral bridge binding after the existing Runtime Grant checks.
 * This does not verify a signature and does not issue a File Grant; callers
 * must invoke it only with claims returned by the Runtime Grant validator.
 */
export async function createRuntimeFileBridgeBindingV1(input: {
	readonly request: RuntimeBusinessRequestV4;
	readonly claims: RuntimeBusinessGrantClaimsV4;
	readonly now?: number;
}): Promise<RuntimeFileBridgeBindingV1> {
	const request =
		"selection" in input.request
			? RuntimeSubmitTurnRequestV4Schema.parse(input.request)
			: RuntimeSupplementRequestV4Schema.parse(input.request);
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse(input.claims);
	await validateRuntimeBusinessBindingV4(request, claims);
	const now = input.now ?? Date.now();
	if (!Number.isSafeInteger(now) || claims.expiresAt <= now) invalidBinding();
	const binding = {
		actorId: request.principal.id,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		sessionGeneration: request.sessionGeneration,
		grantId: claims.grantId,
		expiresAt: claims.expiresAt,
		inputFileIds: Object.freeze(
			claims.attachments.map((attachment) => attachment.attachmentId),
		),
	} satisfies RuntimeFileBridgeBindingV1;
	assertBinding(binding);
	return Object.freeze(binding);
}

/**
 * Builds the ephemeral V5 binding for the exact ordered attachment set.
 * The verified V4 business Grant must list the same ids in the same order;
 * `validateRuntimeBusinessBindingV5` rejects a reorder, extra or missing file.
 */
export async function createRuntimeNativeTextInputBindingV5(input: {
	readonly request: RuntimeNativeCapabilityRequestV5;
	readonly claims: RuntimeBusinessGrantClaimsV4;
	readonly now?: number;
}): Promise<{
	readonly binding: RuntimeFileBridgeBindingV1;
	readonly inputs: readonly RuntimeNativeTextInputV1[];
}> {
	const request = RuntimeNativeCapabilityRequestV5Schema.parse(input.request);
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse(input.claims);
	await validateRuntimeBusinessBindingV5(request, claims);
	const now = input.now ?? Date.now();
	if (!Number.isSafeInteger(now) || claims.expiresAt <= now) invalidBinding();
	const inputs = Object.freeze(
		request.attachments.map((attachment) =>
			Object.freeze({
				attachmentId: attachment.attachmentId,
				sha256: attachment.sha256,
				byteLength: attachment.byteLength,
				mediaType: attachment.mediaType,
			} satisfies RuntimeNativeTextInputV1),
		),
	);
	const binding = {
		actorId: request.principal.id,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		sessionGeneration: request.sessionGeneration,
		grantId: claims.grantId,
		expiresAt: claims.expiresAt,
		inputFileIds: Object.freeze(
			inputs.map((attachment) => attachment.attachmentId),
		),
	} satisfies RuntimeFileBridgeBindingV1;
	assertBinding(binding);
	return { binding: Object.freeze(binding), inputs };
}

/**
 * Binds one admitted V5 input set to the request-local FileBridge. Reading is
 * exact: unknown ids, reordered facts, more/fewer bytes, a digest mismatch or a
 * lapsed authority fail before the Driver can use any byte.
 */
export function createRuntimeNativeTextInputPortV1(input: {
	readonly binding: RuntimeFileBridgeBindingV1;
	readonly inputs: readonly RuntimeNativeTextInputV1[];
	readonly bridge: RuntimeFileBridgePortV1;
	readonly now?: () => number;
}): RuntimeNativeTextInputPortV1 {
	assertBinding(input.binding);
	const now = input.now ?? Date.now;
	if (
		!Array.isArray(input.inputs) ||
		input.inputs.length < 1 ||
		input.inputs.length > 4 ||
		new Set(input.inputs.map(({ attachmentId }) => attachmentId)).size !==
			input.inputs.length ||
		input.inputs.length !== input.binding.inputFileIds.length ||
		input.inputs.some(
			(entry, index) =>
				entry.attachmentId !== input.binding.inputFileIds[index] ||
				typeof entry.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/u.test(entry.sha256) ||
				!Number.isSafeInteger(entry.byteLength) ||
				entry.byteLength < 0 ||
				entry.byteLength > 4096 ||
				entry.mediaType !== "text/plain",
		)
	)
		invalidBinding();
	const inputs = Object.freeze(
		input.inputs.map((entry) => Object.freeze({ ...entry })),
	);
	function assertLive(): void {
		if (now() >= input.binding.expiresAt) invalidBinding();
		input.bridge.revalidate();
	}
	return {
		schemaVersion: 1,
		inputs,
		async read(entry, signal) {
			if (signal?.aborted) throw new Error("RUNTIME_FILE_INPUT_ABORTED");
			const admitted = inputs.find(
				(candidate) => candidate.attachmentId === entry.attachmentId,
			);
			if (!admitted || admitted.sha256 !== entry.sha256)
				throw new Error("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
			assertLive();
			const result = await input.bridge.readInput(
				admitted.attachmentId,
				signal,
			);
			const bytes = await readBoundedInput(result.body, admitted.byteLength);
			assertLive();
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (
				digest !== admitted.sha256 ||
				bytes.byteLength !== admitted.byteLength
			)
				throw new Error("RUNTIME_FILE_INPUT_INVALID");
			return bytes;
		},
		revalidate() {
			assertLive();
		},
	};
}

async function readBoundedInput(
	body: ReadableStream<Uint8Array>,
	limit: number,
): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			if (!(next.value instanceof Uint8Array))
				throw new Error("RUNTIME_FILE_INPUT_INVALID");
			total += next.value.byteLength;
			if (total > limit) throw new Error("RUNTIME_FILE_INPUT_INVALID");
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	if (total !== limit) throw new Error("RUNTIME_FILE_INPUT_INVALID");
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Wraps deployment-owned file authority callbacks with request-local checks.
 * No callback is invoked after expiry or for an attachment outside the signed
 * Runtime Grant.  The wrapper itself never persists bytes or credentials.
 */
export function createRuntimeFileBridgeV1(options: {
	readonly binding: RuntimeFileBridgeBindingV1;
	readonly readInput: (
		context: RuntimeFileBridgeContextV1,
		/** Aborted when the caller stops waiting for this exchange. */
		signal?: AbortSignal,
	) => Promise<RuntimeFileInputV1>;
	readonly writeResult: (
		descriptor: FileDescriptorV1,
		body: ReadableStream<Uint8Array>,
		context: RuntimeFileBridgeContextV1,
	) => Promise<RuntimeFileResultV1>;
	readonly now?: () => number;
	readonly isRevoked?: (binding: RuntimeFileBridgeBindingV1) => boolean;
	/** Re-checks current Session/Execution authority before each transfer. */
	readonly isCurrent?: (binding: RuntimeFileBridgeBindingV1) => boolean;
}): RuntimeFileBridgePortV1 {
	assertBinding(options.binding);
	if (
		typeof options.readInput !== "function" ||
		typeof options.writeResult !== "function" ||
		typeof options.isRevoked !== "function" ||
		typeof options.isCurrent !== "function"
	)
		throw new TypeError("RUNTIME_FILE_BRIDGE_AUTHORITY_REQUIRED");
	const isRevoked = options.isRevoked;
	const isCurrent = options.isCurrent;
	const binding = Object.freeze({
		...options.binding,
		inputFileIds: Object.freeze([...options.binding.inputFileIds]),
	});
	const now = options.now ?? Date.now;
	const inputFileIds = new Set(binding.inputFileIds);
	function assertLive(): void {
		const current = now();
		if (!Number.isSafeInteger(current) || current >= binding.expiresAt)
			throw new Error("RUNTIME_FILE_BRIDGE_CONTEXT_EXPIRED");
		if (isRevoked(binding) === true)
			throw new Error("RUNTIME_FILE_BRIDGE_CONTEXT_REVOKED");
		if (!isCurrent(binding))
			throw new Error("RUNTIME_FILE_BRIDGE_CONTEXT_STALE");
	}
	return {
		async readInput(fileId: string, signal?: AbortSignal) {
			assertLive();
			if (!assertId(fileId) || !inputFileIds.has(fileId))
				throw new Error("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
			// A caller that already stopped waiting must not reach the authority.
			if (signal?.aborted) throw new Error("RUNTIME_FILE_INPUT_ABORTED");
			const result = await options.readInput(
				context(binding, fileId, "read"),
				signal,
			);
			try {
				// Authority can lapse while the exchange is in flight; its body must not
				// stay live, and a mismatched binding is refused the same way.
				assertLive();
				if (result.fileId !== fileId) invalidBinding();
			} catch (error) {
				await cancelBody(resultBody(result));
				throw error;
			}
			return result;
		},
		revalidate() {
			assertLive();
		},
		async writeResult(descriptor, body) {
			assertLive();
			const projection = await options.writeResult(
				descriptor,
				body,
				// The execution binding carries the unique result owner; no file id exists
				// until the authority allocates the confirmed result object.
				context(binding, RUNTIME_FILE_BRIDGE_RESULT_FILE_ID_V1, "write"),
			);
			assertLive();
			return createRuntimeFileResultReceiptV1(binding, projection);
		},
	};
}
