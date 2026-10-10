import type {
	FileDescriptorV1,
	FileProjectionV1Schema,
} from "@agent-infra/contracts/files";
import {
	type RuntimeBusinessGrantClaimsV4,
	RuntimeBusinessGrantClaimsV4Schema,
	type RuntimeBusinessRequestV4,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSupplementRequestV4Schema,
	validateRuntimeBusinessBindingV4,
} from "@agent-infra/contracts/runtime";

export type RuntimeFileResultV1 = ReturnType<
	typeof FileProjectionV1Schema.parse
>;

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
	readInput(fileId: string): Promise<RuntimeFileInputV1>;
	writeResult(
		descriptor: FileDescriptorV1,
		body: ReadableStream<Uint8Array>,
	): Promise<RuntimeFileResultV1>;
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
 * Wraps deployment-owned file authority callbacks with request-local checks.
 * No callback is invoked after expiry or for an attachment outside the signed
 * Runtime Grant.  The wrapper itself never persists bytes or credentials.
 */
export function createRuntimeFileBridgeV1(options: {
	readonly binding: RuntimeFileBridgeBindingV1;
	readonly readInput: (
		context: RuntimeFileBridgeContextV1,
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
		async readInput(fileId: string) {
			assertLive();
			if (!assertId(fileId) || !inputFileIds.has(fileId))
				throw new Error("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
			const result = await options.readInput(context(binding, fileId, "read"));
			if (result.fileId !== fileId) invalidBinding();
			return result;
		},
		async writeResult(descriptor, body) {
			assertLive();
			return options.writeResult(
				descriptor,
				body,
				// The execution binding carries the unique result owner; no file id exists
				// until the authority allocates the confirmed result object.
				context(binding, "result", "write"),
			);
		},
	};
}
