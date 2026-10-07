import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { ProtocolErrorV1Schema } from "@agent-infra/contracts";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	ExecutionGrantV1Schema,
	type RuntimeAuthorizationRenewRequestV3,
	RuntimeAuthorizationRenewRequestV3Schema,
	RuntimeAuthorizationRenewResponseV3Schema,
	type RuntimeBusinessGrantClaimsV4,
	type RuntimeBusinessRequestV4,
	type RuntimeEventAckRequestV3,
	RuntimeEventAckRequestV3Schema,
	type RuntimeEventAckRequestV4,
	RuntimeEventAckRequestV4Schema,
	RuntimeEventAckResponseV3Schema,
	RuntimeEventAckResponseV4Schema,
	type RuntimeEventPersistRequestV3,
	RuntimeEventPersistRequestV3Schema,
	type RuntimeEventReadRequestV4,
	RuntimeEventReadRequestV4Schema,
	RuntimeEventSchema,
	RuntimeEventV1Schema,
	type RuntimeEventV2,
	type RuntimeGenerationCancelRequestV3,
	RuntimeGenerationCancelRequestV3Schema,
	RuntimeOperationResponseV1Schema,
	RuntimeOperationResponseV2Schema,
	RuntimeOperationResponseV3Schema,
	RuntimeOperationResponseV4Schema,
	RuntimeOriginalBindingResponseV3Schema,
	type RuntimePinnedExecutionKeyScopeV4,
	RuntimePrivateRelayKeyFieldV1Schema,
	RuntimeRelayKeyDeliveryV1Schema,
	RuntimeReplayRequestV1Schema,
	type RuntimeSelectionV1,
	RuntimeStatusRequestV2Schema,
	type RuntimeStatusRequestV3,
	RuntimeStatusRequestV3Schema,
	RuntimeStatusResponseV2Schema,
	RuntimeStatusResponseV3Schema,
	RuntimeStopRequestV1Schema,
	type RuntimeStopRequestV3,
	RuntimeStopRequestV3Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSubmitTurnRequestV2Schema,
	type RuntimeSubmitTurnRequestV3,
	RuntimeSubmitTurnRequestV3Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSubmitTurnTransportV4Schema,
	RuntimeSupplementRequestV1Schema,
	type RuntimeSupplementRequestV3,
	RuntimeSupplementRequestV3Schema,
	RuntimeSupplementRequestV4Schema,
	RuntimeSupplementTransportV4Schema,
	validateRuntimeBusinessBindingV4,
	validateRuntimePinnedExecutionKeyScopeV4,
	validateRuntimeReplayResponseV4,
} from "@agent-infra/contracts/runtime";
import {
	type ConversationOperationFactV2,
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEventRequestV1,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationEventV2,
	type ConversationRuntimeStatusRequestV2,
} from "@agent-infra/platform-core";
import type { RelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import { runtimeFetch } from "./runtime-transport.js";

export interface WorkerRuntimeHostClientOptionsV1 {
	readonly baseUrl: string;
	readonly serviceToken: string;
	/** Trusted, approval-bound non-sensitive Connection target; never request supplied. */
	readonly connectionConsumer?: ApprovedConnectionConsumerTargetV1;
	readonly fetch?: typeof fetch;
}

/** Projection of the original accepted Execution, never a subject's current Key alias. */
export interface WorkerAcceptedExecutionV4 {
	readonly scope: RuntimePinnedExecutionKeyScopeV4;
	readonly trustedHostSessionRef: string | null;
	readonly authorizationRecordId: string;
	readonly selection: RuntimeSelectionV1;
}

export interface WorkerExecutionKeyReaderV4 {
	readAcceptedExecution(
		request: RuntimeBusinessRequestV4,
	): Promise<WorkerAcceptedExecutionV4 | null>;
	readCiphertext(binding: {
		readonly purpose: "personal" | "agent-default";
		readonly subjectId: string;
		readonly keyId: string;
		readonly keyVersion: number;
	}): Promise<unknown | null>;
}

export interface WorkerRuntimeHostClientOptionsV4
	extends WorkerRuntimeHostClientOptionsV1 {
	readonly verifyGrant: (
		grant: RuntimeBusinessRequestV4["grant"],
	) => RuntimeBusinessGrantClaimsV4;
	readonly executionKeys?: WorkerExecutionKeyReaderV4;
	readonly decryptor?: RelayKeyWorkerDecryptorV1;
	/** Original accepted model selection supplied by the Store claim, also checked against the Reader. */
	readonly selection?: RuntimeSelectionV1;
	readonly assertCurrentAuthorization: () => Promise<void>;
}

/** Local failure before the original Key can be delivered to RuntimeHost. */
export class RuntimeRelayKeyDeliveryError extends ConversationRuntimeHostError {
	constructor(
		code:
			| "RELAY_KEY_UNAVAILABLE"
			| "RELAY_KEY_METADATA_INVALID"
			| "RELAY_KEY_AUTHENTICATION_FAILED",
	) {
		super(code, false);
	}
}

const maximumResponseBytes = 65_536;
const maximumEventFrameBytes = 131_072;

function bindConnectionConsumer(
	fetcher: typeof fetch,
	target: WorkerRuntimeHostClientOptionsV1["connectionConsumer"],
): typeof fetch {
	if (!target) return fetcher;
	const value = JSON.stringify(target);
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("x-agent-infra-connection-consumer", value);
		return fetcher(input, { ...init, headers });
	};
}

function endpoint(baseUrl: string, path: string) {
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		throw new TypeError("RuntimeHost base URL is invalid");
	}
	// In-cluster plaintext only (ADR-0020); the resolver binds the exact Service.
	if (
		base.protocol !== "http:" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	) {
		throw new TypeError("RuntimeHost base URL is invalid");
	}
	base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
	return new URL(path.replace(/^\//, ""), base);
}

function failure(code: string, retryable: boolean): never {
	throw new ConversationRuntimeHostError(code, retryable);
}

async function responseFailure(response: Response): Promise<never> {
	let text: string;
	try {
		text = await boundedResponseText(response);
	} catch {
		return failure("RUNTIME_RESPONSE_INVALID", true);
	}
	try {
		const parsed = ProtocolErrorV1Schema.parse(JSON.parse(text));
		return failure(parsed.code, parsed.retryable);
	} catch (error) {
		if (error instanceof ConversationRuntimeHostError) throw error;
		return failure("RUNTIME_RESPONSE_INVALID", true);
	}
}

async function boundedResponseText(
	response: Response,
	limit = maximumResponseBytes,
): Promise<string> {
	const reader = response.body?.getReader();
	const length = response.headers.get("content-length");
	if (length && /^\d+$/.test(length) && Number(length) > limit) {
		await reader?.cancel().catch(() => undefined);
		return failure("RUNTIME_RESPONSE_INVALID", true);
	}
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.value) {
				bytes += next.value.byteLength;
				if (bytes > limit) {
					return failure("RUNTIME_RESPONSE_INVALID", true);
				}
				chunks.push(next.value);
			}
			if (next.done) break;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks, bytes),
		);
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

function requestInit(
	serviceToken: string,
	traceId: string,
	body: unknown,
	signal?: AbortSignal,
): RequestInit {
	return {
		method: "POST",
		headers: {
			authorization: `Bearer ${serviceToken}`,
			"content-type": "application/json",
			"x-trace-id": traceId,
		},
		body: JSON.stringify(body),
		redirect: "error" as const,
		signal,
	};
}

async function post(
	fetcher: typeof fetch,
	url: URL,
	serviceToken: string,
	traceId: string,
	body: unknown,
	signal?: AbortSignal,
) {
	let response: Response;
	try {
		response = await fetcher(
			url,
			requestInit(serviceToken, traceId, body, signal),
		);
	} catch {
		return failure("RUNTIME_UNAVAILABLE", true);
	}
	if (!response.ok) return responseFailure(response);
	return response;
}

function grant(value: unknown) {
	try {
		return ExecutionGrantV1Schema.parse(value);
	} catch {
		return failure("RUNTIME_GRANT_INVALID", false);
	}
}

function dispatchBody(request: ConversationRuntimeDispatchRequestV1) {
	const base = {
		schemaVersion: 1 as const,
		requestId: request.requestId,
		traceId: request.traceId,
		actorId: request.actorId,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		deliveryFence: request.deliveryFence,
		grant: grant(request.runtimeGrant),
	};
	const input = request.input
		? { ...request.input, attachments: [...request.input.attachments] }
		: undefined;
	if (request.operation === "turn.submit") {
		const submit = {
			...base,
			...(request.hostSessionRef
				? { hostSessionRef: request.hostSessionRef }
				: {}),
			input,
		};
		if (request.selection) {
			return {
				path: "/internal/runtime/v2/turns",
				responseVersion: 2 as const,
				body: RuntimeSubmitTurnRequestV2Schema.parse({
					...submit,
					schemaVersion: 2,
					selection: request.selection,
				}),
			};
		}
		return {
			path: "/internal/runtime/v1/turns",
			responseVersion: 1 as const,
			body: RuntimeSubmitTurnRequestV1Schema.parse(submit),
		};
	}
	if (request.operation === "turn.supplement") {
		return {
			path: "/internal/runtime/v1/instructions",
			responseVersion: 1 as const,
			body: RuntimeSupplementRequestV1Schema.parse({
				...base,
				hostSessionRef: request.hostSessionRef,
				messageId: request.messageId,
				executionDeliveryFence: request.executionDeliveryFence,
				input,
			}),
		};
	}
	return {
		path: "/internal/runtime/v1/stops",
		responseVersion: 1 as const,
		body: RuntimeStopRequestV1Schema.parse({
			...base,
			hostSessionRef: request.hostSessionRef,
			stopRequestId: request.stopRequestId,
			executionDeliveryFence: request.executionDeliveryFence,
		}),
	};
}

function replayBody(
	request:
		| ConversationRuntimeEventRequestV1
		| ConversationRuntimeStatusRequestV2,
) {
	return RuntimeReplayRequestV1Schema.parse({
		schemaVersion: 1,
		requestId: request.requestId,
		traceId: request.traceId,
		actorId: request.actorId,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		deliveryFence: request.deliveryFence,
		hostSessionRef: request.hostSessionRef,
		...("afterCursor" in request && request.afterCursor
			? { afterCursor: request.afterCursor }
			: {}),
		grant: grant(request.runtimeGrant),
	});
}

function statusBody(request: ConversationRuntimeStatusRequestV2) {
	return RuntimeStatusRequestV2Schema.parse({
		...replayBody(request),
		schemaVersion: 2,
		recovery: {
			schemaVersion: 1,
			input: request.recovery.input,
			...(request.recovery.selection
				? { selection: request.recovery.selection }
				: {}),
		},
	});
}

function parseFrame<T extends { cursor: string; type: string }>(
	value: string,
	schema: { parse(input: unknown): T },
): T {
	const fields = new Map<string, string>();
	for (const line of value.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator < 0) return failure("RUNTIME_EVENT_INVALID", true);
		const name = line.slice(0, separator);
		const fieldValue = line.slice(separator + 1).replace(/^ /, "");
		if (!new Set(["id", "event", "data"]).has(name) || fields.has(name)) {
			return failure("RUNTIME_EVENT_INVALID", true);
		}
		fields.set(name, fieldValue);
	}
	try {
		const event = schema.parse(JSON.parse(fields.get("data") ?? ""));
		if (
			fields.get("id") !== event.cursor ||
			fields.get("event") !== event.type
		) {
			return failure("RUNTIME_EVENT_INVALID", true);
		}
		return event;
	} catch (error) {
		if (error instanceof ConversationRuntimeHostError) throw error;
		return failure("RUNTIME_EVENT_INVALID", true);
	}
}

async function* eventStream<T extends { cursor: string; type: string }>(
	response: Response,
	schema: { parse(input: unknown): T },
) {
	if (
		!response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream")
	) {
		return failure("RUNTIME_RESPONSE_INVALID", true);
	}
	const reader = response.body?.getReader();
	if (!reader) return failure("RUNTIME_RESPONSE_INVALID", true);
	let frame: number[] = [];
	try {
		while (true) {
			const next = await reader.read();
			for (const byte of next.value ?? []) {
				frame.push(byte);
				const boundaryLength =
					frame.at(-1) === 10 && frame.at(-2) === 10
						? 2
						: frame.at(-1) === 10 &&
								frame.at(-2) === 13 &&
								frame.at(-3) === 10 &&
								frame.at(-4) === 13
							? 4
							: 0;
				if (boundaryLength) {
					frame.length -= boundaryLength;
					let value: string;
					try {
						value = new TextDecoder("utf-8", { fatal: true }).decode(
							Uint8Array.from(frame),
						);
					} catch {
						return failure("RUNTIME_EVENT_INVALID", true);
					}
					frame = [];
					if (value.startsWith(":")) continue;
					yield parseFrame(value, schema);
				} else if (frame.length > maximumEventFrameBytes) {
					return failure("RUNTIME_EVENT_INVALID", true);
				}
			}
			if (next.done) break;
		}
		if (frame.some((byte) => ![9, 10, 13, 32].includes(byte))) {
			return failure("RUNTIME_EVENT_INVALID", true);
		}
	} catch (error) {
		if (error instanceof ConversationRuntimeHostError) throw error;
		return failure("RUNTIME_UNAVAILABLE", true);
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

export function createWorkerRuntimeHostClientV1(
	options: WorkerRuntimeHostClientOptionsV1,
): ConversationRuntimeHostPortV1 {
	if (!options || typeof options !== "object" || !options.serviceToken) {
		throw new TypeError("RuntimeHost client options are invalid");
	}
	const dispatchBase = endpoint(options.baseUrl, "/");
	const fetcher = options.fetch ?? runtimeFetch;
	return {
		async dispatch(request, signal) {
			let selected: ReturnType<typeof dispatchBody>;
			try {
				selected = dispatchBody(request);
			} catch (error) {
				if (error instanceof ConversationRuntimeHostError) throw error;
				return failure("RUNTIME_REQUEST_INVALID", false);
			}
			const response = await post(
				fetcher,
				new URL(selected.path.replace(/^\//, ""), dispatchBase),
				options.serviceToken,
				request.traceId,
				selected.body,
				signal,
			);
			try {
				const text = await boundedResponseText(response);
				return (
					selected.responseVersion === 2
						? RuntimeOperationResponseV2Schema
						: RuntimeOperationResponseV1Schema
				).parse(JSON.parse(text));
			} catch {
				return failure("RUNTIME_RESPONSE_INVALID", true);
			}
		},
		async recoverStatus(request, signal) {
			let body: ReturnType<typeof statusBody>;
			try {
				body = statusBody(request);
			} catch (error) {
				if (error instanceof ConversationRuntimeHostError) throw error;
				return failure("RUNTIME_REQUEST_INVALID", false);
			}
			const response = await post(
				fetcher,
				new URL("internal/runtime/v2/status", dispatchBase),
				options.serviceToken,
				request.traceId,
				body,
				signal,
			);
			try {
				return RuntimeStatusResponseV2Schema.parse(
					JSON.parse(await boundedResponseText(response)),
				);
			} catch {
				return failure("RUNTIME_RESPONSE_INVALID", true);
			}
		},
		async *events(request, signal) {
			let body: ReturnType<typeof replayBody>;
			try {
				body = replayBody(request);
			} catch (error) {
				if (error instanceof ConversationRuntimeHostError) throw error;
				return failure("RUNTIME_REQUEST_INVALID", false);
			}
			const response = await post(
				fetcher,
				new URL("internal/runtime/v1/events/stream", dispatchBase),
				options.serviceToken,
				request.traceId,
				body,
				signal,
			);
			yield* eventStream(response, RuntimeEventV1Schema);
		},
	};
}

/** Project only the already schema-validated public fields into domain facts. */
function operationEvent(
	event: RuntimeEventV2,
): ConversationRuntimeOperationEventV2 {
	const fact = event.payload;
	const base = {
		operationRef: fact.operationRef,
		attemptRef: fact.attemptRef,
		phase: fact.phase,
		...(fact.parentOperationRef === undefined
			? {}
			: { parentOperationRef: fact.parentOperationRef }),
		...(fact.startedAt === undefined ? {} : { startedAt: fact.startedAt }),
		...(fact.finishedAt === undefined ? {} : { finishedAt: fact.finishedAt }),
		...(fact.durationMs === undefined ? {} : { durationMs: fact.durationMs }),
		...(fact.failureCode === undefined
			? {}
			: { failureCode: fact.failureCode }),
	};
	let payload: ConversationOperationFactV2;
	if (fact.kind === "tool") {
		const association = fact.connection;
		payload = {
			...base,
			kind: "tool",
			toolId: fact.toolId,
			...(fact.resultRef === undefined ? {} : { resultRef: fact.resultRef }),
			...(association === undefined
				? {}
				: {
						connection:
							association.verification === "verified"
								? {
										serviceRef: association.serviceRef,
										verification: "verified",
										callRef: association.callRef,
									}
								: {
										serviceRef: association.serviceRef,
										verification: "unverified",
										...(association.callRef === undefined
											? {}
											: { callRef: association.callRef }),
										reason: association.reason,
									},
					}),
		};
	} else {
		payload = {
			...base,
			kind: "model",
			model: {
				configVersion: fact.model.configVersion,
				modelOptionId: fact.model.modelOptionId,
				modelId: fact.model.modelId,
				...(fact.model.reasoningLevel === undefined
					? {}
					: { reasoningLevel: fact.model.reasoningLevel }),
			},
			...(fact.usage === undefined
				? {}
				: {
						usage: {
							...(fact.usage.inputTokens === undefined
								? {}
								: { inputTokens: fact.usage.inputTokens }),
							...(fact.usage.outputTokens === undefined
								? {}
								: { outputTokens: fact.usage.outputTokens }),
							...(fact.usage.cachedInputTokens === undefined
								? {}
								: { cachedInputTokens: fact.usage.cachedInputTokens }),
						},
					}),
		};
	}
	return {
		schemaVersion: 2,
		adapterEventKey: event.adapterEventKey,
		executionId: event.executionId,
		cursor: event.cursor,
		occurredAt: event.occurredAt,
		type: "operation",
		payload,
	};
}

/** V3 never signs, renews, or downgrades grants: the trusted caller supplies each fresh authorization. */
export function createWorkerRuntimeHostClientV3(
	options: WorkerRuntimeHostClientOptionsV1,
) {
	if (!options || typeof options !== "object" || !options.serviceToken)
		throw new TypeError("RuntimeHost client options are invalid");
	const base = endpoint(options.baseUrl, "/");
	const connectionConsumer = options.connectionConsumer
		? structuredClone(options.connectionConsumer)
		: undefined;
	const fetcher = bindConnectionConsumer(
		options.fetch ?? runtimeFetch,
		connectionConsumer,
	);
	async function request<T extends { traceId: string }, R>(
		path: string,
		value: T,
		schema: { parse(input: unknown): T },
		responseSchema: { parse(input: unknown): R },
		signal?: AbortSignal,
	): Promise<R> {
		let body: T;
		try {
			body = schema.parse(value);
		} catch {
			return failure("RUNTIME_REQUEST_INVALID", false);
		}
		const response = await post(
			fetcher,
			new URL(`internal/runtime/v3/${path}`, base),
			options.serviceToken,
			body.traceId,
			body,
			signal,
		);
		try {
			return responseSchema.parse(
				JSON.parse(await boundedResponseText(response)),
			);
		} catch {
			return failure("RUNTIME_RESPONSE_INVALID", true);
		}
	}
	return {
		connectionConsumerTarget: () =>
			connectionConsumer ? structuredClone(connectionConsumer) : undefined,
		submitTurn: (value: RuntimeSubmitTurnRequestV3, signal?: AbortSignal) =>
			request(
				"turns",
				value,
				RuntimeSubmitTurnRequestV3Schema,
				RuntimeOperationResponseV3Schema,
				signal,
			),
		supplement: (value: RuntimeSupplementRequestV3, signal?: AbortSignal) =>
			request(
				"instructions",
				value,
				RuntimeSupplementRequestV3Schema,
				RuntimeOperationResponseV3Schema,
				signal,
			),
		stop: (value: RuntimeStopRequestV3, signal?: AbortSignal) =>
			request(
				"stops",
				value,
				RuntimeStopRequestV3Schema,
				RuntimeOperationResponseV3Schema,
				signal,
			),
		recoverStatus: (value: RuntimeStatusRequestV3, signal?: AbortSignal) =>
			request(
				"status",
				value,
				RuntimeStatusRequestV3Schema,
				RuntimeStatusResponseV3Schema,
				signal,
			),
		async readOriginalBinding(
			value: RuntimeStatusRequestV3,
			signal?: AbortSignal,
		) {
			if (value?.hostSessionRef !== null)
				return failure("RUNTIME_REQUEST_INVALID", false);
			const binding = await request(
				"original-binding",
				value,
				RuntimeStatusRequestV3Schema,
				RuntimeOriginalBindingResponseV3Schema,
				signal,
			);
			if (binding.executionId !== value.executionId)
				return failure("RUNTIME_RESPONSE_INVALID", true);
			return binding;
		},
		cancelGeneration: (
			value: RuntimeGenerationCancelRequestV3,
			signal?: AbortSignal,
		) =>
			request(
				"generations/cancel",
				value,
				RuntimeGenerationCancelRequestV3Schema,
				RuntimeOperationResponseV3Schema,
				signal,
			),
		renewAuthorization: (
			value: RuntimeAuthorizationRenewRequestV3,
			signal?: AbortSignal,
		) =>
			request(
				"authorizations/renew",
				value,
				RuntimeAuthorizationRenewRequestV3Schema,
				RuntimeAuthorizationRenewResponseV3Schema,
				signal,
			),
		acknowledgeEvents: (
			value: RuntimeEventAckRequestV3,
			signal?: AbortSignal,
		) =>
			request(
				"events/ack",
				value,
				RuntimeEventAckRequestV3Schema,
				RuntimeEventAckResponseV3Schema,
				signal,
			),
		async *events(value: RuntimeEventPersistRequestV3, signal?: AbortSignal) {
			let body: RuntimeEventPersistRequestV3;
			try {
				body = RuntimeEventPersistRequestV3Schema.parse(value);
			} catch {
				return failure("RUNTIME_REQUEST_INVALID", false);
			}
			const response = await post(
				fetcher,
				new URL("internal/runtime/v3/events/stream", base),
				options.serviceToken,
				body.traceId,
				body,
				signal,
			);
			for await (const event of eventStream(response, RuntimeEventSchema)) {
				if (event.executionId !== body.executionId)
					return failure("RUNTIME_EVENT_INVALID", true);
				yield event.schemaVersion === 2 ? operationEvent(event) : event;
			}
		},
	};
}

async function interruptedDependency<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	let abort: (() => void) | undefined;
	try {
		if (signal.aborted) {
			void promise.catch(() => undefined);
			throw new ConversationRuntimeHostError("RUNTIME_INTERRUPTED", true);
		}
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				abort = () =>
					reject(new ConversationRuntimeHostError("RUNTIME_INTERRUPTED", true));
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

/** V4 business and event consumers within the existing Worker loop. Control recovery stays Key-free. */
export function createWorkerRuntimeHostClientV4(
	options: WorkerRuntimeHostClientOptionsV4,
) {
	if (
		!options.serviceToken ||
		!options.verifyGrant ||
		!options.assertCurrentAuthorization
	)
		throw new TypeError("RuntimeHost V4 client options are invalid");
	const base = endpoint(options.baseUrl, "/");
	const connectionConsumer = options.connectionConsumer
		? structuredClone(options.connectionConsumer)
		: undefined;
	const fetcher = bindConnectionConsumer(
		options.fetch ?? runtimeFetch,
		connectionConsumer,
	);
	async function send(value: RuntimeBusinessRequestV4, signal?: AbortSignal) {
		try {
			signal?.throwIfAborted();
			const request =
				"selection" in value
					? RuntimeSubmitTurnRequestV4Schema.parse(value)
					: RuntimeSupplementRequestV4Schema.parse(value);
			const claims = options.verifyGrant(request.grant);
			await validateRuntimeBusinessBindingV4(request, claims);
			const reader = options.executionKeys;
			const decryptor = options.decryptor;
			if (!reader || !decryptor || !options.selection)
				throw new RuntimeRelayKeyDeliveryError("RELAY_KEY_UNAVAILABLE");
			const accepted = await interruptedDependency(
				reader.readAcceptedExecution(request),
				signal,
			);
			if (!accepted) return failure("RUNTIME_GRANT_INVALID", false);
			validateRuntimePinnedExecutionKeyScopeV4(
				accepted.scope,
				request,
				accepted.trustedHostSessionRef,
			);
			if (
				accepted.authorizationRecordId !== claims.authorizationRecordId ||
				!isDeepStrictEqual(accepted.selection, options.selection) ||
				("selection" in request &&
					!isDeepStrictEqual(accepted.selection, request.selection))
			)
				return failure("RUNTIME_GRANT_INVALID", false);
			const original = structuredClone(accepted);
			const binding = {
				purpose: original.scope.keyBinding.purpose,
				subjectId: original.scope.keyBinding.subjectId,
				keyId: original.scope.keyBinding.ciphertextRef,
				keyVersion: original.scope.keyBinding.version,
			};
			const encryptedRecord = await interruptedDependency(
				reader.readCiphertext(binding),
				signal,
			);
			signal?.throwIfAborted();
			if (!encryptedRecord)
				throw new RuntimeRelayKeyDeliveryError("RELAY_KEY_UNAVAILABLE");
			const decryption = decryptor
				.decrypt({ encryptedRecord, expectedBinding: binding })
				.then((result) => {
					if (signal?.aborted && result.outcome === "decrypted")
						result.plaintext.fill(0);
					return result;
				});
			const decrypted = await interruptedDependency(decryption, signal);
			if (decrypted.outcome !== "decrypted")
				throw new RuntimeRelayKeyDeliveryError(decrypted.code);
			let relayKey: string;
			try {
				signal?.throwIfAborted();
				relayKey = new TextDecoder("utf-8", { fatal: true }).decode(
					decrypted.plaintext,
				);
				RuntimeRelayKeyDeliveryV1Schema.parse({ relayKey });
			} finally {
				decrypted.plaintext.fill(0);
			}
			const current = await interruptedDependency(
				reader.readAcceptedExecution(request),
				signal,
			);
			if (!current || !isDeepStrictEqual(current, original))
				return failure("RUNTIME_GRANT_INVALID", false);
			const privateKeyField = RuntimePrivateRelayKeyFieldV1Schema.parse({
				schemaVersion: 1,
				context: {
					requestId: request.requestId,
					grantId: claims.grantId,
					requestDigest: claims.requestDigest,
					traceId: request.traceId,
					principal: request.principal,
					executionSource: request.executionSource,
					channelId: request.channelId,
					agentId: request.agentId,
					conversationId: request.conversationId,
					executionId: request.executionId,
					turnId: request.turnId,
					sessionGeneration: request.sessionGeneration,
					hostSessionRef: request.hostSessionRef,
					operation: request.operation,
					keyBinding: request.keyBinding,
				},
				keyDelivery: { relayKey },
			});
			const transport =
				"selection" in request
					? RuntimeSubmitTurnTransportV4Schema.parse({
							businessRequest: request,
							privateKeyField,
						})
					: RuntimeSupplementTransportV4Schema.parse({
							businessRequest: request,
							privateKeyField,
						});
			await interruptedDependency(options.assertCurrentAuthorization(), signal);
			signal?.throwIfAborted();
			// Synchronous final cryptographic/time check follows all dependency awaits.
			const finalClaims = options.verifyGrant(request.grant);
			if (!isDeepStrictEqual(finalClaims, claims))
				return failure("RUNTIME_GRANT_INVALID", false);
			const response = await post(
				fetcher,
				new URL(
					`internal/runtime/v4/${"selection" in request ? "turns" : "instructions"}`,
					base,
				),
				options.serviceToken,
				request.traceId,
				transport,
				signal,
			);
			try {
				const result = RuntimeOperationResponseV4Schema.parse(
					JSON.parse(await boundedResponseText(response)),
				);
				if (
					result.operationId !== request.operation.id ||
					(request.hostSessionRef !== null &&
						result.hostSessionRef !== request.hostSessionRef)
				)
					return failure("RUNTIME_RESPONSE_INVALID", true);
				return result;
			} catch {
				return failure("RUNTIME_RESPONSE_INVALID", true);
			}
		} catch (error) {
			if (error instanceof ConversationRuntimeHostError) throw error;
			return failure("RUNTIME_REQUEST_INVALID", false);
		}
	}
	return {
		submitTurn: send,
		supplement: send,
		async readEvents(value: RuntimeEventReadRequestV4, signal?: AbortSignal) {
			const parsed = RuntimeEventReadRequestV4Schema.safeParse(value);
			if (!parsed.success) return failure("RUNTIME_REQUEST_INVALID", false);
			await interruptedDependency(options.assertCurrentAuthorization(), signal);
			signal?.throwIfAborted();
			const response = await post(
				fetcher,
				new URL("internal/runtime/v4/events/read", base),
				options.serviceToken,
				parsed.data.traceId,
				parsed.data,
				signal,
			);
			try {
				const replay = validateRuntimeReplayResponseV4(
					JSON.parse(
						await boundedResponseText(
							response,
							maximumEventFrameBytes * 8 + 16_384,
						),
					),
					parsed.data,
				);
				const seen = new Set<string>();
				for (const event of replay.events) {
					if (
						event.cursor === parsed.data.afterCursor ||
						seen.has(event.cursor)
					)
						return failure("RUNTIME_EVENT_INVALID", true);
					seen.add(event.cursor);
				}
				return {
					...replay,
					events: replay.events.map((event) =>
						event.schemaVersion === 2 ? operationEvent(event) : event,
					),
				};
			} catch {
				return failure("RUNTIME_EVENT_INVALID", true);
			}
		},
		async acknowledgeEvents(
			value: RuntimeEventAckRequestV4,
			signal?: AbortSignal,
		) {
			const parsed = RuntimeEventAckRequestV4Schema.safeParse(value);
			if (!parsed.success) return failure("RUNTIME_REQUEST_INVALID", false);
			await interruptedDependency(options.assertCurrentAuthorization(), signal);
			signal?.throwIfAborted();
			const response = await post(
				fetcher,
				new URL("internal/runtime/v4/events/ack", base),
				options.serviceToken,
				parsed.data.traceId,
				parsed.data,
				signal,
			);
			try {
				const ack = RuntimeEventAckResponseV4Schema.parse(
					JSON.parse(await boundedResponseText(response)),
				);
				if (
					ack.executionId !== parsed.data.executionId ||
					ack.confirmedCursor !== parsed.data.confirmedCursor
				)
					return failure("RUNTIME_RESPONSE_INVALID", true);
				return ack;
			} catch {
				return failure("RUNTIME_RESPONSE_INVALID", true);
			}
		},
	};
}
