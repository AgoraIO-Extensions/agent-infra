import { Buffer } from "node:buffer";

import { ProtocolErrorV1Schema } from "@agent-infra/contracts";
import {
	ExecutionGrantV1Schema,
	RuntimeEventV1Schema,
	RuntimeOperationResponseV1Schema,
	RuntimeOperationResponseV2Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStatusRequestV2Schema,
	RuntimeStatusResponseV2Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSubmitTurnRequestV2Schema,
	RuntimeSupplementRequestV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEventRequestV1,
	type ConversationRuntimeEventV1,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeStatusRequestV2,
} from "@agent-infra/platform-core";

export interface WorkerRuntimeHostClientOptionsV1 {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
}

const maximumResponseBytes = 65_536;
const maximumEventFrameBytes = 131_072;

function endpoint(baseUrl: string, path: string) {
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		throw new TypeError("RuntimeHost base URL is invalid");
	}
	if (
		(base.protocol !== "http:" && base.protocol !== "https:") ||
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

async function boundedResponseText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	const length = response.headers.get("content-length");
	if (length && /^\d+$/.test(length) && Number(length) > maximumResponseBytes) {
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
				if (bytes > maximumResponseBytes) {
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

function parseFrame(value: string): ConversationRuntimeEventV1 | undefined {
	if (value.startsWith(":")) return undefined;
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
		const event = RuntimeEventV1Schema.parse(
			JSON.parse(fields.get("data") ?? ""),
		);
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

async function* eventStream(response: Response) {
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
					const event = parseFrame(value);
					if (event) yield event;
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
	const fetcher = options.fetch ?? fetch;
	const dispatchBase = endpoint(options.baseUrl, "/");
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
			yield* eventStream(response);
		},
	};
}
