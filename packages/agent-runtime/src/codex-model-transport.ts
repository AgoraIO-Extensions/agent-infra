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
import { createCredentialMatcher } from "./model-credential-matcher.js";

const maximumRequestBytes = 8 * 1024 * 1024;
const maximumEventBytes = 1024 * 1024;
const maximumStreamBytes = 16 * 1024 * 1024;
const maximumStreamEvents = 8_192;
const maximumConversationAccessEntries = 1_024;
const requestTimeoutMs = 120_000;
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

export interface CodexModelTurn extends CodexNativeTurn {
	/** Bound by the server to one native process, never read from HTTP metadata. */
	readonly conversationKey: string;
}

export interface CodexModelRequestContext extends CodexModelTurn {
	readonly internalModel: string;
	readonly reasoningLevel: string;
}

export interface CodexModelRequestUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cachedInputTokens?: number;
}

export type CodexModelRequestOutcome = {
	readonly durationMs?: number;
	readonly finishedAt?: string;
} & (
	| { readonly phase: "succeeded"; readonly usage?: CodexModelRequestUsage }
	| {
			readonly phase: "failed" | "unknown";
			readonly failureCode:
				| "request_not_started"
				| "http_error"
				| "provider_error"
				| "transport_error"
				| "invalid_response"
				| "interrupted";
	  }
);

export interface CodexModelRequestJournal {
	/** Called only after the actual fetch has been invoked. */
	started(startedAt: string): Promise<void>;
	/** Must commit before a terminal response can be published to native. */
	finish(outcome: CodexModelRequestOutcome): Promise<void>;
}

export interface CodexModelTransportObserver {
	/** Persists intent and checks current authorization before permitting fetch. */
	beforeRequest(
		context: CodexModelRequestContext,
		signal: AbortSignal,
	): Promise<CodexModelRequestJournal>;
}

declare const codexModelTurnAdmissionBrand: unique symbol;

export interface CodexModelTurnAdmission {
	readonly [codexModelTurnAdmissionBrand]: true;
}

interface ActiveTurnRequest {
	readonly terminate: () => void;
	readonly completion: Promise<void>;
}

interface ModelTurnSelection {
	readonly internalModel: string;
	readonly reasoningLevel: string;
}

interface AdmissionWaiter {
	readonly admission: CodexModelTurnAdmission;
	readonly settle: (model: ModelTurnSelection | undefined) => void;
}

interface ModelRequestWaiter {
	readonly settle: (ready: boolean) => void;
}

interface ModelTurnAdmissionState extends ModelTurnSelection {
	state: "open" | "consumed" | "closed";
	readonly deadline: number;
	readonly threadKey: string;
	turnKey?: string;
	timer?: ReturnType<typeof setTimeout>;
}

function reject(response: ServerResponse, status = 502) {
	if (response.destroyed || response.writableEnded) return;
	response.writeHead(status, { "content-type": "application/json" });
	response.end(sanitizedFailureBody);
}

async function write(response: ServerResponse, value: string) {
	if (response.destroyed || response.writableEnded) throw new Error();
	if (response.write(value)) return;
	const pending = new AbortController();
	try {
		await Promise.race([
			once(response, "drain", { signal: pending.signal }),
			once(response, "close", { signal: pending.signal }).then(() =>
				Promise.reject(new Error()),
			),
		]);
	} finally {
		pending.abort();
	}
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

async function awaitPersistence<T>(
	operation: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) throw new Error();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	const interrupted = new Promise<never>((_, reject) => {
		abort = () => reject(new Error());
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => reject(new Error()), requestTimeoutMs);
	});
	try {
		return await Promise.race([operation, interrupted]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (abort) signal?.removeEventListener("abort", abort);
	}
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

function nativeThreadKey(conversationKey: string, threadId: string) {
	return `${conversationKey}\u0000${threadId}`;
}

function nativeTurnKey(turn: CodexModelTurn) {
	if (
		!isPlainRecord(turn) ||
		Object.keys(turn).length !== 3 ||
		!/^[a-f0-9]{64}$/.test(turn.conversationKey) ||
		!nativeTurnIdentifierPattern.test(turn.threadId) ||
		!nativeTurnIdentifierPattern.test(turn.turnId)
	) {
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	}
	return `${nativeThreadKey(turn.conversationKey, turn.threadId)}\u0000${turn.turnId}`;
}

function containsUnsafeModelData(
	value: unknown,
	credentialMatcher: ReturnType<typeof createCredentialMatcher>,
): boolean {
	if (typeof value === "string") return credentialMatcher.contains(value);
	if (Array.isArray(value)) {
		return value.some((item) =>
			containsUnsafeModelData(item, credentialMatcher),
		);
	}
	if (!isPlainRecord(value)) return false;
	return Object.entries(value).some(
		([key, nested]) =>
			(key === "error" && nested !== null) ||
			credentialMatcher.contains(key) ||
			containsUnsafeModelData(nested, credentialMatcher),
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
			if (value.role !== "assistant") return;
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

function semanticPayload(
	event: Record<string, unknown>,
	credentialMatcher: ReturnType<typeof createCredentialMatcher>,
) {
	let visited = 0;
	let bytes = 0;
	const channels = new Map<string, string[]>();
	const collect = (channel: string, root: unknown): boolean => {
		const pending = [{ value: root, depth: 0 }];
		const strings = channels.get(channel) ?? [];
		channels.set(channel, strings);
		while (pending.length > 0) {
			const entry = pending.pop();
			if (!entry) break;
			if (++visited > 16384 || entry.depth > 32) return false;
			const value = entry.value;
			if (typeof value === "string") {
				bytes += Buffer.byteLength(value);
				if (bytes > maximumEventBytes || credentialMatcher.contains(value))
					return false;
				strings.push(value);
			} else if (Array.isArray(value)) {
				for (let index = value.length - 1; index >= 0; index -= 1)
					pending.push({ value: value[index], depth: entry.depth + 1 });
			} else if (isPlainRecord(value)) {
				const entries = Object.entries(value);
				for (let index = entries.length - 1; index >= 0; index -= 1) {
					const pair = entries[index];
					if (!pair || credentialMatcher.contains(pair[0])) return false;
					pending.push({ value: pair[1], depth: entry.depth + 1 });
				}
			}
		}
		return true;
	};
	const argumentsPayload = (value: unknown) => {
		if (typeof value !== "string") return collect("tool-arguments", value);
		let decoded: unknown;
		try {
			decoded = JSON.parse(value);
		} catch {
			return collect("tool-arguments", value);
		}
		return collect("tool-arguments", decoded);
	};
	const textItems = (value: unknown) =>
		Array.isArray(value)
			? value.map((entry) => (isPlainRecord(entry) ? entry.text : undefined))
			: [];
	const deltaChannel =
		event.type === "response.output_text.delta"
			? "message"
			: event.type === "response.custom_tool_call_input.delta"
				? "tool-arguments"
				: event.type === "response.reasoning_text.delta" ||
						event.type === "response.reasoning_summary_text.delta"
					? "reasoning"
					: undefined;
	if (deltaChannel && !collect(deltaChannel, event.delta)) return undefined;
	if (
		event.type === "response.reasoning_summary_text.done" &&
		!collect("reasoning", event.text)
	)
		return undefined;
	const items =
		event.type === "response.completed"
			? isPlainRecord(event.response) && Array.isArray(event.response.output)
				? event.response.output
				: []
			: (event.type === "response.output_item.added" ||
						event.type === "response.output_item.done") &&
					isPlainRecord(event.item)
				? [event.item]
				: [];
	for (const candidate of items) {
		if (!isPlainRecord(candidate)) continue;
		switch (candidate.type) {
			case "message":
				if (!collect("message", textItems(candidate.content))) return undefined;
				break;
			case "reasoning":
				if (
					!collect("reasoning", [
						textItems(candidate.summary),
						textItems(candidate.content),
					])
				)
					return undefined;
				if (!collect("encrypted", candidate.encrypted_content))
					return undefined;
				break;
			case "compaction":
			case "compaction_summary":
				if (!collect("encrypted", candidate.encrypted_content))
					return undefined;
				break;
			case "function_call":
				if (
					!argumentsPayload(candidate.arguments) ||
					!collect("encrypted-arguments", candidate.encrypted_function_args)
				)
					return undefined;
				break;
			case "custom_tool_call":
				if (!argumentsPayload(candidate.input)) return undefined;
				break;
			case "tool_search_call":
				if (!argumentsPayload(candidate.arguments)) return undefined;
				break;
			case "web_search_call":
				if (
					isPlainRecord(candidate.action) &&
					!collect("search", [
						candidate.action.query,
						candidate.action.url,
						candidate.action.pattern,
						candidate.action.queries,
					])
				)
					return undefined;
				break;
			case "image_generation_call":
				if (!collect("image", [candidate.result, candidate.revised_prompt]))
					return undefined;
				break;
		}
	}
	return channels;
}

function encodeValidatedEvent(
	event: EventSourceMessage,
	credentialMatcher: ReturnType<typeof createCredentialMatcher>,
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
		containsUnsafeModelData(value, credentialMatcher)
	) {
		return { state: "invalid" as const };
	}
	const rawPayload = semanticPayload(value, credentialMatcher);
	if (
		!rawPayload ||
		[...rawPayload.values()].some((strings) =>
			credentialMatcher.contains(strings.join("")),
		)
	)
		return { state: "invalid" as const };
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
			projected,
			encoded: `${event.event ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(projected)}\n\n`,
		};
	}
	if (ignoredPinnedCodexEvents.has(value.type)) {
		return { state: "ignored" as const };
	}
	const projected = projectHandledEvent(value);
	if (!projected) return { state: "invalid" as const };
	const payload = semanticPayload(projected, credentialMatcher);
	if (!payload) return { state: "invalid" as const };
	return {
		state: "event" as const,
		projected,
		payload,
		encoded: `${event.event ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(projected)}\n\n`,
	};
}

// Matcher state retains only a possible credential prefix per semantic channel.
function credentialStreamGuard(
	credentialMatcher: ReturnType<typeof createCredentialMatcher>,
) {
	const channels = new Map<string, number>();
	return {
		accept(
			value: Record<string, unknown>,
			payload: ReadonlyMap<string, readonly string[]>,
		) {
			for (const [channel, strings] of payload) {
				const text = strings.join("");
				if (!text) continue;
				const keys = ["all", channel];
				const item = isPlainRecord(value.item) ? value.item : {};
				const identifiers = {
					item: value.item_id ?? item.id,
					call: value.call_id ?? item.call_id,
					summary_index: value.summary_index,
					content_index: value.content_index,
				};
				for (const [field, identifier] of Object.entries(identifiers)) {
					if (identifier !== undefined)
						keys.push(JSON.stringify([channel, field, identifier]));
				}
				for (const key of keys) {
					const result = credentialMatcher.advance(
						channels.get(key) ?? 0,
						text,
					);
					if (result.matched) return false;
					if (result.state > 0) channels.set(key, result.state);
					else channels.delete(key);
				}
			}
			return true;
		},
		pending: () => channels.size > 0,
	};
}

function hasTerminatingBlankLine(value: string) {
	return /(?:\r\n|\r|\n)(?:\r\n|\r|\n)$/.test(value);
}

async function forwardValidatedStream(
	body: ReadableStream<Uint8Array>,
	response: ServerResponse,
	controller: AbortController,
	credentialMatcher: ReturnType<typeof createCredentialMatcher>,
	recordOutcome: (outcome: CodexModelRequestOutcome) => Promise<void>,
) {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let failed = false;
	let terminal: string | undefined;
	let usage: CodexModelRequestUsage | undefined;
	const failure: {
		code: "provider_error" | "transport_error" | "invalid_response";
	} = { code: "invalid_response" };
	let totalBytes = 0;
	let eventCount = 0;
	let ending = "";
	let queued: string[] = [];
	let pending: string[] = [];
	let pendingBytes = 0;
	const guard = credentialStreamGuard(credentialMatcher);
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
			if (failed) return;
			eventCount += 1;
			if (eventCount > maximumStreamEvents || terminal) {
				failed = true;
				return;
			}
			const result = encodeValidatedEvent(event, credentialMatcher);
			if (result.state === "invalid" || result.state === "failed") {
				if (result.state === "failed") failure.code = "provider_error";
				failed = true;
				return;
			}
			if (result.state === "completed") {
				terminal = result.encoded;
				const completedResponse = result.projected.response;
				const observedUsage = isPlainRecord(completedResponse)
					? completedResponse.usage
					: undefined;
				if (isPlainRecord(observedUsage)) {
					const details = observedUsage.input_tokens_details;
					usage = {
						...(typeof observedUsage.input_tokens === "number"
							? { inputTokens: observedUsage.input_tokens }
							: {}),
						...(typeof observedUsage.output_tokens === "number"
							? { outputTokens: observedUsage.output_tokens }
							: {}),
						...(isPlainRecord(details) &&
						typeof details.cached_tokens === "number"
							? { cachedInputTokens: details.cached_tokens }
							: {}),
					};
				}
			} else if (result.state === "event") {
				if (!guard.accept(result.projected, result.payload)) {
					failed = true;
					return;
				}
				pending.push(result.encoded);
				pendingBytes += Buffer.byteLength(result.encoded);
				if (pendingBytes > 2 * maximumEventBytes || pending.length > 256) {
					failed = true;
					return;
				}
				if (!guard.pending()) {
					queued.push(...pending);
					pending = [];
					pendingBytes = 0;
				}
			}
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
			if (failed) break;
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
		failure.code = "transport_error";
	}

	if (failed || !terminal || !hasTerminatingBlankLine(ending)) {
		const interrupted = controller.signal.aborted;
		controller.abort();
		await body.cancel().catch(() => {});
		await recordOutcome({
			phase: failure.code === "provider_error" ? "failed" : "unknown",
			failureCode: interrupted ? "interrupted" : failure.code,
		});
		await failStream(response);
		return;
	}
	await recordOutcome({ phase: "succeeded", ...(usage ? { usage } : {}) });
	if (!response.headersSent) {
		response.writeHead(200, { "content-type": "text/event-stream" });
	}
	for (const encoded of pending) await write(response, encoded);
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
	admittedModel: ModelTurnSelection,
) {
	const decoded = decodeRequestBody(bytes, encoding);
	if (decoded.byteLength > maximumRequestBytes) throw new Error();
	const value: unknown = JSON.parse(utf8.decode(decoded));
	if (!isPlainRecord(value) || typeof value.model !== "string") {
		throw new Error();
	}
	if (value.model !== admittedModel.internalModel) return;
	const route = routes.get(admittedModel.internalModel);
	if (!route) return;
	if (value.reasoning !== undefined && !isPlainRecord(value.reasoning)) return;
	const body = Buffer.from(
		JSON.stringify({
			...value,
			model: route.model,
			reasoning: {
				...(value.reasoning as Record<string, unknown> | undefined),
				effort: admittedModel.reasoningLevel,
			},
		}),
	);
	return { route, body: encodeRequestBody(body, encoding) };
}

export async function openCodexModelTransport(
	input: readonly CodexModelRoute[],
	observer: CodexModelTransportObserver,
) {
	if (!observer || typeof observer.beforeRequest !== "function")
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	const routes = validatedRoutes(input);
	const credentials = [
		...new Set([...routes.values()].map(({ credential }) => credential)),
	];
	const credentialMatcher = createCredentialMatcher(credentials);
	const processAccess = new Map<
		string,
		{ credential: string; authorization: Buffer }
	>();
	const boundThreads = new Set<string>();
	const active = new Set<ActiveTurnRequest>();
	const activeTurns = new Map<string, Set<ActiveTurnRequest>>();
	const admittedTurns = new Map<string, ModelTurnSelection>();
	// Explicit cancellation is final for this token's lifetime; abandoning a
	// provisional capability alone must not prevent validated running recovery.
	const revokedTurns = new Set<string>();
	const recognizedTurns = new Map<string, Set<CodexModelTurnAdmission>>();
	const admissions = new WeakMap<
		CodexModelTurnAdmission,
		ModelTurnAdmissionState
	>();
	const pendingThreads = new Map<string, Set<CodexModelTurnAdmission>>();
	const admissionWaiters = new Map<string, Set<AdmissionWaiter>>();
	const modelRequestWaiters = new Map<string, Set<ModelRequestWaiter>>();
	const readyModelTurns = new Set<string>();
	let closing = false;
	const conversationIsActive = (conversationKey: string) => {
		const prefix = `${conversationKey}\u0000`;
		return (
			[...boundThreads].some((key) => key.startsWith(prefix)) ||
			[...admittedTurns.keys()].some((key) => key.startsWith(prefix)) ||
			[...activeTurns.keys()].some((key) => key.startsWith(prefix)) ||
			[...pendingThreads.keys()].some((key) => key.startsWith(prefix)) ||
			[...recognizedTurns.keys()].some((key) => key.startsWith(prefix)) ||
			[...admissionWaiters.keys()].some((key) => key.startsWith(prefix)) ||
			[...modelRequestWaiters.keys()].some((key) => key.startsWith(prefix))
		);
	};
	const evictInactiveConversation = (conversationKey: string) => {
		if (conversationIsActive(conversationKey)) return false;
		const prefix = `${conversationKey}\u0000`;
		processAccess.delete(conversationKey);
		for (const key of boundThreads)
			if (key.startsWith(prefix)) boundThreads.delete(key);
		for (const key of readyModelTurns)
			if (key.startsWith(prefix)) readyModelTurns.delete(key);
		for (const key of revokedTurns)
			if (key.startsWith(prefix)) revokedTurns.delete(key);
		for (const key of admittedTurns.keys())
			if (key.startsWith(prefix)) admittedTurns.delete(key);
		return true;
	};
	const settleAdmissionWaiters = (
		key: string,
		model: ModelTurnSelection | undefined,
	) => {
		const waiters = admissionWaiters.get(key);
		if (!waiters) return;
		admissionWaiters.delete(key);
		for (const waiter of waiters) waiter.settle(model);
	};
	const settleModelRequestWaiters = (
		key: string,
		ready: boolean,
		rememberReady = ready,
	) => {
		if (ready && rememberReady) readyModelTurns.add(key);
		if (!ready) readyModelTurns.delete(key);
		const waiters = modelRequestWaiters.get(key);
		if (!waiters) return;
		modelRequestWaiters.delete(key);
		for (const waiter of waiters) waiter.settle(ready);
	};
	const removePending = (
		admission: CodexModelTurnAdmission,
		state: ModelTurnAdmissionState,
	) => {
		const pending = pendingThreads.get(state.threadKey);
		pending?.delete(admission);
		if (pending?.size === 0) pendingThreads.delete(state.threadKey);
	};
	const settleBoundWaiters = (
		admission: CodexModelTurnAdmission,
		acceptedKey?: string,
	) => {
		for (const [key, waiters] of admissionWaiters) {
			if (key === acceptedKey) continue;
			for (const waiter of [...waiters]) {
				if (waiter.admission === admission) waiter.settle(undefined);
			}
		}
	};
	const closeAdmission = (admission: CodexModelTurnAdmission) => {
		const state = admissions.get(admission);
		if (state?.state !== "open") return;
		state.state = "closed";
		removePending(admission, state);
		settleBoundWaiters(admission);
		if (state.timer !== undefined) clearTimeout(state.timer);
		if (state.turnKey !== undefined) {
			const recognized = recognizedTurns.get(state.turnKey);
			if (recognized) {
				recognized.delete(admission);
				if (recognized.size === 0) recognizedTurns.delete(state.turnKey);
			}
			if (
				!recognizedTurns.has(state.turnKey) &&
				!admittedTurns.has(state.turnKey)
			) {
				settleAdmissionWaiters(state.turnKey, undefined);
			}
		}
	};
	const revokeTurn = (key: string, settleWaiters = true) => {
		revokedTurns.add(key);
		if (settleWaiters) settleModelRequestWaiters(key, false);
		const recognized = recognizedTurns.get(key);
		for (const admission of [...(recognized ?? [])]) {
			closeAdmission(admission);
		}
		admittedTurns.delete(key);
		settleAdmissionWaiters(key, undefined);
		maybeUnbindThread(key);
	};
	const maybeUnbindThread = (turnKey: string) => {
		const threadKey = turnKey.slice(0, turnKey.lastIndexOf("\u0000"));
		if (
			[...activeTurns.keys()].some((key) => key.startsWith(`${threadKey}\u0000`)) ||
			[...admittedTurns.keys()].some((key) => key.startsWith(`${threadKey}\u0000`)) ||
			pendingThreads.has(threadKey) ||
			[...recognizedTurns.keys()].some((key) => key.startsWith(`${threadKey}\u0000`)) ||
			[...modelRequestWaiters.keys()].some((key) => key.startsWith(`${threadKey}\u0000`))
		)
			return;
		boundThreads.delete(threadKey);
	};
	const recognizeAdmissionWaiters = (
		admission: CodexModelTurnAdmission,
		key: string,
	) => {
		const state = admissions.get(admission);
		if (
			revokedTurns.has(key) ||
			state?.state !== "open" ||
			state.threadKey !== key.slice(0, key.lastIndexOf("\u0000")) ||
			state.deadline <= Date.now()
		) {
			closeAdmission(admission);
			return false;
		}
		if (state.turnKey !== undefined && state.turnKey !== key) {
			closeAdmission(admission);
			return false;
		}
		state.turnKey = key;
		const recognized = recognizedTurns.get(key) ?? new Set();
		recognizedTurns.set(key, recognized);
		recognized.add(admission);
		settleBoundWaiters(admission, key);
		return true;
	};
	const waitForAdmission = (key: string, signal: AbortSignal) => {
		if (revokedTurns.has(key)) return Promise.resolve(undefined);
		if (admittedTurns.has(key)) return Promise.resolve(admittedTurns.get(key));
		if (closing || signal.aborted) {
			return Promise.resolve(undefined);
		}
		const threadKey = key.slice(0, key.lastIndexOf("\u0000"));
		const pending = [...(pendingThreads.get(threadKey) ?? [])];
		if (pending.length !== 1) return Promise.resolve(undefined);
		const admission = pending[0];
		if (!admission) return Promise.resolve(undefined);
		const state = admissions.get(admission);
		if (
			state?.state !== "open" ||
			state.deadline <= Date.now() ||
			(state.turnKey !== undefined && state.turnKey !== key)
		)
			return Promise.resolve(undefined);
		return new Promise<ModelTurnSelection | undefined>((resolve) => {
			const waiters = admissionWaiters.get(key) ?? new Set();
			admissionWaiters.set(key, waiters);
			const settle = (model: ModelTurnSelection | undefined) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				waiters.delete(waiter);
				if (waiters.size === 0 && admissionWaiters.get(key) === waiters)
					admissionWaiters.delete(key);
				resolve(model);
			};
			const abort = () => settle(undefined);
			const waiter = { admission, settle };
			const timer = setTimeout(abort, state.deadline - Date.now());
			waiters.add(waiter);
			signal.addEventListener("abort", abort, { once: true });
		});
	};
	const waitForModelRequest = (
		turn: CodexModelTurn,
		deadline: number,
		signal?: AbortSignal,
	) => {
		const key = nativeTurnKey(turn);
		if (revokedTurns.has(key) || closing || signal?.aborted)
			return Promise.resolve(false);
		if (readyModelTurns.has(key)) return Promise.resolve(true);
		if (deadline <= Date.now()) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			const waiters = modelRequestWaiters.get(key) ?? new Set();
			modelRequestWaiters.set(key, waiters);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (ready: boolean) => {
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				waiters.delete(waiter);
				if (waiters.size === 0 && modelRequestWaiters.get(key) === waiters)
					modelRequestWaiters.delete(key);
				resolve(ready);
			};
			const abort = () => settle(false);
			const waiter = { settle };
			timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
			waiters.add(waiter);
			signal?.addEventListener("abort", abort, { once: true });
		});
	};
	const server = createServer(async (request, response) => {
		const suppliedAuthorization = Buffer.from(
			request.headers.authorization ?? "",
		);
		const authenticated = [...processAccess].find(
			([, access]) =>
				suppliedAuthorization.length === access.authorization.length &&
				timingSafeEqual(suppliedAuthorization, access.authorization),
		);
		if (!authenticated || closing) {
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
		const [conversationKey] = authenticated;
		// Reject a foreign or unbound native thread before it can touch admission,
		// cancellation, body parsing, or any journal owned by another process.
		if (
			!boundThreads.has(nativeThreadKey(conversationKey, nativeTurn.threadId))
		) {
			reject(response, 403);
			return;
		}
		const turnKey = nativeTurnKey({ ...nativeTurn, conversationKey });
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
		let journal: CodexModelRequestJournal | undefined;
		let journalPromise: Promise<CodexModelRequestJournal> | undefined;
		let startedPersistence: Promise<void> | undefined;
		let upstreamResult: Promise<{ value: Response | undefined }> | undefined;
		let startedAt: number | undefined;
		let outcomeReported = false;
		let outcomeReport: Promise<void> | undefined;
		const recordOutcome = async (outcome: CodexModelRequestOutcome) => {
			// A successfully persisted outcome is final. Concurrent callers share the
			// in-flight write; a failed write is cleared so the catch path can retry.
			if (outcomeReported) return;
			if (outcomeReport) return outcomeReport;
			if (outcome.phase !== "succeeded")
				revokeTurn(turnKey, startedAt === undefined);
			const pending = (async () => {
				// A persistence call may outlive the request abort/timeout. Join the
				// underlying intent and started writes before finishing the journal so a
				// late durable write can never appear after its terminal outcome.
				if (!journal && journalPromise) {
					try {
						// The request may already be aborted here. Keep the late intent
						// join bounded without reusing that signal, otherwise a stalled
						// observer can keep terminal cleanup alive forever.
						journal = await awaitPersistence(journalPromise);
					} catch {
						// The intent was not durably created; there is no journal to finish.
					}
				}
				if (startedPersistence) await startedPersistence.catch(() => {});
				if (!journal) {
					readyModelTurns.delete(turnKey);
					admittedTurns.delete(turnKey);
					maybeUnbindThread(turnKey);
					outcomeReported = true;
					return;
				}
				await awaitPersistence(
					journal.finish({
						...outcome,
						finishedAt: new Date().toISOString(),
						...(startedAt === undefined
							? {}
							: {
									durationMs: Math.max(
										0,
										Math.round(performance.now() - startedAt),
									),
								}),
					}),
				);
				readyModelTurns.delete(turnKey);
				admittedTurns.delete(turnKey);
				maybeUnbindThread(turnKey);
				outcomeReported = true;
			})();
			outcomeReport = pending;
			try {
				await pending;
			} finally {
				if (outcomeReport === pending) outcomeReport = undefined;
			}
		};
		try {
			const admittedModel = await waitForAdmission(turnKey, controller.signal);
			if (admittedModel === undefined) {
				settleModelRequestWaiters(turnKey, false);
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
			if (revokedTurns.has(turnKey)) {
				reject(response, 409);
				return;
			}
			const routed = routedRequest(
				Buffer.concat(chunks),
				contentEncoding,
				routes,
				admittedModel,
			);
			if (!routed) {
				reject(response, 400);
				return;
			}
			journalPromise = observer.beforeRequest(
				{
					conversationKey,
					...nativeTurn,
					...admittedModel,
				},
				controller.signal,
			);
			journal = await awaitPersistence(journalPromise, controller.signal);
			// Stop/revoke may arrive while intent or the Host authorization guard is
			// awaiting durable storage. No await separates this check from fetch.
			if (
				closing ||
				controller.signal.aborted ||
				revokedTurns.has(turnKey) ||
				processAccess.get(conversationKey) !== authenticated[1]
			) {
				await recordOutcome({
					phase: "failed",
					failureCode: "request_not_started",
				});
				reject(response, 409);
				return;
			}
			startedAt = performance.now();
			const requestStartedAt = new Date().toISOString();
			upstreamResult = fetch(routed.route.target, {
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
			}).then(
				(value) => ({ value }),
				() => ({ value: undefined }),
			);
			if (journal) {
				startedPersistence = journal.started(requestStartedAt);
				await awaitPersistence(startedPersistence, controller.signal);
			}
			const upstream = (await upstreamResult).value;
			if (!upstream) {
				settleModelRequestWaiters(turnKey, false);
				throw new Error();
			}
			const contentType = upstream.headers.get("content-type") ?? "";
			if (
				!upstream.ok ||
				!upstream.body ||
				!/^text\/event-stream(?:\s*;|$)/i.test(contentType)
			) {
				await upstream.body?.cancel().catch(() => {});
				await recordOutcome({
					phase: upstream.ok ? "unknown" : "failed",
					failureCode: upstream.ok ? "invalid_response" : "http_error",
				});
				// A non-streaming response is still an accepted model request. Notify
				// the Driver only after the durable failure fact is committed.
				// Wake a Driver that is still waiting for the initial request so it can
				// observe the durable failure, but never cache readiness for a revoked
				// Turn or allow a later request to bypass its fence.
				settleModelRequestWaiters(turnKey, true, false);
				reject(
					response,
					upstream.status === 401 || upstream.status === 403
						? upstream.status
						: 502,
				);
				return;
			}
			// Streaming model requests are accepted once the upstream headers are
			// available; the body may continue for the whole inference.
			settleModelRequestWaiters(turnKey, true);
			await forwardValidatedStream(
				upstream.body,
				response,
				controller,
				credentialMatcher,
				recordOutcome,
			);
		} catch {
			revokeTurn(turnKey);
			const interrupted = controller.signal.aborted;
			controller.abort();
			// started() can fail while fetch is already running. Join its abort and
			// release any received body before reporting this request drained.
			const received = await upstreamResult;
			await received?.value?.body?.cancel().catch(() => {});
			await recordOutcome(
				startedAt === undefined
					? { phase: "failed", failureCode: "request_not_started" }
					: {
							phase: "unknown",
							failureCode: interrupted ? "interrupted" : "transport_error",
						},
			).catch(() => {});
			settleModelRequestWaiters(turnKey, false);
			await failStream(response);
		} finally {
			request.off("aborted", terminate);
			response.off("close", terminate);
			active.delete(activeTurn);
			turnRequests.delete(activeTurn);
			if (turnRequests.size === 0) activeTurns.delete(turnKey);
			maybeUnbindThread(turnKey);
			completeRequest?.();
		}
	});
	server.requestTimeout = requestTimeoutMs;
	server.headersTimeout = 10_000;
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, "127.0.0.1");
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("RUNTIME_STARTUP_FAILED");
	}
	let closePromise: Promise<void> | undefined;
	const endpoint = `http://127.0.0.1:${address.port}`;
	return {
		endpoint,
		modelAccessFor: (conversationKey: string): CodexModelAccess => {
			if (closing || !/^[a-f0-9]{64}$/.test(conversationKey))
				throw new Error("RUNTIME_STARTUP_FAILED");
			let access = processAccess.get(conversationKey);
			if (!access) {
				if (processAccess.size >= maximumConversationAccessEntries) {
					for (const candidate of processAccess.keys()) {
						if (evictInactiveConversation(candidate)) break;
					}
					if (processAccess.size >= maximumConversationAccessEntries)
						throw new Error("RUNTIME_MODEL_ACCESS_CAPACITY");
				}
				const credential = randomBytes(32).toString("base64url");
				access = {
					credential,
					authorization: Buffer.from(`Bearer ${credential}`),
				};
				processAccess.set(conversationKey, access);
			} else {
				// Keep recently used conversations at the end of the bounded map so
				// eviction prefers the oldest idle access.
				processAccess.delete(conversationKey);
				processAccess.set(conversationKey, access);
			}
			return { endpoint, credential: access.credential };
		},
		bindThread: (conversationKey: string, threadId: string) => {
			if (
				closing ||
				!processAccess.has(conversationKey) ||
				!nativeTurnIdentifierPattern.test(threadId)
			)
				throw new Error("RUNTIME_STARTUP_FAILED");
			boundThreads.add(nativeThreadKey(conversationKey, threadId));
		},
		revokeConversationAccess: (conversationKey: string) => {
			processAccess.delete(conversationKey);
			const prefix = `${conversationKey}\u0000`;
			for (const key of boundThreads)
				if (key.startsWith(prefix)) boundThreads.delete(key);
			for (const [key, pending] of pendingThreads) {
				if (key.startsWith(prefix))
					for (const admission of [...pending]) closeAdmission(admission);
			}
			const turnKeys = new Set([
				...recognizedTurns.keys(),
				...admittedTurns.keys(),
				...modelRequestWaiters.keys(),
			]);
			for (const key of turnKeys) if (key.startsWith(prefix)) revokeTurn(key);
			for (const [key, requests] of activeTurns) {
				if (key.startsWith(prefix))
					for (const request of requests) request.terminate();
			}
		},
		waitForModelRequest,
		beginTurnAdmission: (
			deadline: number,
			internalModel: string,
			threadId: string,
			reasoningLevel: string,
			conversationKey: string,
		) => {
			const threadKey = nativeThreadKey(conversationKey, threadId);
			const admission = Object.freeze({}) as CodexModelTurnAdmission;
			const state: ModelTurnAdmissionState = {
				state:
					typeof reasoningLevel === "string" &&
					/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(reasoningLevel) &&
					typeof threadId === "string" &&
					nativeTurnIdentifierPattern.test(threadId) &&
					Number.isFinite(deadline) &&
					deadline > Date.now() &&
					!closing &&
					processAccess.has(conversationKey) &&
					boundThreads.has(threadKey) &&
					routes.has(internalModel)
						? "open"
						: "closed",
				deadline,
				threadKey,
				internalModel,
				reasoningLevel,
			};
			if (state.state === "open") {
				const pending = pendingThreads.get(threadKey) ?? new Set();
				pendingThreads.set(threadKey, pending);
				pending.add(admission);
				if (pending.size > 1) {
					for (const existing of pending) settleBoundWaiters(existing);
				}
				state.timer = setTimeout(
					() => closeAdmission(admission),
					deadline - Date.now(),
				);
			}
			admissions.set(admission, state);
			return admission;
		},
		recognizeTurn: (
			admission: CodexModelTurnAdmission,
			turn: CodexModelTurn,
		) => {
			const key = nativeTurnKey(turn);
			if (closing) return false;
			return recognizeAdmissionWaiters(admission, key);
		},
		registerTurn: (
			admission: CodexModelTurnAdmission,
			turn: CodexModelTurn,
		) => {
			const key = nativeTurnKey(turn);
			const state = admissions.get(admission);
			const recognized = recognizedTurns.get(key);
			if (
				state?.state !== "open" ||
				state.turnKey !== key ||
				!recognized?.has(admission)
			) {
				return false;
			}
			if (
				closing ||
				revokedTurns.has(key) ||
				state.deadline <= Date.now() ||
				(admittedTurns.has(key) &&
					(admittedTurns.get(key)?.internalModel !== state.internalModel ||
						admittedTurns.get(key)?.reasoningLevel !== state.reasoningLevel))
			) {
				closeAdmission(admission);
				return false;
			}
			if (state.timer !== undefined) clearTimeout(state.timer);
			state.state = "consumed";
			removePending(admission, state);
			settleBoundWaiters(admission, key);
			if (recognized) {
				recognized.delete(admission);
				if (recognized.size === 0) recognizedTurns.delete(key);
			}
			const selection = {
				internalModel: state.internalModel,
				reasoningLevel: state.reasoningLevel,
			};
			admittedTurns.set(key, selection);
			settleAdmissionWaiters(key, selection);
			return true;
		},
		abandonTurnAdmission: (admission: CodexModelTurnAdmission) => {
			closeAdmission(admission);
		},
		revokeTurn: (turn: CodexModelTurn) => {
			revokeTurn(nativeTurnKey(turn));
		},
		cancelTurn: async (turn: CodexModelTurn) => {
			const key = nativeTurnKey(turn);
			revokeTurn(key);
			const requests = [...(activeTurns.get(key) ?? [])];
			for (const request of requests) request.terminate();
			await Promise.all(requests.map(({ completion }) => completion));
		},
		close: () => {
			closePromise ??= (async () => {
				closing = true;
				processAccess.clear();
				boundThreads.clear();
				for (const key of modelRequestWaiters.keys())
					settleModelRequestWaiters(key, false);
				readyModelTurns.clear();
				for (const recognized of pendingThreads.values()) {
					for (const admission of [...recognized]) {
						closeAdmission(admission);
					}
				}
				recognizedTurns.clear();
				for (const key of admissionWaiters.keys()) {
					settleAdmissionWaiters(key, undefined);
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
