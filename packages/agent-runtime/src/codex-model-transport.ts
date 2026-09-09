import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { TextDecoder } from "node:util";
import {
	gunzipSync,
	gzipSync,
	zstdCompressSync,
	zstdDecompressSync,
} from "node:zlib";

import { createParser, type EventSourceMessage } from "eventsource-parser";

import {
	type CodexModelAccess,
	validateModelAccess,
} from "./codex-app-server-bridge.js";

const maximumRequestBytes = 8 * 1024 * 1024;
const maximumEventBytes = 1024 * 1024;
const maximumStreamBytes = 16 * 1024 * 1024;
const maximumStreamEvents = 8_192;
const requestTimeoutMs = 120_000;
const turnAdmissionTimeoutMs = 2_000;
const sanitizedFailureBody = JSON.stringify({
	error: { message: "Model request failed" },
});
const sanitizedFailureEvent = `data: ${JSON.stringify({
	type: "error",
	code: "server_error",
	message: "Model request failed",
	param: null,
})}\n\n`;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const internalModelPattern =
	/^[A-Za-z0-9_-]+\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const realModelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const nativeTurnIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CodexModelRoute extends CodexModelAccess {
	readonly internalModel: string;
	readonly model: string;
}

export interface CodexNativeTurn {
	readonly threadId: string;
	readonly turnId: string;
}

interface ActiveTurnRequest {
	readonly terminate: () => void;
	readonly completion: Promise<void>;
}

function reject(response: ServerResponse, status = 502) {
	if (response.destroyed || response.writableEnded) return;
	response.writeHead(status, { "content-type": "application/json" });
	response.end(sanitizedFailureBody);
}

async function write(response: ServerResponse, value: string) {
	if (response.destroyed || response.writableEnded) throw new Error();
	if (response.write(value)) return;
	await Promise.race([
		once(response, "drain"),
		once(response, "close").then(() => Promise.reject(new Error())),
	]);
}

async function failStream(response: ServerResponse) {
	if (response.destroyed || response.writableEnded) return;
	if (!response.headersSent) {
		reject(response);
		return;
	}
	await write(response, sanitizedFailureEvent).catch(() => {});
	if (!response.destroyed && !response.writableEnded) response.end();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function nativeTurnFromHeaders(
	metadataHeader: string | string[] | undefined,
	clientRequestId: string | string[] | undefined,
) {
	if (
		typeof metadataHeader !== "string" ||
		typeof clientRequestId !== "string"
	) {
		return;
	}
	let metadata: unknown;
	try {
		metadata = JSON.parse(metadataHeader);
	} catch {
		return;
	}
	if (
		!isPlainRecord(metadata) ||
		typeof metadata.thread_id !== "string" ||
		!nativeTurnIdentifierPattern.test(metadata.thread_id) ||
		typeof metadata.turn_id !== "string" ||
		!nativeTurnIdentifierPattern.test(metadata.turn_id) ||
		clientRequestId !== metadata.thread_id
	) {
		return;
	}
	return { threadId: metadata.thread_id, turnId: metadata.turn_id };
}

function nativeTurnKey(turn: CodexNativeTurn) {
	if (
		!isPlainRecord(turn) ||
		Object.keys(turn).length !== 2 ||
		!nativeTurnIdentifierPattern.test(turn.threadId) ||
		!nativeTurnIdentifierPattern.test(turn.turnId)
	) {
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	}
	return `${turn.threadId}\u0000${turn.turnId}`;
}

function containsCredential(value: string, credentials: readonly string[]) {
	return credentials.some((credential) => value.includes(credential));
}

function containsUnsafeModelData(
	value: unknown,
	credentials: readonly string[],
): boolean {
	if (typeof value === "string") return containsCredential(value, credentials);
	if (Array.isArray(value)) {
		return value.some((item) => containsUnsafeModelData(item, credentials));
	}
	if (!isPlainRecord(value)) return false;
	return Object.entries(value).some(
		([key, nested]) =>
			(key === "error" && nested !== null) ||
			containsCredential(key, credentials) ||
			containsUnsafeModelData(nested, credentials),
	);
}

function optionalString(
	source: Record<string, unknown>,
	key: string,
	target: Record<string, unknown>,
) {
	const value = source[key];
	if (value === undefined || value === null) return true;
	if (typeof value !== "string") return false;
	target[key] = value;
	return true;
}

function projectTextItems(value: unknown, types: readonly string[]) {
	if (!Array.isArray(value)) return;
	const items: Record<string, unknown>[] = [];
	for (const entry of value) {
		if (
			!isPlainRecord(entry) ||
			typeof entry.type !== "string" ||
			!types.includes(entry.type) ||
			typeof entry.text !== "string"
		) {
			return;
		}
		items.push({ type: entry.type, text: entry.text });
	}
	return items;
}

function projectResponseItem(value: unknown) {
	if (!isPlainRecord(value) || typeof value.type !== "string") return;
	const item: Record<string, unknown> = { type: value.type };
	if (!optionalString(value, "id", item)) return;
	switch (value.type) {
		case "message": {
			if (typeof value.role !== "string") return;
			const content = projectTextItems(value.content, [
				"input_text",
				"output_text",
			]);
			if (!content) return;
			item.role = value.role;
			item.content = content;
			if (value.phase !== undefined && value.phase !== null) {
				if (value.phase !== "commentary" && value.phase !== "final_answer")
					return;
				item.phase = value.phase;
			}
			return item;
		}
		case "reasoning": {
			const summary = projectTextItems(value.summary, ["summary_text"]);
			if (!summary) return;
			item.summary = summary;
			if (value.content !== undefined && value.content !== null) {
				const content = projectTextItems(value.content, [
					"reasoning_text",
					"text",
				]);
				if (!content) return;
				item.content = content;
			}
			if (!optionalString(value, "encrypted_content", item)) return;
			return item;
		}
		case "function_call": {
			for (const key of ["name", "arguments", "call_id"] as const) {
				if (typeof value[key] !== "string") return;
				item[key] = value[key];
			}
			if (!optionalString(value, "namespace", item)) return;
			if (
				value.encrypted_function_args !== undefined &&
				value.encrypted_function_args !== null
			) {
				if (
					!Array.isArray(value.encrypted_function_args) ||
					!value.encrypted_function_args.every(
						(entry) => typeof entry === "string",
					)
				) {
					return;
				}
				item.encrypted_function_args = value.encrypted_function_args;
			}
			return item;
		}
		case "custom_tool_call": {
			for (const key of ["call_id", "name", "input"] as const) {
				if (typeof value[key] !== "string") return;
				item[key] = value[key];
			}
			if (
				!optionalString(value, "namespace", item) ||
				!optionalString(value, "status", item)
			) {
				return;
			}
			return item;
		}
		case "tool_search_call": {
			if (typeof value.execution !== "string" || value.arguments === undefined)
				return;
			item.execution = value.execution;
			item.arguments = value.arguments;
			if (
				!optionalString(value, "call_id", item) ||
				!optionalString(value, "status", item)
			) {
				return;
			}
			return item;
		}
		case "web_search_call": {
			if (!optionalString(value, "status", item)) return;
			if (value.action !== undefined && value.action !== null) {
				if (
					!isPlainRecord(value.action) ||
					typeof value.action.type !== "string"
				)
					return;
				const action: Record<string, unknown> = { type: value.action.type };
				for (const key of ["query", "url", "pattern"] as const) {
					if (!optionalString(value.action, key, action)) return;
				}
				if (value.action.queries !== undefined) {
					if (
						!Array.isArray(value.action.queries) ||
						!value.action.queries.every((entry) => typeof entry === "string")
					) {
						return;
					}
					action.queries = value.action.queries;
				}
				item.action = action;
			}
			return item;
		}
		case "image_generation_call": {
			if (typeof value.status !== "string" || typeof value.result !== "string")
				return;
			item.status = value.status;
			item.result = value.result;
			if (!optionalString(value, "revised_prompt", item)) return;
			return item;
		}
		case "compaction":
		case "compaction_summary": {
			if (typeof value.encrypted_content !== "string") return;
			item.encrypted_content = value.encrypted_content;
			return item;
		}
		default:
			return;
	}
}

function projectUsage(value: unknown) {
	if (value === null) return null;
	if (!isPlainRecord(value)) return;
	const usage: Record<string, unknown> = {};
	for (const key of [
		"input_tokens",
		"output_tokens",
		"total_tokens",
	] as const) {
		if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) return;
		usage[key] = value[key];
	}
	for (const [key, fields] of [
		["input_tokens_details", ["cached_tokens", "cache_write_tokens"]],
		["output_tokens_details", ["reasoning_tokens"]],
	] as const) {
		const details = value[key];
		if (details === undefined || details === null) continue;
		if (!isPlainRecord(details)) return;
		const projected: Record<string, unknown> = {};
		for (const field of fields) {
			if (details[field] === undefined) continue;
			if (
				!Number.isSafeInteger(details[field]) ||
				(details[field] as number) < 0
			) {
				return;
			}
			projected[field] = details[field];
		}
		usage[key] = projected;
	}
	if (value.codex_rollout_budget_units !== undefined) {
		if (
			typeof value.codex_rollout_budget_units !== "number" ||
			!Number.isFinite(value.codex_rollout_budget_units)
		) {
			return;
		}
		usage.codex_rollout_budget_units = value.codex_rollout_budget_units;
	}
	return usage;
}

function projectCompletedResponse(value: unknown) {
	if (
		!isPlainRecord(value) ||
		typeof value.id !== "string" ||
		value.status !== "completed"
	) {
		return;
	}
	const response: Record<string, unknown> = {
		id: value.id,
		status: "completed",
	};
	if (value.usage !== undefined) {
		const usage = projectUsage(value.usage);
		if (usage === undefined) return;
		response.usage = usage;
	}
	if (value.end_turn !== undefined) {
		if (typeof value.end_turn !== "boolean") return;
		response.end_turn = value.end_turn;
	}
	return response;
}

function nonNegativeInteger(value: unknown) {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function projectHandledEvent(value: Record<string, unknown>) {
	const projected: Record<string, unknown> = { type: value.type };
	switch (value.type) {
		case "response.created":
			if (!isPlainRecord(value.response)) return;
			projected.response = {};
			return projected;
		case "response.output_item.added":
		case "response.output_item.done": {
			const item = projectResponseItem(value.item);
			if (!item) return;
			projected.item = item;
			return projected;
		}
		case "response.output_text.delta":
			if (typeof value.delta !== "string") return;
			projected.delta = value.delta;
			return projected;
		case "response.custom_tool_call_input.delta":
			if (
				typeof value.delta !== "string" ||
				(typeof value.item_id !== "string" && typeof value.call_id !== "string")
			) {
				return;
			}
			projected.delta = value.delta;
			if (!optionalString(value, "item_id", projected)) return;
			if (!optionalString(value, "call_id", projected)) return;
			return projected;
		case "response.reasoning_summary_text.delta":
			if (
				typeof value.delta !== "string" ||
				!nonNegativeInteger(value.summary_index)
			) {
				return;
			}
			projected.delta = value.delta;
			projected.summary_index = value.summary_index;
			return projected;
		case "response.reasoning_summary_text.done":
			if (
				typeof value.item_id !== "string" ||
				typeof value.text !== "string" ||
				!nonNegativeInteger(value.summary_index)
			) {
				return;
			}
			projected.item_id = value.item_id;
			projected.text = value.text;
			projected.summary_index = value.summary_index;
			return projected;
		case "response.reasoning_text.delta":
			if (
				typeof value.delta !== "string" ||
				!nonNegativeInteger(value.content_index)
			) {
				return;
			}
			projected.delta = value.delta;
			projected.content_index = value.content_index;
			return projected;
		case "response.reasoning_summary_part.added":
			if (!nonNegativeInteger(value.summary_index)) return;
			projected.summary_index = value.summary_index;
			return projected;
		case "response.completed": {
			const response = projectCompletedResponse(value.response);
			if (!response) return;
			projected.response = response;
			return projected;
		}
		default:
			return;
	}
}

const ignoredPinnedCodexEvents = new Set([
	"codex.response.metadata",
	"response.content_part.added",
	"response.content_part.done",
	"response.custom_tool_call_input.done",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.in_progress",
	"response.metadata",
	"response.output_text.done",
	"response.reasoning_summary_part.done",
]);

function encodeValidatedEvent(
	event: EventSourceMessage,
	credentials: readonly string[],
) {
	if (
		event.id !== undefined ||
		Buffer.byteLength(event.data) > maximumEventBytes
	) {
		return { state: "invalid" as const };
	}
	let value: unknown;
	try {
		value = JSON.parse(event.data);
	} catch {
		return { state: "invalid" as const };
	}
	if (
		!isPlainRecord(value) ||
		typeof value.type !== "string" ||
		(event.event !== undefined && event.event !== value.type) ||
		containsUnsafeModelData(value, credentials)
	) {
		return { state: "invalid" as const };
	}
	if (
		value.type === "response.failed" ||
		value.type === "response.incomplete" ||
		value.type === "error"
	) {
		return { state: "failed" as const };
	}
	if (value.type === "response.completed") {
		const projected = projectHandledEvent(value);
		if (!projected) return { state: "invalid" as const };
		return {
			state: "completed" as const,
			encoded: `${event.event ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(projected)}\n\n`,
		};
	}
	if (ignoredPinnedCodexEvents.has(value.type)) {
		return { state: "ignored" as const };
	}
	const projected = projectHandledEvent(value);
	if (!projected) return { state: "invalid" as const };
	return {
		state: "event" as const,
		encoded: `${event.event ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(projected)}\n\n`,
	};
}

function hasTerminatingBlankLine(value: string) {
	return /(?:\r\n|\r|\n)(?:\r\n|\r|\n)$/.test(value);
}

async function forwardValidatedStream(
	body: ReadableStream<Uint8Array>,
	response: ServerResponse,
	controller: AbortController,
	credentials: readonly string[],
) {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let failed = false;
	let terminal: string | undefined;
	let totalBytes = 0;
	let eventCount = 0;
	let ending = "";
	let queued: string[] = [];
	const parser = createParser({
		maxBufferSize: maximumEventBytes,
		onComment: () => {},
		onError: () => {
			failed = true;
		},
		onRetry: () => {
			failed = true;
		},
		onEvent: (event) => {
			eventCount += 1;
			if (eventCount > maximumStreamEvents || terminal) {
				failed = true;
				return;
			}
			const result = encodeValidatedEvent(event, credentials);
			if (result.state === "invalid" || result.state === "failed") {
				failed = true;
				return;
			}
			if (result.state === "completed") terminal = result.encoded;
			else if (result.state === "event") queued.push(result.encoded);
		},
	});

	try {
		for await (const chunk of body) {
			if (controller.signal.aborted) throw new Error();
			totalBytes += chunk.byteLength;
			if (totalBytes > maximumStreamBytes) failed = true;
			const decoded = decoder.decode(chunk, { stream: true });
			ending = `${ending}${decoded}`.slice(-4);
			if (!failed) parser.feed(decoded);
			for (const encoded of queued) {
				if (!response.headersSent) {
					response.writeHead(200, { "content-type": "text/event-stream" });
				}
				await write(response, encoded);
			}
			queued = [];
			if (failed) break;
		}
		if (!failed) {
			const decoded = decoder.decode();
			ending = `${ending}${decoded}`.slice(-4);
			parser.feed(decoded);
		}
	} catch {
		failed = true;
	}

	if (failed || !terminal || !hasTerminatingBlankLine(ending)) {
		controller.abort();
		await body.cancel().catch(() => {});
		await failStream(response);
		return;
	}
	if (!response.headersSent) {
		response.writeHead(200, { "content-type": "text/event-stream" });
	}
	await write(response, terminal);
	response.end();
}

function validatedRoutes(input: readonly CodexModelRoute[]) {
	if (!Array.isArray(input) || input.length === 0 || input.length > 128) {
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	}
	const routes = new Map<
		string,
		CodexModelAccess & { model: string; target: URL }
	>();
	for (const inputRoute of input) {
		if (
			!isPlainRecord(inputRoute) ||
			Object.keys(inputRoute).length !== 4 ||
			typeof inputRoute.internalModel !== "string" ||
			!internalModelPattern.test(inputRoute.internalModel) ||
			typeof inputRoute.model !== "string" ||
			!realModelPattern.test(inputRoute.model) ||
			routes.has(inputRoute.internalModel)
		) {
			throw new Error("RUNTIME_CONFIGURATION_INVALID");
		}
		const access = validateModelAccess({
			endpoint: inputRoute.endpoint,
			credential: inputRoute.credential,
		});
		if (!access) throw new Error("RUNTIME_CONFIGURATION_INVALID");
		routes.set(inputRoute.internalModel, {
			...access,
			model: inputRoute.model,
			target: new URL(`${access.endpoint.replace(/\/$/, "")}/responses`),
		});
	}
	return routes;
}

function decodeRequestBody(bytes: Buffer, encoding: string | undefined) {
	if (encoding === undefined) return bytes;
	if (encoding === "gzip") {
		return gunzipSync(bytes, { maxOutputLength: maximumRequestBytes });
	}
	if (encoding === "zstd") {
		return zstdDecompressSync(bytes, { maxOutputLength: maximumRequestBytes });
	}
	throw new Error();
}

function encodeRequestBody(bytes: Buffer, encoding: string | undefined) {
	if (encoding === undefined) return bytes;
	if (encoding === "gzip") return gzipSync(bytes);
	if (encoding === "zstd") return zstdCompressSync(bytes);
	throw new Error();
}

function routedRequest(
	bytes: Buffer,
	encoding: string | undefined,
	routes: ReadonlyMap<
		string,
		CodexModelAccess & { model: string; target: URL }
	>,
) {
	const decoded = decodeRequestBody(bytes, encoding);
	if (decoded.byteLength > maximumRequestBytes) throw new Error();
	const value: unknown = JSON.parse(utf8.decode(decoded));
	if (!isPlainRecord(value) || typeof value.model !== "string") {
		throw new Error();
	}
	const route = routes.get(value.model);
	if (!route) return;
	const body = Buffer.from(JSON.stringify({ ...value, model: route.model }));
	return { route, body: encodeRequestBody(body, encoding) };
}

export async function openCodexModelTransport(
	input: readonly CodexModelRoute[],
) {
	const routes = validatedRoutes(input);
	const credentials = [
		...new Set([...routes.values()].map(({ credential }) => credential)),
	];
	const token = randomBytes(32).toString("base64url");
	const expectedAuthorization = Buffer.from(`Bearer ${token}`);
	const active = new Set<ActiveTurnRequest>();
	const activeTurns = new Map<string, Set<ActiveTurnRequest>>();
	const admittedTurns = new Set<string>();
	const blockedTurns = new Set<string>();
	const admissionWaiters = new Map<string, Set<(admitted: boolean) => void>>();
	let closing = false;
	const settleAdmissionWaiters = (key: string, admitted: boolean) => {
		const waiters = admissionWaiters.get(key);
		if (!waiters) return;
		admissionWaiters.delete(key);
		for (const settle of waiters) settle(admitted);
	};
	const waitForAdmission = (key: string, signal: AbortSignal) => {
		if (admittedTurns.has(key)) return Promise.resolve(true);
		if (closing || blockedTurns.has(key) || signal.aborted) {
			return Promise.resolve(false);
		}
		return new Promise<boolean>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiters = admissionWaiters.get(key) ?? new Set();
			admissionWaiters.set(key, waiters);
			const settle = (admitted: boolean) => {
				if (timer !== undefined) clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				waiters.delete(settle);
				if (waiters.size === 0 && admissionWaiters.get(key) === waiters) {
					admissionWaiters.delete(key);
				}
				resolve(admitted);
			};
			const abort = () => settle(false);
			waiters.add(settle);
			signal.addEventListener("abort", abort, { once: true });
			timer = setTimeout(() => settle(false), turnAdmissionTimeoutMs);
			if (admittedTurns.has(key)) settle(true);
			else if (closing || blockedTurns.has(key) || signal.aborted)
				settle(false);
		});
	};
	const server = createServer(async (request, response) => {
		const suppliedAuthorization = Buffer.from(
			request.headers.authorization ?? "",
		);
		if (
			suppliedAuthorization.length !== expectedAuthorization.length ||
			!timingSafeEqual(suppliedAuthorization, expectedAuthorization)
		) {
			reject(response, 401);
			return;
		}
		if (request.method !== "POST" || request.url !== "/responses") {
			reject(response, 404);
			return;
		}
		const contentEncoding = request.headers["content-encoding"];
		if (
			Array.isArray(contentEncoding) ||
			(contentEncoding !== undefined &&
				contentEncoding !== "gzip" &&
				contentEncoding !== "zstd")
		) {
			reject(response, 400);
			return;
		}
		const nativeTurn = nativeTurnFromHeaders(
			request.headers["x-codex-turn-metadata"],
			request.headers["x-client-request-id"],
		);
		if (!nativeTurn) {
			reject(response, 400);
			return;
		}
		const turnKey = nativeTurnKey(nativeTurn);
		const controller = new AbortController();
		let completeRequest: (() => void) | undefined;
		const completion = new Promise<void>((resolve) => {
			completeRequest = resolve;
		});
		const terminate = () => {
			controller.abort();
			request.destroy();
			if (!response.destroyed && !response.writableEnded) response.destroy();
		};
		const activeTurn = { terminate, completion };
		active.add(activeTurn);
		const turnRequests = activeTurns.get(turnKey) ?? new Set();
		turnRequests.add(activeTurn);
		activeTurns.set(turnKey, turnRequests);
		request.once("aborted", terminate);
		response.once("close", terminate);
		try {
			if (!(await waitForAdmission(turnKey, controller.signal))) {
				reject(response, 409);
				return;
			}
			const chunks: Buffer[] = [];
			let length = 0;
			for await (const chunk of request) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				length += bytes.length;
				if (length > maximumRequestBytes) throw new Error();
				chunks.push(bytes);
			}
			if (controller.signal.aborted) throw new Error();
			const routed = routedRequest(
				Buffer.concat(chunks),
				contentEncoding,
				routes,
			);
			if (!routed) {
				reject(response, 400);
				return;
			}
			const upstream = await fetch(routed.route.target, {
				method: "POST",
				headers: {
					authorization: `Bearer ${routed.route.credential}`,
					"content-type": "application/json",
					...(contentEncoding ? { "content-encoding": contentEncoding } : {}),
				},
				body: routed.body,
				redirect: "manual",
				signal: AbortSignal.any([
					controller.signal,
					AbortSignal.timeout(requestTimeoutMs),
				]),
			});
			const contentType = upstream.headers.get("content-type") ?? "";
			if (
				!upstream.ok ||
				!upstream.body ||
				!/^text\/event-stream(?:\s*;|$)/i.test(contentType)
			) {
				await upstream.body?.cancel().catch(() => {});
				reject(
					response,
					upstream.status === 401 || upstream.status === 403
						? upstream.status
						: 502,
				);
				return;
			}
			await forwardValidatedStream(
				upstream.body,
				response,
				controller,
				credentials,
			);
		} catch {
			await failStream(response);
		} finally {
			request.off("aborted", terminate);
			response.off("close", terminate);
			active.delete(activeTurn);
			turnRequests.delete(activeTurn);
			if (turnRequests.size === 0) activeTurns.delete(turnKey);
			completeRequest?.();
		}
	});
	server.requestTimeout = requestTimeoutMs;
	server.headersTimeout = 10_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("RUNTIME_STARTUP_FAILED");
	}
	let closePromise: Promise<void> | undefined;
	return {
		modelAccess: {
			endpoint: `http://127.0.0.1:${address.port}`,
			credential: token,
		},
		registerTurn: (turn: CodexNativeTurn) => {
			const key = nativeTurnKey(turn);
			if (closing || blockedTurns.has(key)) return;
			admittedTurns.add(key);
			settleAdmissionWaiters(key, true);
		},
		cancelTurn: async (turn: CodexNativeTurn) => {
			const key = nativeTurnKey(turn);
			admittedTurns.delete(key);
			blockedTurns.add(key);
			settleAdmissionWaiters(key, false);
			const requests = [...(activeTurns.get(key) ?? [])];
			for (const request of requests) request.terminate();
			await Promise.all(requests.map(({ completion }) => completion));
		},
		close: () => {
			closePromise ??= (async () => {
				closing = true;
				for (const key of admissionWaiters.keys()) {
					settleAdmissionWaiters(key, false);
				}
				const requests = [...active];
				for (const request of requests) request.terminate();
				const closed = new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				});
				await Promise.all([
					closed,
					...requests.map(({ completion }) => completion),
				]);
			})();
			return closePromise;
		},
	};
}
