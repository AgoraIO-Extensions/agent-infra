import { setTimeout as delay } from "node:timers/promises";
import {
	BrowserCommandAcceptedProjectionV1Schema,
	BrowserCommandRequestV1Schema,
	CommandAcceptedProjectionV1Schema,
	ConversationDetailProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationModelSelectionProjectionV1Schema,
	ConversationPageV1Schema,
	ConversationProjectionV1Schema,
	ConversationSseMessageV1Schema,
	type ConversationSseMessageV2Schema,
	CreateConversationRequestV1Schema,
	ExecutionDetailProjectionV1Schema,
	ExecutionDetailProjectionV2Schema,
	framePilotSseMessageV1,
	framePilotSseMessageV2,
	MessageCommandRequestV1Schema,
	MessageProjectionV1Schema,
	ModelOptionProjectionV1Schema,
	ModelSelectionUpdateRequestV1Schema,
	PersistedConversationEventV2Schema,
	ReasoningDeltaEventV2Schema,
	RegenerateCommandRequestV1Schema,
	resolvePilotReplaySelectorV1,
	StopCommandRequestV1Schema,
	TaskStatusEventV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionAuthorizationPortV1,
	ConversationExecutionError,
	type ConversationExecutionUseCaseV1,
	type ConversationStateResultV1,
	parseConversationOperationFactV2,
	parseConversationPersistedEventPayloadV1,
	parseTaskAuthorizationBoundaryV1,
	projectConversationExecutionV1,
	projectConversationMessagesV1,
	RecentPersonalConversationsError,
	type RecentPersonalConversationsUseCaseV1,
} from "@agent-infra/platform-core";
import type {
	ConversationExecutionDetailV1,
	ConversationQueryDetailV1,
	ConversationQueryEventV1,
	ConversationQueryPageV1,
	ConversationQueryProjectionV1,
	ConversationQueryReadOptionsV1,
	ConversationQueryScopeV1,
	ConversationReplayResultV1,
} from "@agent-infra/platform-store";
import {
	type ConversationEventWatcherV1,
	ConversationQueryError,
} from "@agent-infra/platform-store";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SseResourceTracker } from "../sse-resource-tracker.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	parsePageQuery,
	type RequestMetadata,
	requestMetadata,
} from "./common.js";
import type { FileRoutesDependenciesV1 } from "./file-routes.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./identity.js";

type AuthorizationInput =
	| {
			readonly schemaVersion: 1;
			readonly operation: "agent.read";
			readonly agentId?: string;
			readonly conversationId?: string;
	  }
	| Parameters<ConversationExecutionAuthorizationPortV1["authorize"]>[0]
	| {
			readonly schemaVersion: 1;
			readonly operation: "native-capability.invoke";
			readonly agentId?: string;
			readonly conversationId: string;
	  };

type AuthorizationDecision =
	| {
			readonly outcome: "allowed";
			readonly authority: ConversationExecutionAuthorityV1;
	  }
	| { readonly outcome: "denied" }
	| { readonly outcome: "unavailable" }
	| { readonly outcome: "revoked" };

export interface ConversationAuthorization {
	authorize(
		identity: IdentityContext,
		input: AuthorizationInput,
	): Promise<AuthorizationDecision>;
}

export interface ConversationQuery {
	list(
		scope: ConversationQueryScopeV1,
		agentId: string,
		page: ConversationQueryPageV1,
	): Promise<{
		readonly items: readonly ConversationQueryProjectionV1[];
		readonly nextCursor: string | null;
	}>;
	/** An aborted signal cancels the read's database statements (#1732). */
	get(
		scope: ConversationQueryScopeV1,
		conversationId: string,
		signal?: AbortSignal,
		readOptions?: ConversationQueryReadOptionsV1,
	): Promise<ConversationQueryDetailV1 | undefined>;
	getProjection?(
		scope: ConversationQueryScopeV1,
		conversationId: string,
		signal?: AbortSignal,
	): Promise<ConversationQueryProjectionV1 | undefined>;
	getExecution(
		scope: ConversationQueryScopeV1,
		conversationId: string,
		executionId: string,
	): Promise<ConversationExecutionDetailV1 | undefined>;
	replay(
		scope: ConversationQueryScopeV1,
		conversationId: string,
		selector:
			| { readonly kind: "cursor" | "last-event-id"; readonly value: string }
			| undefined,
		signal?: AbortSignal,
	): Promise<ConversationReplayResultV1 | undefined>;
}

export interface ConversationRoutesDependencies {
	readonly recent?: RecentPersonalConversationsUseCaseV1;
	readonly files?: FileRoutesDependenciesV1;
	readonly identity: IdentityAdapter;
	readonly authorization: ConversationAuthorization;
	/** Current Runtime directory for model-capable conversations. */
	readonly modelSelection?: ConversationModelSelectionReaderV1;
	readonly commands: (
		identity: IdentityContext,
	) => Pick<
		ConversationExecutionUseCaseV1,
		| "accept"
		| "createConversation"
		| "readConversation"
		| "regenerate"
		| "selectModel"
		| "stop"
	>;
	/** Deployment-owned Browser command bridge; the API remains the identity authority. */
	readonly browserCommands?: ConversationBrowserCommandPortV1;
	readonly query: ConversationQuery;
	/** Idle reauthorization interval, 1–30,000 ms; default 1,000 ms. */
	readonly streamPollIntervalMs?: number;
	/** Commit wakeups for open streams (#1561); without it streams only poll. */
	readonly eventWake?: {
		watch(conversationId: string): ConversationEventWatcherV1;
	};
	/** Bound each authorization/replay read and SSE write, 1–30,000 ms; default 1,000 ms.
	 * Idle detection is bounded by poll + two reads (default 3 s).
	 * Terminal delivery adds at most two writes (default 2 s); stalls exclude event-loop starvation.
	 */
	readonly streamReadTimeoutMs?: number;
	/**
	 * Consecutive authorization checks or replay reads that may fail only
	 * transiently (timeout or dependency unavailable) before an open stream is
	 * closed, 0–100; default 10. While they fail the stream writes nothing (#1606).
	 */
	readonly streamTransientFailureLimit?: number;
	readonly sseResources?: SseResourceTracker;
}

export type ConversationBrowserCommandRequestV1 = ReturnType<
	typeof BrowserCommandRequestV1Schema.parse
>;

export type ConversationBrowserCommandDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed" | "unknown";
			readonly conversationId: string;
			readonly executionId: string;
			readonly handoffId?: string;
			readonly confirmationId?: string;
	  }
	| {
			readonly outcome: "denied" | "conflict" | "stale" | "unavailable";
			readonly conversationId: string;
			readonly executionId?: string;
	  };

export interface ConversationBrowserCommandPortV1 {
	invoke(input: {
		identity: IdentityContext;
		conversationId: string;
		command: ConversationBrowserCommandRequestV1;
		idempotencyKey: string;
		requestId: string;
		traceId: string;
		traceParent?: string;
		signal: AbortSignal;
	}): Promise<ConversationBrowserCommandDecisionV1>;
}

type ConversationProjection = ReturnType<
	typeof ConversationProjectionV1Schema.parse
>;
type SseMessage = ReturnType<typeof ConversationSseMessageV1Schema.parse>;
type ModelOptionProjection = ReturnType<
	typeof ModelOptionProjectionV1Schema.parse
>;

/** Runtime-owned model metadata; endpoint, credential and ACP session fields
 * never cross this API boundary. */
export interface ConversationModelSelectionReaderV1 {
	read(
		identity: IdentityContext,
		conversationId: string,
	): Promise<{
		readonly agentId: string;
		readonly source: "standard" | "custom-platform-adapter";
		readonly available: boolean;
		readonly options: readonly ModelOptionProjection[];
		readonly currentModelOptionId: string | null;
		readonly currentReasoningLevel: string | null;
	} | null>;
}

function fail(
	code: ConstructorParameters<typeof HttpProtocolError>[0],
	traceId: string,
): never {
	throw new HttpProtocolError(code, traceId);
}

function scope(identity: IdentityContext): ConversationQueryScopeV1 {
	return { actorId: identity.userId, channelId: "web" };
}

function queryFailure(error: unknown, traceId: string): never {
	if (error instanceof HttpProtocolError) throw error;
	if (
		error instanceof ConversationQueryError &&
		error.code === "invalid_request"
	) {
		return fail("INVALID_REQUEST", traceId);
	}
	return fail("DEPENDENCY_UNAVAILABLE", traceId);
}

async function query<T>(task: () => Promise<T>, traceId: string): Promise<T> {
	try {
		return await task();
	} catch (error) {
		return queryFailure(error, traceId);
	}
}

async function boundary(
	context: Context,
	task: (metadata: RequestMetadata) => Promise<Response>,
): Promise<Response> {
	const metadata = requestMetadata(context.req.raw);
	try {
		return await task(metadata);
	} catch (error) {
		let protocol: HttpProtocolError;
		if (error instanceof HttpProtocolError) protocol = error;
		else if (error instanceof ConversationExecutionError) {
			protocol = new HttpProtocolError(
				error.code === "invalid_input"
					? "INVALID_REQUEST"
					: "DEPENDENCY_UNAVAILABLE",
				metadata.traceId,
			);
		} else if (error instanceof ConversationQueryError) {
			protocol = new HttpProtocolError(
				error.code === "invalid_request"
					? "INVALID_REQUEST"
					: "DEPENDENCY_UNAVAILABLE",
				metadata.traceId,
			);
		} else if (error instanceof RecentPersonalConversationsError) {
			protocol = new HttpProtocolError(
				error.code === "invalid_request"
					? "INVALID_REQUEST"
					: error.code === "revoked"
						? "AUTHORIZATION_REVOKED"
						: "DEPENDENCY_UNAVAILABLE",
				metadata.traceId,
			);
		} else protocol = new HttpProtocolError("INTERNAL_ERROR", metadata.traceId);
		return context.json(protocol.body, protocol.status);
	}
}

async function authorize(
	dependencies: ConversationRoutesDependencies,
	identity: IdentityContext,
	input: AuthorizationInput,
	traceId: string,
	status: "http" | "sse" = "http",
): Promise<ConversationExecutionAuthorityV1> {
	let decision: AuthorizationDecision;
	try {
		decision = await dependencies.authorization.authorize(identity, input);
	} catch {
		return fail("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (decision.outcome === "revoked")
		return fail("AUTHORIZATION_REVOKED", traceId);
	if (decision.outcome === "unavailable") {
		return fail("RUNTIME_UNAVAILABLE", traceId);
	}
	if (decision.outcome !== "allowed") {
		return fail(
			status === "sse" ? "FORBIDDEN" : "RESOURCE_UNAVAILABLE",
			traceId,
		);
	}
	if (!authorityMatches(decision.authority, identity, input.agentId)) {
		return fail("DEPENDENCY_UNAVAILABLE", traceId);
	}
	return decision.authority;
}

function authorityMatches(
	authority: ConversationExecutionAuthorityV1,
	identity: IdentityContext,
	agentId?: string,
): boolean {
	if (typeof authority !== "object" || authority === null) return false;
	let boundary: ConversationExecutionAuthorityV1["taskBoundary"];
	try {
		boundary =
			authority.taskBoundary === undefined
				? undefined
				: parseTaskAuthorizationBoundaryV1(authority.taskBoundary);
	} catch {
		return false;
	}
	return (
		Object.keys(authority).length === (boundary ? 7 : 6) &&
		authority.schemaVersion === 1 &&
		authority.actorId === identity.userId &&
		authority.channelId === "web" &&
		(boundary
			? boundary.principal.kind === "user" &&
				boundary.principal.id === identity.userId &&
				boundary.agentId === authority.agentId &&
				boundary.channelId === "web" &&
				boundary.agentAuthorizationRevision === authority.authorizationRevision
			: authority.authorizationRevision === identity.authorizationRevision) &&
		(agentId === undefined || authority.agentId === agentId) &&
		typeof authority.agentId === "string" &&
		authority.agentId.length > 0 &&
		typeof authority.supportsSupplementaryInstruction === "boolean"
	);
}

function conversationProjection(
	input: ConversationQueryProjectionV1,
	effective: ConversationStateResultV1,
): ConversationProjection {
	if (
		effective.conversation.conversationId !== input.conversationId ||
		effective.conversation.agentId !== input.agentId
	) {
		throw new Error("Conversation projection is inconsistent");
	}
	return ConversationProjectionV1Schema.parse({
		schemaVersion: 1,
		conversationId: input.conversationId,
		agentId: input.agentId,
		title: null,
		status: effective.conversation.status,
		selectedModelOptionId: effective.conversation.selectedModelOptionId,
		selectedReasoningLevel: effective.conversation.selectedReasoningLevel,
		lastConversationCursor: input.lastConversationCursor,
		createdAt: input.createdAt.toISOString(),
		updatedAt: input.updatedAt.toISOString(),
	});
}

async function effectiveConversation(
	useCase: ReturnType<ConversationRoutesDependencies["commands"]>,
	conversationId: string,
	traceId: string,
): Promise<ConversationStateResultV1> {
	const decision = await useCase.readConversation({
		schemaVersion: 1,
		conversationId,
	});
	if (decision.outcome !== "found") {
		return fail("RESOURCE_UNAVAILABLE", traceId);
	}
	return decision.result;
}

async function readRuntimeModelSelection(
	reader: ConversationModelSelectionReaderV1 | undefined,
	identity: IdentityContext,
	conversationId: string,
	traceId: string,
) {
	if (!reader) return fail("DEPENDENCY_UNAVAILABLE", traceId);
	let value: Awaited<ReturnType<ConversationModelSelectionReaderV1["read"]>>;
	try {
		value = await reader.read(identity, conversationId);
	} catch {
		return fail("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (!value || value.agentId.length === 0)
		return fail("RESOURCE_UNAVAILABLE", traceId);
	try {
		return {
			...value,
			options: value.options.map((option) =>
				ModelOptionProjectionV1Schema.parse(option),
			),
		};
	} catch {
		return fail("DEPENDENCY_UNAVAILABLE", traceId);
	}
}

async function assertCurrentRuntimeSelection(
	reader: ConversationModelSelectionReaderV1 | undefined,
	identity: IdentityContext,
	conversationId: string,
	useCase: ReturnType<ConversationRoutesDependencies["commands"]>,
	traceId: string,
): Promise<void> {
	if (!reader) return;
	const runtime = await readRuntimeModelSelection(
		reader,
		identity,
		conversationId,
		traceId,
	);
	if (runtime.source !== "custom-platform-adapter") return;
	if (!runtime.available) return fail("RUNTIME_UNAVAILABLE", traceId);
	const effective = await effectiveConversation(
		useCase,
		conversationId,
		traceId,
	);
	const selected = runtime.options.find(
		(option) =>
			option.optionId === effective.conversation.selectedModelOptionId,
	);
	if (
		!selected ||
		!effective.conversation.selectedReasoningLevel ||
		!selected.reasoningLevels.includes(
			effective.conversation.selectedReasoningLevel,
		)
	)
		return fail("CONFLICT", traceId);
}

function projectRuntimeModelSelection(
	runtime: Awaited<ReturnType<typeof readRuntimeModelSelection>>,
	effective: ConversationStateResultV1,
	traceId: string,
) {
	return project(
		() =>
			ConversationModelSelectionProjectionV1Schema.parse({
				schemaVersion: 1,
				conversationId: effective.conversation.conversationId,
				agentId: effective.conversation.agentId,
				source: runtime.source,
				available: runtime.available,
				options: runtime.options,
				currentModelOptionId: runtime.currentModelOptionId,
				currentReasoningLevel: runtime.currentReasoningLevel,
				selectedModelOptionId: effective.conversation.selectedModelOptionId,
				selectedReasoningLevel: effective.conversation.selectedReasoningLevel,
			}),
		traceId,
	);
}

function project<T>(projection: () => T, traceId: string): T {
	try {
		return projection();
	} catch {
		return fail("DEPENDENCY_UNAVAILABLE", traceId);
	}
}

export function eventProjection(
	input: ConversationQueryEventV1,
): ReturnType<typeof ConversationSseMessageV2Schema.parse> {
	const base = {
		schemaVersion: 1,
		kind: "event",
		eventId: input.eventId,
		conversationId: input.conversationId,
		executionId: input.executionId,
		sequence: input.sequence,
		conversationCursor: input.conversationCursor,
		occurredAt: input.occurredAt.toISOString(),
	};
	if (input.eventType === "execution.operation") {
		if (input.eventSchemaVersion !== 2)
			throw new Error("Operation event schema is invalid");
		return PersistedConversationEventV2Schema.parse({
			...base,
			schemaVersion: 2,
			type: "execution.operation",
			payload: parseConversationOperationFactV2(input.eventPayload),
		});
	}
	if (input.eventSchemaVersion !== undefined)
		throw new Error("Persisted event schema is invalid");
	const persisted = parseConversationPersistedEventPayloadV1(
		input.eventPayload,
	);
	if (persisted.type !== input.eventType) {
		throw new Error("Invalid persisted event type");
	}
	let projected: unknown;
	if (persisted.type === "task.status") {
		const { type, ...payload } = persisted;
		return TaskStatusEventV1Schema.parse({ ...base, type, payload });
	}
	if (persisted.type === "text.delta") {
		projected = {
			...base,
			type: "text.delta",
			payload: { text: persisted.text },
		};
	} else if (persisted.type === "reasoning.delta") {
		// #2979：思考过程只以 V2 事件进入会话读取与 V2 SSE；V1 读取方跳过它但推进游标。
		return ReasoningDeltaEventV2Schema.parse({
			...base,
			schemaVersion: 2,
			type: "reasoning.delta",
			payload: { kind: persisted.kind, text: persisted.text },
		});
	} else if (persisted.type === "execution.status") {
		projected = {
			...base,
			type: "execution.status",
			payload: { status: persisted.status },
		};
	} else if (persisted.type === "execution.detail") {
		projected = {
			...base,
			type: "execution.detail",
			payload: {
				category: persisted.category,
				summary: persisted.summary,
				...(persisted.callId === undefined ? {} : { callId: persisted.callId }),
			},
		};
	} else if (persisted.type === "browser.handoff") {
		return PersistedConversationEventV2Schema.parse({
			...base,
			schemaVersion: 2,
			type: "browser.handoff",
			payload: {
				handoffId: persisted.handoffId,
				status: persisted.status,
				reason: persisted.reason,
				requestedAt: persisted.requestedAt,
				expiresAt: persisted.expiresAt,
				...(persisted.operatorId === undefined
					? {}
					: { operatorId: persisted.operatorId }),
				...(persisted.terminalReason === undefined
					? {}
					: { terminalReason: persisted.terminalReason }),
				binding: persisted.binding,
			},
		});
	} else if (persisted.type === "result.file") {
		const payload = {
			fileId: persisted.fileId,
			name: persisted.name,
			mediaType: persisted.mediaType,
			sizeBytes: persisted.sizeBytes,
		};
		// #3226：携带工作区引用（可为 null）的结果文件按 V2 进入混合版本历史；旧事件保持 V1。
		if (persisted.workspaceReference !== undefined)
			return PersistedConversationEventV2Schema.parse({
				...base,
				schemaVersion: 2,
				type: "result.file",
				payload: {
					...payload,
					workspaceReference: persisted.workspaceReference,
				},
			});
		projected = { ...base, type: "result.file", payload };
	} else if (persisted.type === "conversation.error") {
		projected = {
			...base,
			type: "conversation.error",
			payload: {
				error: {
					schemaVersion: 1,
					code: persisted.retryable
						? "RUNTIME_UNAVAILABLE"
						: "EXECUTION_FAILED",
					message: "Conversation processing failed.",
					retryable: persisted.retryable,
					traceId: input.traceId,
				},
			},
		};
	} else if (persisted.type === "model.selection.fell_back") {
		const payload = {
			modelOptionId: persisted.modelOptionId,
			reasoningLevel: persisted.reasoningLevel,
			reason: persisted.reason,
		};
		// G-07：记录了原选项的回退事件按 V2 原样进入混合版本历史；旧事件保持 V1。
		if (persisted.requestedModelOptionId !== undefined)
			return PersistedConversationEventV2Schema.parse({
				...base,
				schemaVersion: 2,
				type: "model.selection.fell_back",
				payload: {
					...payload,
					requestedModelOptionId: persisted.requestedModelOptionId,
					requestedModelDisplayName:
						persisted.requestedModelDisplayName ?? null,
				},
			});
		projected = { ...base, type: "model.selection.fell_back", payload };
	} else {
		throw new Error("Unsupported persisted event type");
	}
	return ConversationSseMessageV1Schema.parse(projected);
}

/**
 * V1 SSE 只能表示 V1 事件：带原选项的回退事件与带工作区引用的结果文件降为原 V1 形状，
 * 让旧读取方照旧看到它们；其他 V2 事实及 task.status 由调用方跳过但推进持久游标
 * （G-07、#3226）。
 */
export function eventProjectionV1(
	input: ConversationQueryEventV1,
): SseMessage | undefined {
	const message = eventProjection(input);
	if (message.type === "task.status") return undefined;
	if (message.schemaVersion === 1) return message;
	if (message.type === "result.file") {
		const { workspaceReference: _workspaceReference, ...payload } =
			message.payload;
		return ConversationSseMessageV1Schema.parse({
			...message,
			schemaVersion: 1,
			payload,
		});
	}
	if (message.type !== "model.selection.fell_back") return undefined;
	const {
		requestedModelOptionId: _requestedModelOptionId,
		requestedModelDisplayName: _requestedModelDisplayName,
		...payload
	} = message.payload;
	return ConversationSseMessageV1Schema.parse({
		...message,
		schemaVersion: 1,
		payload,
	});
}

function failure(
	traceId: string | null,
	code:
		| "EXECUTION_FAILED"
		| "AUTHORIZATION_REVOKED"
		| "ORIGINAL_RESPONSE_NOT_STARTED"
		| "ORIGINAL_RESPONSE_ALREADY_FINISHED",
) {
	if (!traceId) throw new Error("Missing execution trace");
	return {
		schemaVersion: 1 as const,
		code,
		message: {
			AUTHORIZATION_REVOKED: "Authorization was revoked.",
			EXECUTION_FAILED: "Execution failed.",
			ORIGINAL_RESPONSE_NOT_STARTED: "Original response did not start.",
			ORIGINAL_RESPONSE_ALREADY_FINISHED: "Original response already finished.",
		}[code],
		retryable: false as const,
		traceId,
	};
}

function messageProjections(
	input: ConversationQueryDetailV1,
): ReturnType<typeof MessageProjectionV1Schema.parse>[] {
	return projectConversationMessagesV1(input).map(
		({ failureTraceId, failureCode, ...item }) =>
			MessageProjectionV1Schema.parse({
				...item,
				error:
					failureTraceId === null
						? null
						: failure(failureTraceId, failureCode ?? "EXECUTION_FAILED"),
				createdAt: item.createdAt.toISOString(),
			}),
	);
}

function executionProjection(input: ConversationExecutionDetailV1) {
	const { failureTraceId, ...projection } =
		projectConversationExecutionV1(input);
	return ExecutionDetailProjectionV1Schema.parse({
		...projection,
		schemaVersion: 1,
		processSummary: projection.processSummary.map((item) => ({
			...item,
			occurredAt: item.occurredAt.toISOString(),
		})),
		startedAt: projection.startedAt?.toISOString() ?? null,
		finishedAt: projection.finishedAt?.toISOString() ?? null,
		error:
			failureTraceId === null
				? null
				: failure(failureTraceId, "EXECUTION_FAILED"),
	});
}

async function writeSseMessage(
	stream: { writeSSE(message: { id?: string; data: string }): Promise<void> },
	message: SseMessage,
): Promise<void> {
	const frame = framePilotSseMessageV1(message);
	await stream.writeSSE({
		...(frame.id === undefined ? {} : { id: frame.id }),
		data: JSON.stringify(frame.data),
	});
}

async function writeSseMessageV2(
	stream: { writeSSE(message: { id?: string; data: string }): Promise<void> },
	message: ReturnType<typeof ConversationSseMessageV2Schema.parse>,
): Promise<void> {
	const frame = framePilotSseMessageV2(message);
	await stream.writeSSE({
		...(frame.id === undefined ? {} : { id: frame.id }),
		data: JSON.stringify(frame.data),
	});
}

function replaySelector(request: Request, traceId: string) {
	const search = new URL(request.url).searchParams;
	if (
		[...search.keys()].some((key) => key !== "cursor") ||
		search.getAll("cursor").length > 1
	) {
		return fail("INVALID_REQUEST", traceId);
	}
	try {
		return resolvePilotReplaySelectorV1({
			...(search.get("cursor") === null
				? {}
				: { cursor: search.get("cursor") as string }),
			...(request.headers.get("Last-Event-ID") === null
				? {}
				: { lastEventId: request.headers.get("Last-Event-ID") as string }),
		});
	} catch {
		return fail("INVALID_REQUEST", traceId);
	}
}

type StreamAuthorization =
	| { readonly outcome: "allowed"; readonly identity: IdentityContext }
	| {
			readonly outcome: "closed";
			readonly reason:
				| "revoked"
				| "disabled"
				| "session_invalid"
				| "subject_changed"
				| "dependency_unavailable"
				| "invalid_response"
				| "resource_unavailable";
	  };

async function stillAuthorized(
	dependencies: ConversationRoutesDependencies,
	request: Request,
	initialUserId: string,
	conversationId: string,
	traceId: string,
): Promise<StreamAuthorization> {
	// Keep dependency rejection distinct from a returned but invalid identity.
	let resolved = false;
	let identity: IdentityContext;
	try {
		identity = await resolveIdentity(
			{
				resolve: async (currentRequest) => {
					const value = await dependencies.identity.resolve(currentRequest);
					resolved = true;
					return value;
				},
				hydrateUsers: (ids) => dependencies.identity.hydrateUsers(ids),
			},
			request,
			traceId,
		);
	} catch (error) {
		const code =
			error instanceof HttpProtocolError ? error.body.code : undefined;
		return {
			outcome: "closed",
			reason:
				code === "AUTHORIZATION_REVOKED"
					? "disabled"
					: code === "AUTHENTICATION_REQUIRED"
						? "session_invalid"
						: resolved
							? "invalid_response"
							: "dependency_unavailable",
		};
	}
	if (identity.userId !== initialUserId)
		return { outcome: "closed", reason: "subject_changed" };
	let decision: AuthorizationDecision;
	try {
		decision = await dependencies.authorization.authorize(identity, {
			schemaVersion: 1,
			operation: "conversation.read",
			conversationId,
		});
	} catch {
		return { outcome: "closed", reason: "dependency_unavailable" };
	}
	if (!decision || typeof decision !== "object")
		return { outcome: "closed", reason: "invalid_response" };
	if (decision.outcome === "unavailable")
		return { outcome: "closed", reason: "dependency_unavailable" };
	if (decision.outcome === "denied" || decision.outcome === "revoked")
		return { outcome: "closed", reason: "revoked" };
	if (
		decision.outcome !== "allowed" ||
		!authorityMatches(decision.authority, identity)
	)
		return { outcome: "closed", reason: "invalid_response" };
	return { outcome: "allowed", identity };
}

/** Bounds an in-flight authorization or replay; late results never reach the stream. */
async function streamRead<T>(
	task: () => Promise<T>,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: () => void = () => {};
	const interrupted = new Promise<never>((_, reject) => {
		abort = () => reject(new Error("Stream read interrupted"));
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(abort, timeoutMs);
	});
	try {
		return await Promise.race([
			interrupted,
			Promise.resolve().then(() => {
				if (signal.aborted) throw new Error("Stream read interrupted");
				return task();
			}),
		]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

async function writeAuthorizationRevoked(
	stream: { writeSSE(message: { id?: string; data: string }): Promise<void> },
	traceId: string,
): Promise<void> {
	await writeSseMessage(
		stream,
		ConversationSseMessageV1Schema.parse({
			schemaVersion: 1,
			kind: "control",
			type: "authorization.revoked",
			error: new HttpProtocolError("AUTHORIZATION_REVOKED", traceId).body,
		}),
	);
}

async function deniedCommand(
	dependencies: ConversationRoutesDependencies,
	identity: IdentityContext,
	conversationId: string,
	operation: "message" | "regenerate",
	traceId: string,
): Promise<never> {
	await authorize(
		dependencies,
		identity,
		{ schemaVersion: 1, operation, conversationId },
		traceId,
	);
	await authorize(
		dependencies,
		identity,
		{ schemaVersion: 1, operation: "conversation.read", conversationId },
		traceId,
	);
	const projection = await query(
		() =>
			dependencies.query.getProjection
				? dependencies.query.getProjection(scope(identity), conversationId)
				: dependencies.query
						.get(scope(identity), conversationId)
						.then((detail) => detail?.conversation),
		traceId,
	);
	return fail(
		projection?.status === "unavailable"
			? "CONVERSATION_UNAVAILABLE"
			: "RESOURCE_UNAVAILABLE",
		traceId,
	);
}

export function registerConversationRoutes(
	app: Hono,
	dependencies: ConversationRoutesDependencies,
): void {
	const pollIntervalMs = dependencies.streamPollIntervalMs ?? 1000;
	const readTimeoutMs = dependencies.streamReadTimeoutMs ?? 1000;
	for (const value of [pollIntervalMs, readTimeoutMs]) {
		if (!Number.isInteger(value) || value < 1 || value > 30_000)
			throw new Error(
				"Conversation stream intervals must be integers from 1 to 30000 ms",
			);
	}
	const transientFailureLimit = dependencies.streamTransientFailureLimit ?? 10;
	if (
		!Number.isInteger(transientFailureLimit) ||
		transientFailureLimit < 0 ||
		transientFailureLimit > 100
	)
		throw new Error(
			"Conversation stream transient failure limit must be an integer from 0 to 100",
		);
	app.get("/api/v2/me/conversations/recent", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const page = parsePageQuery(context.req.raw, metadata.traceId);
			if (!dependencies.recent)
				return fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			const result = await dependencies.recent.list(identity.userId, page);
			return context.json(
				project(
					() =>
						ConversationPageV1Schema.parse({
							items: result.items.map((item) =>
								ConversationProjectionV1Schema.parse({
									schemaVersion: 1,
									conversationId: item.conversationId,
									agentId: item.agentId,
									title: null,
									status: item.status,
									selectedModelOptionId: item.selectedModelOptionId,
									selectedReasoningLevel: item.selectedReasoningLevel,
									lastConversationCursor: item.lastConversationCursor,
									createdAt: item.createdAt.toISOString(),
									updatedAt: item.updatedAt.toISOString(),
								}),
							),
							nextCursor: result.nextCursor,
						}),
					metadata.traceId,
				),
			);
		}),
	);
	app.get("/api/v1/agents/:agentId/conversations", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const agentId = context.req.param("agentId");
			await authorize(
				dependencies,
				identity,
				{ schemaVersion: 1, operation: "agent.read", agentId },
				metadata.traceId,
			);
			const page = parsePageQuery(context.req.raw, metadata.traceId);
			const result = await query(
				() =>
					dependencies.query.list(scope(identity), agentId, {
						limit: page.limit ?? 50,
						...(page.cursor === undefined ? {} : { cursor: page.cursor }),
					}),
				metadata.traceId,
			);
			const useCase = dependencies.commands(identity);
			const items = await Promise.all(
				result.items.map(async (item) => {
					const effective = await effectiveConversation(
						useCase,
						item.conversationId,
						metadata.traceId,
					);
					return project(
						() => conversationProjection(item, effective),
						metadata.traceId,
					);
				}),
			);
			return context.json(
				ConversationPageV1Schema.parse({
					items,
					nextCursor: result.nextCursor,
				}),
			);
		}),
	);

	app.post("/api/v1/agents/:agentId/conversations", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			await parseJson(
				context.req.raw,
				CreateConversationRequestV1Schema,
				metadata.traceId,
			);
			const agentId = context.req.param("agentId");
			const useCase = dependencies.commands(identity);
			const decision = await useCase.createConversation({
				schemaVersion: 1,
				agentId,
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				requestId: metadata.requestId,
				traceId: metadata.traceId,
			});
			if (decision.outcome === "denied") {
				await authorize(
					dependencies,
					identity,
					{ schemaVersion: 1, operation: "conversation.create", agentId },
					metadata.traceId,
				);
				return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
			}
			if (decision.outcome === "conflict")
				return fail("CONFLICT", metadata.traceId);
			const detail = await query(
				() =>
					dependencies.query.get(
						scope(identity),
						decision.result.conversationId,
					),
				metadata.traceId,
			);
			if (!detail) return fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			const effective = await effectiveConversation(
				useCase,
				decision.result.conversationId,
				metadata.traceId,
			);
			return context.json(
				project(
					() => conversationProjection(detail.conversation, effective),
					metadata.traceId,
				),
				201,
			);
		}),
	);

	for (const version of [1, 2] as const)
		app.get(`/api/v${version}/conversations/:conversationId`, (context) =>
			boundary(context, async (metadata) => {
				const identity = await resolveIdentity(
					dependencies.identity,
					context.req.raw,
					metadata.traceId,
				);
				const conversationId = context.req.param("conversationId");
				const effective = await effectiveConversation(
					dependencies.commands(identity),
					conversationId,
					metadata.traceId,
				);
				const beforeCursor = context.req.query("beforeCursor");
				const detail = await query(
					() =>
						dependencies.query.get(
							scope(identity),
							conversationId,
							context.req.raw.signal,
							beforeCursor === undefined ? undefined : { beforeCursor },
						),
					metadata.traceId,
				);
				if (!detail) return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
				const v2 = version === 2;
				if (v2) {
					return context.json(
						project(() => {
							const conversation = conversationProjection(
								detail.conversation,
								effective,
							);
							return ConversationDetailProjectionV2Schema.parse({
								schemaVersion: 2,
								conversation,
								messages: messageProjections(detail),
								events: detail.events.map(eventProjection),
								...(detail.eventWindow === undefined
									? {}
									: { eventWindow: detail.eventWindow }),
								// Same readiness fact as the Web message gate (#1534); an
								// upgrading Sandbox is shown as updating (ADR 0023). 空闲回收后
								// 等待恢复的 Sandbox 可受理下一条消息并由它触发恢复（#2239）。
								sessionAvailability:
									conversation.status === "unavailable"
										? "unavailable"
										: detail.conversation.sandbox !== undefined &&
												detail.conversation.sandboxReady !== true &&
												detail.conversation.sandboxResumable !== true
											? detail.conversation.sandboxUpdating === true
												? "updating"
												: "preparing"
											: "ready",
							});
						}, metadata.traceId),
					);
				}
				return context.json(
					project(
						() =>
							ConversationDetailProjectionV1Schema.parse({
								conversation: conversationProjection(
									detail.conversation,
									effective,
								),
								messages: messageProjections(detail),
							}),
						metadata.traceId,
					),
				);
			}),
		);

	app.get("/api/v1/conversations/:conversationId/model-selection", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const conversationId = context.req.param("conversationId");
			await authorize(
				dependencies,
				identity,
				{ schemaVersion: 1, operation: "conversation.read", conversationId },
				metadata.traceId,
			);
			const runtime = await readRuntimeModelSelection(
				dependencies.modelSelection,
				identity,
				conversationId,
				metadata.traceId,
			);
			const effective = await effectiveConversation(
				dependencies.commands(identity),
				conversationId,
				metadata.traceId,
			);
			if (runtime.agentId !== effective.conversation.agentId)
				return fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(
				projectRuntimeModelSelection(runtime, effective, metadata.traceId),
			);
		}),
	);

	app.put("/api/v1/conversations/:conversationId/model-selection", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body } = await parseJson(
				context.req.raw,
				ModelSelectionUpdateRequestV1Schema,
				metadata.traceId,
			);
			const conversationId = context.req.param("conversationId");
			const useCase = dependencies.commands(identity);
			if (dependencies.modelSelection) {
				const runtime = await readRuntimeModelSelection(
					dependencies.modelSelection,
					identity,
					conversationId,
					metadata.traceId,
				);
				if (runtime.source === "custom-platform-adapter") {
					if (!runtime.available)
						return fail("RUNTIME_UNAVAILABLE", metadata.traceId);
					const option = runtime.options.find(
						(candidate) => candidate.optionId === body.modelOptionId,
					);
					if (!option?.reasoningLevels.includes(body.reasoningLevel))
						return fail("CONFLICT", metadata.traceId);
				}
			}
			const decision = await useCase.selectModel({
				schemaVersion: 1,
				command: "model.select",
				conversationId,
				modelOptionId: body.modelOptionId,
				reasoningLevel: body.reasoningLevel,
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				requestId: metadata.requestId,
				traceId: metadata.traceId,
			});
			if (decision.outcome === "denied")
				return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
			if (decision.outcome === "conflict")
				return fail("CONFLICT", metadata.traceId);
			const [projection, effective] = await Promise.all([
				query(
					() =>
						dependencies.query.getProjection
							? dependencies.query.getProjection(
									scope(identity),
									conversationId,
								)
							: dependencies.query
									.get(scope(identity), conversationId)
									.then((detail) => detail?.conversation),
					metadata.traceId,
				),
				effectiveConversation(useCase, conversationId, metadata.traceId),
			]);
			if (!projection) return fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(
				project(
					() => conversationProjection(projection, effective),
					metadata.traceId,
				),
			);
		}),
	);

	app.post("/api/v1/conversations/:conversationId/messages", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body } = await parseJson(
				context.req.raw,
				MessageCommandRequestV1Schema,
				metadata.traceId,
			);
			if (body.attachments?.length) {
				if (!dependencies.files)
					return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
				try {
					const port = dependencies.files.authorization(context.req.raw);
					await dependencies.files.service.authorizeInputs(
						context.req.param("conversationId"),
						body.attachments,
						port,
					);
				} catch {
					return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
				}
			}
			const useCase = dependencies.commands(identity);
			await assertCurrentRuntimeSelection(
				dependencies.modelSelection,
				identity,
				context.req.param("conversationId"),
				useCase,
				metadata.traceId,
			);
			const decision = await useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: context.req.param("conversationId"),
				text: body.text,
				...(body.attachments === undefined
					? {}
					: { attachments: body.attachments }),
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				requestId: metadata.requestId,
				traceId: metadata.traceId,
				...(metadata.traceParent === undefined
					? {}
					: { traceParent: metadata.traceParent }),
			});
			if (decision.outcome === "busy") return fail("BUSY", metadata.traceId);
			if (decision.outcome === "starting")
				return fail("AGENT_STARTING", metadata.traceId);
			if (decision.outcome === "denied") {
				return deniedCommand(
					dependencies,
					identity,
					context.req.param("conversationId"),
					"message",
					metadata.traceId,
				);
			}
			if (decision.outcome === "conflict")
				return fail("CONFLICT", metadata.traceId);
			return context.json(
				CommandAcceptedProjectionV1Schema.parse(decision.result),
				202,
			);
		}),
	);

	app.post("/api/v1/conversations/:conversationId/regenerations", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body } = await parseJson(
				context.req.raw,
				RegenerateCommandRequestV1Schema,
				metadata.traceId,
			);
			const decision = await dependencies.commands(identity).regenerate({
				schemaVersion: 1,
				command: "regenerate",
				conversationId: context.req.param("conversationId"),
				sourceMessageId: body.messageId,
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				requestId: metadata.requestId,
				traceId: metadata.traceId,
				...(metadata.traceParent === undefined
					? {}
					: { traceParent: metadata.traceParent }),
			});
			if (decision.outcome === "busy") return fail("BUSY", metadata.traceId);
			if (decision.outcome === "starting")
				return fail("AGENT_STARTING", metadata.traceId);
			if (decision.outcome === "denied") {
				return deniedCommand(
					dependencies,
					identity,
					context.req.param("conversationId"),
					"regenerate",
					metadata.traceId,
				);
			}
			if (decision.outcome === "conflict")
				return fail("CONFLICT", metadata.traceId);
			return context.json(
				CommandAcceptedProjectionV1Schema.parse(decision.result),
				202,
			);
		}),
	);

	app.post("/api/v1/conversations/:conversationId/stops", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body } = await parseJson(
				context.req.raw,
				StopCommandRequestV1Schema,
				metadata.traceId,
			);
			const decision = await dependencies.commands(identity).stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: context.req.param("conversationId"),
				targetExecutionId: body.targetExecutionId,
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				requestId: metadata.requestId,
				traceId: metadata.traceId,
				...(metadata.traceParent === undefined
					? {}
					: { traceParent: metadata.traceParent }),
			});
			if (decision.outcome === "denied")
				return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
			if (decision.outcome === "conflict")
				return fail("CONFLICT", metadata.traceId);
			return context.json(
				CommandAcceptedProjectionV1Schema.parse({
					...decision.result,
					messageId: null,
				}),
				202,
			);
		}),
	);

	app.post(
		"/api/v1/conversations/:conversationId/browser/commands",
		(context) =>
			boundary(context, async (metadata) => {
				const identity = await resolveIdentity(
					dependencies.identity,
					context.req.raw,
					metadata.traceId,
				);
				if (!dependencies.browserCommands)
					return fail("RUNTIME_UNAVAILABLE", metadata.traceId);
				await authorize(
					dependencies,
					identity,
					{
						schemaVersion: 1,
						operation: "conversation.read",
						conversationId: context.req.param("conversationId"),
					},
					metadata.traceId,
				);
				const { value: command } = await parseJson(
					context.req.raw,
					BrowserCommandRequestV1Schema,
					metadata.traceId,
				);
				const conversationId = context.req.param("conversationId");
				const decision = await dependencies.browserCommands.invoke({
					identity,
					conversationId,
					command,
					idempotencyKey: parseIdempotencyKey(
						context.req.raw,
						metadata.traceId,
					),
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					...(metadata.traceParent === undefined
						? {}
						: { traceParent: metadata.traceParent }),
					signal: context.req.raw.signal,
				});
				if (decision.conversationId !== conversationId)
					return fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
				if (decision.outcome === "denied")
					return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
				if (decision.outcome === "conflict" || decision.outcome === "stale")
					return fail("CONFLICT", metadata.traceId);
				if (decision.outcome === "unavailable")
					return fail("RUNTIME_UNAVAILABLE", metadata.traceId);
				if (
					decision.outcome !== "accepted" &&
					decision.outcome !== "replayed" &&
					decision.outcome !== "unknown"
				)
					return fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
				return context.json(
					BrowserCommandAcceptedProjectionV1Schema.parse({
						schemaVersion: 1,
						outcome: decision.outcome,
						command: command.command,
						conversationId: decision.conversationId,
						executionId: decision.executionId,
						...(decision.handoffId === undefined
							? {}
							: { handoffId: decision.handoffId }),
						...(decision.confirmationId === undefined
							? {}
							: { confirmationId: decision.confirmationId }),
					}),
					202,
				);
			}),
	);

	for (const version of [1, 2] as const)
		app.get(
			`/api/v${version}/conversations/:conversationId/executions/:executionId`,
			(context) =>
				boundary(context, async (metadata) => {
					const identity = await resolveIdentity(
						dependencies.identity,
						context.req.raw,
						metadata.traceId,
					);
					const conversationId = context.req.param("conversationId");
					await effectiveConversation(
						dependencies.commands(identity),
						conversationId,
						metadata.traceId,
					);
					const result = await query(
						() =>
							dependencies.query.getExecution(
								scope(identity),
								conversationId,
								context.req.param("executionId"),
							),
						metadata.traceId,
					);
					if (!result) return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
					if (version === 2) {
						const projection = project(
							() => executionProjection(result),
							metadata.traceId,
						);
						return context.json(
							project(
								() =>
									ExecutionDetailProjectionV2Schema.parse({
										...projection,
										schemaVersion: 2,
										events: result.events.map(eventProjection),
									}),
								metadata.traceId,
							),
						);
					}
					return context.json(
						project(() => executionProjection(result), metadata.traceId),
					);
				}),
		);

	for (const version of [1, 2] as const)
		app.get(
			`/api/v${version}/conversations/:conversationId/events`,
			(context) =>
				boundary(context, async (metadata) => {
					const v2 = version === 2;
					const identity = await resolveIdentity(
						dependencies.identity,
						context.req.raw,
						metadata.traceId,
					);
					const conversationId = context.req.param("conversationId");
					await authorize(
						dependencies,
						identity,
						{
							schemaVersion: 1,
							operation: "conversation.read",
							conversationId,
						},
						metadata.traceId,
						v2 ? "http" : "sse",
					);
					const initialReplay = await query(
						() =>
							dependencies.query.replay(
								scope(identity),
								conversationId,
								replaySelector(context.req.raw, metadata.traceId),
								context.req.raw.signal,
							),
						metadata.traceId,
					);
					if (!initialReplay)
						return fail(
							v2 ? "RESOURCE_UNAVAILABLE" : "FORBIDDEN",
							metadata.traceId,
						);
					if (initialReplay.outcome === "events") {
						try {
							initialReplay.events.forEach(eventProjection);
						} catch {
							return fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
						}
					}
					const request = context.req.raw;
					return streamSSE(
						context,
						async (stream) => {
							const connection = dependencies.sseResources?.open();
							const lifetime = new AbortController();
							const abort = () => lifetime.abort();
							request.signal.addEventListener("abort", abort, { once: true });
							stream.onAbort(abort);
							if (request.signal.aborted || stream.aborted) abort();
							let currentIdentity = identity;
							let checkedAt = performance.now();
							// The last check or read attempt; paused retries wait from it.
							let attemptedAt = checkedAt;
							let transientFailures = 0;
							const watcher = dependencies.eventWake?.watch(conversationId);
							const write = async <T>(task: () => Promise<T>): Promise<T> => {
								const pending = dependencies.sseResources?.beginPending();
								try {
									return await streamRead(task, readTimeoutMs, lifetime.signal);
								} catch (error) {
									// Cancel the underlying reader to discard queued writes on backpressure.
									stream.abort();
									throw error;
								} finally {
									pending?.close();
								}
							};
							const output = {
								writeSSE: (message: { id?: string; data: string }) =>
									write(() => stream.writeSSE(message)),
							};
							const terminate = async (
								reason: Extract<
									StreamAuthorization,
									{ outcome: "closed" }
								>["reason"],
							) => {
								if (lifetime.signal.aborted) return;
								// SSE comments expose only a fixed terminal reason, never identity/resource data.
								// They add no business event, cursor or new Contract Schema wire type.
								await write(() =>
									stream.write(`: conversation-stream.closed ${reason}\n\n`),
								);
								if (
									!lifetime.signal.aborted &&
									[
										"revoked",
										"disabled",
										"session_invalid",
										"subject_changed",
									].includes(reason)
								)
									await writeAuthorizationRevoked(output, metadata.traceId);
							};
							const check = async (): Promise<
								"allowed" | "paused" | "closed"
							> => {
								if (lifetime.signal.aborted) return "closed";
								attemptedAt = performance.now();
								let result: StreamAuthorization;
								try {
									result = await streamRead(
										() =>
											stillAuthorized(
												dependencies,
												request,
												identity.userId,
												conversationId,
												metadata.traceId,
											),
										readTimeoutMs,
										lifetime.signal,
									);
								} catch {
									result = {
										outcome: "closed",
										reason: "dependency_unavailable",
									};
								}
								if (lifetime.signal.aborted) return "closed";
								if (result.outcome === "closed") {
									// A slow or unavailable check proves nothing about access:
									// pause output and retry instead of closing (#1606).
									if (
										result.reason === "dependency_unavailable" &&
										transientFailure()
									)
										return "paused";
									await terminate(result.reason);
									return "closed";
								}
								currentIdentity = result.identity;
								checkedAt = attemptedAt;
								return "allowed";
							};
							/**
							 * Counts one transient check or read failure; false once the
							 * bound is spent. Only a successful replay read resets it, so
							 * neither a failing check nor a failing read can pause forever.
							 */
							const transientFailure = () => {
								transientFailures++;
								return transientFailures <= transientFailureLimit;
							};
							try {
								// A batch read but not yet written; it is written only after
								// a current authorization check succeeds (#1561, #1606).
								let pending: ConversationReplayResultV1 | undefined =
									initialReplay;
								let cursor = initialReplay.resumeCursor;
								while (!lifetime.signal.aborted) {
									if (pending) {
										const batch = pending;
										const state =
											batch.outcome === "reload" || batch.events.length > 0
												? await check()
												: "allowed";
										if (state === "closed") return;
										if (state === "allowed") {
											pending = undefined;
											if (batch.outcome === "reload") {
												await writeSseMessage(
													output,
													ConversationSseMessageV1Schema.parse({
														schemaVersion: 1,
														kind: "control",
														type: "timeline.reload",
														reason: batch.reason,
														resumeCursor: batch.resumeCursor,
													}),
												);
												return;
											}
											for (const persisted of batch.events) {
												if (v2)
													await writeSseMessageV2(
														output,
														eventProjection(persisted),
													);
												else {
													// V1 skips V2 facts but advances the durable cursor;
													// a fallback keeps its original V1 shape (G-07).
													const message = eventProjectionV1(persisted);
													if (message) await writeSseMessage(output, message);
												}
												cursor = persisted.conversationCursor;
											}
										}
									}
									// A commit wakeup reads sooner; polling remains the guarantee.
									// Waits never extend past the next authorization deadline,
									// and a paused stream retries one interval after its attempt.
									const waitMs = Math.max(
										1,
										Math.ceil(
											pollIntervalMs - (performance.now() - attemptedAt),
										),
									);
									const woken = watcher
										? await watcher.wait(waitMs, lifetime.signal)
										: await (async () => {
												await delay(waitMs, undefined, {
													signal: lifetime.signal,
												});
												return "timeout" as const;
											})();
									if (lifetime.signal.aborted) return;
									// A paused batch is retried with its own check.
									if (pending) continue;
									if (
										woken === "timeout" ||
										performance.now() - checkedAt >= pollIntervalMs
									) {
										const state = await check();
										if (state === "closed") return;
										if (state === "paused") continue;
									}
									let next: ConversationReplayResultV1 | undefined;
									try {
										next = await streamRead(
											() =>
												dependencies.query.replay(
													scope(currentIdentity),
													conversationId,
													{ kind: "cursor", value: cursor },
													lifetime.signal,
												),
											readTimeoutMs,
											lifetime.signal,
										);
									} catch {
										if (lifetime.signal.aborted) return;
										attemptedAt = performance.now();
										if (transientFailure()) continue;
										await terminate("dependency_unavailable");
										return;
									}
									if (!next) {
										await terminate("resource_unavailable");
										return;
									}
									transientFailures = 0;
									pending = next;
								}
							} catch {
								await terminate("dependency_unavailable");
							} finally {
								connection?.close();
								watcher?.close();
								request.signal.removeEventListener("abort", abort);
								abort();
							}
						},
						async (_error, stream) => stream.close(),
					);
				}),
		);
}
