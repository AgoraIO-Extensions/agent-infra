import { once } from "node:events";
import type { Duplex } from "node:stream";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../deploy/runtime/vendor/codex/callback-v2.schema.json" with {
	type: "json",
};
import type {
	CodexConnectionBootstrapRequest,
	CodexConnectionBootstrapResponse,
	CodexConnectionEvidenceUpdateRequest,
	CodexConnectionEvidenceUpdateResponse,
	CodexConnectionOperationRequest,
	CodexConnectionOperationResponse,
	CodexConnectionRecoveryRequest,
	CodexConnectionRecoveryResponse,
} from "./codex-connection-client.js";

const maximumFrameBytes = 16_384;
const callbackTimeoutMs = 4_500;
const maximumPermitMs = 5_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const ajv = new Ajv2020({ strict: true, strictRequired: false });
ajv.addFormat(
	"uuid",
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
ajv.addSchema(schema);
const validRequest = ajv.compile<NativeClientRequest>({
	$ref: `${schema.$id}#/$defs/clientRequest`,
});
const validResponse = ajv.compile<NativeClientResponse>({
	$ref: `${schema.$id}#/$defs/clientResponse`,
});
const validIdentity = ajv.compile({ $ref: `${schema.$id}#/$defs/identity` });
const validReservation = ajv.compile({
	$ref: `${schema.$id}#/$defs/sourceReservation`,
});
const validSource = ajv.compile({ $ref: `${schema.$id}#/$defs/nativeSource` });

export function isCodexNativeSourceReservationV1(
	value: unknown,
): value is CodexNativeSourceReservationV1 {
	return validReservation(value);
}
export function isCodexNativeSourceV1(
	value: unknown,
): value is CodexNativeSourceV1 {
	return validSource(value);
}

export function isCodexNativeAttemptIdentityV1(
	value: unknown,
): value is CodexNativeAttemptIdentityV1 {
	return validIdentity(value);
}

export interface CodexNativeAttemptIdentityV1 {
	readonly sessionId: string;
	readonly turnId: string;
	readonly callId: string;
	readonly attemptRef: string;
	readonly toolName: string;
	readonly parentAttemptRef?: string;
}

export type CodexNativeOutcomeReasonV1 =
	| "authorization_denied"
	| "authorization_unavailable"
	| "cancelled_before_dispatch"
	| "execution_failed"
	| "execution_cancelled"
	| "dispatch_unconfirmed"
	| "result_unconfirmed";

interface CallbackBinding {
	readonly schemaVersion: 1;
	readonly requestId: string;
	readonly identity: CodexNativeAttemptIdentityV1;
}

export type CodexNativeOperationRequestV1 = CallbackBinding & {
	readonly occurredAt: number;
} & (
		| { readonly phase: "intent" }
		| { readonly phase: "started"; readonly permitId: string }
		| {
				readonly phase: "outcome";
				readonly permitId: string;
				readonly outcome: "completed" | "failed" | "unknown";
				readonly reason?: CodexNativeOutcomeReasonV1;
		  }
	);

export type CodexNativeOperationResponseV1 = CallbackBinding &
	(
		| {
				readonly phase: "intent";
				readonly decision: "permit";
				readonly permitId: string;
				readonly expiresAt: number;
				readonly sourceOwner: CodexNativeSourceOwnerV1;
		  }
		| {
				readonly phase: "intent";
				readonly decision: "deny";
				readonly reason:
					| "authorization_denied"
					| "authorization_unavailable"
					| "persistence_unavailable";
		  }
		| { readonly phase: "started" | "outcome"; readonly decision: "ack" }
	);

export interface CodexNativeSourceOwnerV1 {
	readonly rootThreadId: string;
	readonly rootTurnId: string;
}

export interface CodexNativeSourceV1 {
	readonly threadId: string;
	readonly turnId: string;
}

export interface CodexNativeSourceReservationV1 {
	readonly reservationId: string;
	readonly parent: CodexNativeAttemptIdentityV1;
	readonly parentPermitId: string;
	readonly childThreadId: string;
	readonly submissionId: string;
}

interface SourceBinding {
	readonly schemaVersion: 1;
	readonly requestId: string;
	readonly occurredAt: number;
	readonly reservation: CodexNativeSourceReservationV1;
}

export type CodexNativeSourceRequestV1 = SourceBinding &
	(
		| { readonly phase: "source-reserve" }
		| {
				readonly phase: "source-bind";
				readonly source: CodexNativeSourceV1;
				readonly delivery: "started" | "steered";
		  }
		| ({ readonly phase: "source-not-started" } & (
				| {
						readonly stage: "not_queued";
						readonly reason: "queue_closed" | "cancelled_before_start";
				  }
				| {
						readonly stage: "not_routed";
						readonly reason: "routing_rejected" | "cancelled_before_start";
				  }
				| {
						readonly stage: "gate_rejected";
						readonly reason: "binding_denied" | "cancelled_before_start";
						readonly source: CodexNativeSourceV1;
				  }
		  ))
		| {
				readonly phase: "source-terminal";
				readonly source: CodexNativeSourceV1;
				readonly nativeStatus: "completed" | "failed" | "cancelled";
		  }
	);

export type CodexNativeSourceResponseV1 = {
	readonly schemaVersion: 1;
	readonly requestId: string;
} & (
	| {
			readonly phase: "source-reserve" | "source-bind";
			readonly request: Extract<
				CodexNativeSourceRequestV1,
				{ phase: "source-reserve" | "source-bind" }
			>;
			readonly decision: "ack";
			readonly sourceOwner: CodexNativeSourceOwnerV1;
	  }
	| {
			readonly phase: "source-reserve" | "source-bind";
			readonly request: Extract<
				CodexNativeSourceRequestV1,
				{ phase: "source-reserve" | "source-bind" }
			>;
			readonly decision: "deny";
			readonly reason:
				| "authorization_denied"
				| "authorization_unavailable"
				| "persistence_unavailable";
	  }
	| {
			readonly phase: "source-not-started" | "source-terminal";
			readonly request: Extract<
				CodexNativeSourceRequestV1,
				{ phase: "source-not-started" | "source-terminal" }
			>;
			readonly decision: "ack";
	  }
);

export type CodexNativeCallbackRequestV1 =
	| CodexNativeOperationRequestV1
	| CodexNativeSourceRequestV1;
export type CodexNativeCallbackResponseV1 =
	| CodexNativeOperationResponseV1
	| CodexNativeSourceResponseV1;

export function sameCodexNativeCallbackBindingV1(
	request: CodexNativeCallbackRequestV1,
	response: CodexNativeCallbackResponseV1,
) {
	if (
		request.requestId !== response.requestId ||
		request.phase !== response.phase
	)
		return false;
	return "reservation" in request
		? "request" in response && isDeepStrictEqual(request, response.request)
		: "identity" in response &&
				sameCodexNativeAttemptV1(request.identity, response.identity);
}

export type CodexNativeCallbackHandlerV1 = (
	request: CodexNativeCallbackRequestV1,
	signal: AbortSignal,
) => Promise<CodexNativeCallbackResponseV1>;

export type CodexNativeCallbackRequest =
	| CodexNativeCallbackRequestV1
	| CodexConnectionOperationRequest
	| CodexConnectionEvidenceUpdateRequest;
export type CodexNativeCallbackResponse =
	| CodexNativeCallbackResponseV1
	| CodexConnectionOperationResponse
	| CodexConnectionEvidenceUpdateResponse;
export type CodexNativeCallbackHandler = (
	request: CodexNativeCallbackRequest,
	signal: AbortSignal,
) => Promise<CodexNativeCallbackResponse>;
export type CodexNativeConnectionBootstrapHandler = (
	request: CodexConnectionBootstrapRequest,
	signal: AbortSignal,
) => Promise<CodexConnectionBootstrapResponse>;
export type CodexNativeConnectionRecoveryHandler = (
	request: CodexConnectionRecoveryRequest,
	signal: AbortSignal,
) => Promise<CodexConnectionRecoveryResponse>;
type NativeClientRequest =
	| CodexNativeCallbackRequest
	| CodexConnectionBootstrapRequest
	| CodexConnectionRecoveryRequest;
type NativeClientResponse =
	| CodexNativeCallbackResponse
	| CodexConnectionBootstrapResponse
	| CodexConnectionRecoveryResponse;

function sameBinding(
	request: NativeClientRequest,
	response: NativeClientResponse,
) {
	if (
		request.schemaVersion !== response.schemaVersion ||
		request.requestId !== response.requestId ||
		request.phase !== response.phase
	)
		return false;
	if (request.schemaVersion === 1)
		return (
			response.schemaVersion === 1 &&
			sameCodexNativeCallbackBindingV1(request, response)
		);
	if (
		request.phase === "connection-bootstrap" ||
		request.phase === "connection-recovery"
	)
		return (
			response.phase === request.phase &&
			"request" in response &&
			isDeepStrictEqual(request, response.request)
		);
	return (
		"identity" in response &&
		"connectionRequest" in response &&
		sameCodexNativeAttemptV1(request.identity, response.identity) &&
		isDeepStrictEqual(request.connectionRequest, response.connectionRequest)
	);
}

// JSON.parse owns syntax. This pass only rejects duplicate (including escaped) keys.
function parseFrame(text: string): unknown {
	const value: unknown = JSON.parse(text);
	const objects: (Set<string> | undefined)[] = [];
	for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)) {
		const token = match[0];
		if (token === "{") objects.push(new Set());
		else if (token === "[") objects.push(undefined);
		else if (token === "}" || token === "]") objects.pop();
		else if (/^\s*:/.test(text.slice(match.index + token.length))) {
			const keys = objects.at(-1);
			const key: string = JSON.parse(token);
			if (!keys || keys.has(key)) throw unavailable();
			keys.add(key);
		}
	}
	return value;
}

export function sameCodexNativeAttemptV1(
	left: CodexNativeAttemptIdentityV1,
	right: CodexNativeAttemptIdentityV1,
) {
	return (
		left.sessionId === right.sessionId &&
		left.turnId === right.turnId &&
		left.callId === right.callId &&
		left.attemptRef === right.attemptRef &&
		left.toolName === right.toolName &&
		left.parentAttemptRef === right.parentAttemptRef
	);
}

function unavailable() {
	return new Error("CODEX_NATIVE_CALLBACK_UNAVAILABLE");
}

/** Legacy callers retain strict V1 input and cannot enable the credential lane. */
export function serveCodexNativeCallbacksV1(
	stream: Duplex,
	handle: CodexNativeCallbackHandlerV1,
	onFailure: () => void,
) {
	return serveCodexNativeCallbacks(
		stream,
		async (request, signal) => {
			if (request.schemaVersion !== 1) throw unavailable();
			return handle(request, signal);
		},
		undefined,
		onFailure,
	);
}

/** Private FD reader. Bootstrap never reaches durable operation handlers. */
export function serveCodexNativeCallbacks(
	stream: Duplex,
	handle: CodexNativeCallbackHandler,
	bootstrap: CodexNativeConnectionBootstrapHandler | undefined,
	onFailure: () => void,
	recovery?: CodexNativeConnectionRecoveryHandler,
	allowEof?: () => boolean,
) {
	const lifetime = new AbortController();
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		lifetime.abort();
		stream.destroy();
	};
	const abort = () => lifetime.abort();
	stream.on("error", abort);
	stream.on("close", abort);
	const finished = (async () => {
		let pending: Buffer = Buffer.alloc(0);
		try {
			for await (const chunk of stream) {
				if (!Buffer.isBuffer(chunk)) throw unavailable();
				// Native permits one exchange at a time. Limit bytes before parsing.
				if (pending.length + chunk.length > maximumFrameBytes)
					throw unavailable();
				pending = Buffer.concat([pending, chunk]);
				const newline = pending.indexOf(10);
				if (newline === -1) continue;
				if (newline !== pending.length - 1) throw unavailable();
				const value: unknown = parseFrame(
					utf8.decode(pending.subarray(0, newline)),
				);
				pending = Buffer.alloc(0);
				if (!validRequest(value)) throw unavailable();
				const request = value;
				const timeout = AbortSignal.timeout(callbackTimeoutMs);
				const signal = AbortSignal.any([lifetime.signal, timeout]);
				const waiting = new AbortController();
				try {
					signal.throwIfAborted();
					const interrupted = once(signal, "abort", {
						signal: waiting.signal,
					}).then(() => {
						throw unavailable();
					});
					const pendingResponse =
						request.phase === "connection-bootstrap"
							? bootstrap
								? bootstrap(request, signal)
								: Promise.reject(unavailable())
							: request.phase === "connection-recovery"
								? recovery
									? recovery(request, signal)
									: Promise.reject(unavailable())
								: handle(request, signal);
					const response = await Promise.race([pendingResponse, interrupted]);
					signal.throwIfAborted();
					if (
						!validResponse(response) ||
						!sameBinding(request, response) ||
						(response.phase === "connection-recovery" &&
							response.decision === "verify" &&
							(response.expiresAt <= Date.now() ||
								response.currentClient.credential.expiresAt <
									response.expiresAt)) ||
						(response.decision === "permit" &&
							(response.phase === "connection-bootstrap"
								? response.slot.credential.expiresAt <= Date.now()
								: response.expiresAt <= Date.now() ||
									response.expiresAt > Date.now() + maximumPermitMs))
					)
						throw unavailable();
					const output = Buffer.from(`${JSON.stringify(response)}\n`);
					if (output.length > maximumFrameBytes) throw unavailable();
					await Promise.race([
						new Promise<void>((resolve, reject) =>
							stream.write(output, (error) =>
								error ? reject(unavailable()) : resolve(),
							),
						),
						interrupted,
					]);
				} finally {
					waiting.abort();
				}
			}
			if (!closed && (pending.length !== 0 || !allowEof?.()))
				throw unavailable();
		} catch {
			if (!closed) {
				close();
				onFailure();
			}
		} finally {
			close();
			stream.off("error", abort);
			stream.off("close", abort);
		}
	})();
	return { close, finished };
}
