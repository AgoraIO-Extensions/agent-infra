import {
	CommandAcceptedProjectionV1Schema,
	ConversationDetailProjectionV1Schema,
	ConversationProjectionV1Schema,
	ConversationSseMessageV1Schema,
	ExecutionDetailProjectionV1Schema,
	framePilotSseMessageV1,
	MessageCommandRequestV1Schema,
	MessageProjectionV1Schema,
	ModelSelectionUpdateRequestV1Schema,
	RegenerateCommandRequestV1Schema,
	resolvePilotReplaySelectorV1,
	StopCommandRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionAuthorizationPortV1,
	ConversationExecutionError,
	type ConversationExecutionUseCaseV1,
	type ConversationStateResultV1,
} from "@agent-infra/platform-core";
import type {
	ConversationExecutionDetailV1,
	ConversationQueryDetailV1,
	ConversationQueryEventV1,
	ConversationQueryPageV1,
	ConversationQueryProjectionV1,
	ConversationQueryScopeV1,
	ConversationReplayResultV1,
} from "@agent-infra/platform-store";
import { ConversationQueryError } from "@agent-infra/platform-store";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";

import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	parsePageQuery,
	type RequestMetadata,
	requestMetadata,
} from "./common.js";
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
	| Parameters<ConversationExecutionAuthorizationPortV1["authorize"]>[0];

type AuthorizationDecision =
	| {
			readonly outcome: "allowed";
			readonly authority: ConversationExecutionAuthorityV1;
	  }
	| { readonly outcome: "denied" };

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
	get(
		scope: ConversationQueryScopeV1,
		conversationId: string,
	): Promise<ConversationQueryDetailV1 | undefined>;
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
	): Promise<ConversationReplayResultV1 | undefined>;
}

export interface ConversationRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly authorization: ConversationAuthorization;
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
	readonly query: ConversationQuery;
	readonly streamPollIntervalMs?: number;
}

type ConversationProjection = ReturnType<
	typeof ConversationProjectionV1Schema.parse
>;
type MessageProjection = ReturnType<typeof MessageProjectionV1Schema.parse>;
type SseMessage = ReturnType<typeof ConversationSseMessageV1Schema.parse>;

const createConversationRequestSchema = {
	safeParse(value: unknown) {
		return typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			Object.keys(value).length === 1 &&
			(value as { schemaVersion?: unknown }).schemaVersion === 1
			? { success: true as const, data: { schemaVersion: 1 as const } }
			: { success: false as const, error: undefined };
	},
};

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
	return (
		typeof authority === "object" &&
		authority !== null &&
		Object.keys(authority).length === 6 &&
		authority.schemaVersion === 1 &&
		authority.actorId === identity.userId &&
		authority.channelId === "web" &&
		authority.authorizationRevision === identity.authorizationRevision &&
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
		effective.conversation.agentId !== input.agentId ||
		effective.conversation.status !== input.status
	) {
		throw new Error("Conversation projection is inconsistent");
	}
	return ConversationProjectionV1Schema.parse({
		schemaVersion: 1,
		conversationId: input.conversationId,
		agentId: input.agentId,
		title: null,
		status: input.status,
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

function project<T>(projection: () => T, traceId: string): T {
	try {
		return projection();
	} catch {
		return fail("DEPENDENCY_UNAVAILABLE", traceId);
	}
}

function record(input: unknown): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("Invalid persisted event");
	}
	return input as Record<string, unknown>;
}

function exactRecord(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	const value = record(input);
	const allowed = new Set([...required, ...optional]);
	if (
		Object.keys(value).some((key) => !allowed.has(key)) ||
		required.some((key) => !Object.hasOwn(value, key))
	) {
		throw new Error("Invalid persisted event shape");
	}
	return value;
}

function eventProjection(input: ConversationQueryEventV1): SseMessage {
	let persisted = record(input.eventPayload);
	if (persisted.type !== input.eventType) {
		throw new Error("Invalid persisted event type");
	}
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
	let projected: unknown;
	if (input.eventType === "text.delta") {
		persisted = exactRecord(persisted, ["type", "text"]);
		projected = {
			...base,
			type: "text.delta",
			payload: { text: persisted.text },
		};
	} else if (input.eventType === "execution.status") {
		persisted = exactRecord(persisted, ["type", "status"]);
		projected = {
			...base,
			type: "execution.status",
			payload: { status: persisted.status },
		};
	} else if (input.eventType === "execution.detail") {
		persisted = exactRecord(
			persisted,
			["type", "category", "summary"],
			["callId"],
		);
		projected = {
			...base,
			type: "execution.detail",
			payload: {
				category: persisted.category,
				summary: persisted.summary,
				...(persisted.callId === undefined ? {} : { callId: persisted.callId }),
			},
		};
	} else if (input.eventType === "result.file") {
		persisted = exactRecord(persisted, [
			"type",
			"fileId",
			"name",
			"mediaType",
			"sizeBytes",
		]);
		projected = {
			...base,
			type: "result.file",
			payload: {
				fileId: persisted.fileId,
				name: persisted.name,
				mediaType: persisted.mediaType,
				sizeBytes: persisted.sizeBytes,
			},
		};
	} else if (input.eventType === "conversation.error") {
		persisted = exactRecord(persisted, [
			"type",
			"code",
			"message",
			"retryable",
		]);
		projected = {
			...base,
			type: "conversation.error",
			payload: {
				error: {
					schemaVersion: 1,
					code: persisted.code,
					message: "Conversation processing failed.",
					retryable: persisted.retryable,
					traceId: input.traceId,
				},
			},
		};
	} else if (input.eventType === "model.selection.fell_back") {
		persisted = exactRecord(persisted, [
			"type",
			"modelOptionId",
			"reasoningLevel",
			"reason",
		]);
		projected = {
			...base,
			type: "model.selection.fell_back",
			payload: {
				modelOptionId: persisted.modelOptionId,
				reasoningLevel: persisted.reasoningLevel,
				reason: persisted.reason,
			},
		};
	} else {
		throw new Error("Unsupported persisted event type");
	}
	return ConversationSseMessageV1Schema.parse(projected);
}

function executionStatus(
	input: string,
):
	| "submitted"
	| "processing"
	| "completed"
	| "failed"
	| "cancelled"
	| "unknown" {
	if (
		input === "submitted" ||
		input === "processing" ||
		input === "completed" ||
		input === "failed" ||
		input === "cancelled" ||
		input === "unknown"
	) {
		return input;
	}
	throw new Error("Invalid persisted execution status");
}

function failure(traceId: string | null) {
	if (!traceId) throw new Error("Missing execution trace");
	return {
		schemaVersion: 1 as const,
		code: "EXECUTION_FAILED" as const,
		message: "Execution failed.",
		retryable: false as const,
		traceId,
	};
}

function messageProjections(
	input: ConversationQueryDetailV1,
): MessageProjection[] {
	const userMessages = input.messages.map((item) =>
		MessageProjectionV1Schema.parse({
			messageId: item.messageId,
			role: "user",
			text: item.text,
			status: item.status,
			executionId: item.executionId,
			replyToMessageId: null,
			answerVersion: null,
			isCurrentAnswer: null,
			error: null,
			createdAt: item.createdAt.toISOString(),
		}),
	);
	const bySource = new Map<string, typeof input.executions>();
	for (const item of input.executions) {
		if (!item.sourceMessageId) continue;
		bySource.set(item.sourceMessageId, [
			...(bySource.get(item.sourceMessageId) ?? []),
			item,
		]);
	}
	const answers = [...bySource.entries()].flatMap(([sourceMessageId, items]) =>
		items.flatMap((item, index) => {
			const events = input.events.filter(
				(event) => event.executionId === item.executionId,
			);
			const text = events
				.filter((event) => event.eventType === "text.delta")
				.map((event) => record(event.eventPayload).text)
				.join("");
			const status = executionStatus(item.status);
			if (
				text.length === 0 &&
				!["completed", "failed", "cancelled"].includes(status)
			) {
				return [];
			}
			const messageStatus = status === "unknown" ? "processing" : status;
			const createdAt = events[0]?.occurredAt ?? item.updatedAt;
			return [
				MessageProjectionV1Schema.parse({
					messageId: `assistant:${item.executionId}`,
					role: "assistant",
					text,
					status: messageStatus,
					executionId: item.executionId,
					replyToMessageId: sourceMessageId,
					answerVersion: index + 1,
					isCurrentAnswer: index === items.length - 1,
					error: status === "failed" ? failure(item.traceId) : null,
					createdAt: createdAt.toISOString(),
				}),
			];
		}),
	);
	return [...userMessages, ...answers].toSorted(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) ||
			left.messageId.localeCompare(right.messageId),
	);
}

function executionProjection(input: ConversationExecutionDetailV1) {
	const status = executionStatus(input.execution.status);
	const statusEvents = input.events.flatMap((item) => {
		if (item.eventType !== "execution.status") return [];
		const persisted = record(item.eventPayload);
		const eventStatus = executionStatus(String(persisted.status));
		return [
			{
				occurredAt: item.occurredAt.toISOString(),
				kind: "status" as const,
				status: eventStatus,
				summary: `Execution ${eventStatus}.`,
			},
		];
	});
	const startedAt = statusEvents.find(
		({ status }) => status === "processing",
	)?.occurredAt;
	const finishedAt = statusEvents.find(({ status }) =>
		["completed", "failed", "cancelled"].includes(status),
	)?.occurredAt;
	return ExecutionDetailProjectionV1Schema.parse({
		schemaVersion: 1,
		executionId: input.execution.executionId,
		conversationId: input.execution.conversationId,
		status,
		processSummary: statusEvents,
		startedAt: startedAt ?? null,
		finishedAt: finishedAt ?? null,
		error: status === "failed" ? failure(input.execution.traceId) : null,
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

async function stillAuthorized(
	dependencies: ConversationRoutesDependencies,
	request: Request,
	initialUserId: string,
	conversationId: string,
	traceId: string,
): Promise<"allowed" | "revoked" | "unavailable"> {
	try {
		const identity = await resolveIdentity(
			dependencies.identity,
			request,
			traceId,
		);
		if (identity.userId !== initialUserId) return "revoked";
		const decision = await dependencies.authorization.authorize(identity, {
			schemaVersion: 1,
			operation: "conversation.read",
			conversationId,
		});
		if (decision.outcome !== "allowed") return "revoked";
		return authorityMatches(decision.authority, identity)
			? "allowed"
			: "unavailable";
	} catch (error) {
		return error instanceof HttpProtocolError &&
			(error.body.code === "AUTHENTICATION_REQUIRED" ||
				error.body.code === "AUTHORIZATION_REVOKED")
			? "revoked"
			: "unavailable";
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
	traceId: string,
): Promise<never> {
	const detail = await query(
		() => dependencies.query.get(scope(identity), conversationId),
		traceId,
	);
	return fail(
		detail?.conversation.status === "unavailable"
			? "CONVERSATION_UNAVAILABLE"
			: "RESOURCE_UNAVAILABLE",
		traceId,
	);
}

export function registerConversationRoutes(
	app: Hono,
	dependencies: ConversationRoutesDependencies,
): void {
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
			return context.json({ items, nextCursor: result.nextCursor });
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
				createConversationRequestSchema,
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
			if (decision.outcome === "denied")
				return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
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

	app.get("/api/v1/conversations/:conversationId", (context) =>
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
			const detail = await query(
				() => dependencies.query.get(scope(identity), conversationId),
				metadata.traceId,
			);
			if (!detail) return fail("RESOURCE_UNAVAILABLE", metadata.traceId);
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
			const [detail, effective] = await Promise.all([
				query(
					() => dependencies.query.get(scope(identity), conversationId),
					metadata.traceId,
				),
				effectiveConversation(useCase, conversationId, metadata.traceId),
			]);
			if (!detail) return fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(
				project(
					() => conversationProjection(detail.conversation, effective),
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
			const decision = await dependencies.commands(identity).accept({
				schemaVersion: 1,
				command: "message",
				conversationId: context.req.param("conversationId"),
				text: body.text,
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				requestId: metadata.requestId,
				traceId: metadata.traceId,
			});
			if (decision.outcome === "busy") return fail("BUSY", metadata.traceId);
			if (decision.outcome === "denied") {
				return deniedCommand(
					dependencies,
					identity,
					context.req.param("conversationId"),
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
			});
			if (decision.outcome === "busy") return fail("BUSY", metadata.traceId);
			if (decision.outcome === "denied") {
				return deniedCommand(
					dependencies,
					identity,
					context.req.param("conversationId"),
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

	app.get(
		"/api/v1/conversations/:conversationId/executions/:executionId",
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
				return context.json(
					project(() => executionProjection(result), metadata.traceId),
				);
			}),
	);

	app.get("/api/v1/conversations/:conversationId/events", (context) =>
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
				"sse",
			);
			const initialReplay = await query(
				() =>
					dependencies.query.replay(
						scope(identity),
						conversationId,
						replaySelector(context.req.raw, metadata.traceId),
					),
				metadata.traceId,
			);
			if (!initialReplay) return fail("FORBIDDEN", metadata.traceId);
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
					let replay: ConversationReplayResultV1 = initialReplay;
					let cursor = replay.resumeCursor;
					while (!request.signal.aborted && !stream.aborted) {
						const batch = replay;
						if (batch.outcome === "reload") {
							const authorization = await stillAuthorized(
								dependencies,
								request,
								identity.userId,
								conversationId,
								metadata.traceId,
							);
							if (authorization !== "allowed") {
								if (authorization === "revoked") {
									await writeAuthorizationRevoked(stream, metadata.traceId);
								}
								return;
							}
							await writeSseMessage(
								stream,
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
							const authorization = await stillAuthorized(
								dependencies,
								request,
								identity.userId,
								conversationId,
								metadata.traceId,
							);
							if (authorization !== "allowed") {
								if (authorization === "revoked") {
									await writeAuthorizationRevoked(stream, metadata.traceId);
								}
								return;
							}
							const message = eventProjection(persisted);
							await writeSseMessage(stream, message);
							cursor = persisted.conversationCursor;
						}
						await stream.sleep(dependencies.streamPollIntervalMs ?? 1000);
						if (request.signal.aborted || stream.aborted) return;
						const next = await dependencies.query.replay(
							scope(identity),
							conversationId,
							{ kind: "cursor", value: cursor },
						);
						if (!next) return;
						replay = next;
					}
				},
				async (_error, stream) => stream.close(),
			);
		}),
	);
}
