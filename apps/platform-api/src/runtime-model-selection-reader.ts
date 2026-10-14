import {
	type RuntimeModelDirectoryDispatchRequestV1,
	RuntimeModelDirectoryDispatchRequestV1Schema,
	type RuntimeModelDirectoryRequestV1,
	RuntimeModelDirectoryRequestV1Schema,
	type RuntimeModelDirectoryResponseV1,
	RuntimeModelDirectoryResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import type { PostgresConversationQueryV1 } from "@agent-infra/platform-store";
import type {
	ConversationModelSelectionReaderV1,
	ConversationModelSelectionReaderV1 as Reader,
} from "./http/conversation-routes.js";
import type { IdentityContext } from "./http/identity.js";

export interface RuntimeModelDirectoryTransportV1 {
	read(
		request: RuntimeModelDirectoryRequestV1,
		signal: AbortSignal,
	): Promise<unknown>;
}

export interface RuntimeModelDirectoryDispatchTransportV1 {
	read(
		request: RuntimeModelDirectoryDispatchRequestV1,
		signal: AbortSignal,
	): Promise<unknown>;
}

function projectRuntimeModelDirectory(
	identity: IdentityContext,
	conversationId: string,
	bound: {
		readonly actorId: string;
		readonly conversationId: string;
		readonly channelId: string;
		readonly agentId: string;
		readonly hostSessionRef: string;
	},
	response: RuntimeModelDirectoryResponseV1,
) {
	if (
		bound.actorId !== identity.userId ||
		bound.conversationId !== conversationId ||
		bound.channelId !== "web" ||
		response.hostSessionRef !== bound.hostSessionRef
	)
		return null;
	const current = response.options.find(
		(option) => option.modelOptionId === response.current.modelOptionId,
	);
	if (
		!current?.reasoningLevels.includes(response.current.reasoningLevel) ||
		new Set(response.options.map((option) => option.modelOptionId)).size !==
			response.options.length
	)
		return null;
	return {
		agentId: bound.agentId,
		source: "custom-platform-adapter" as const,
		available: true,
		options: response.options.map((option) => ({
			optionId: option.modelOptionId,
			displayName: option.displayName,
			modelId: option.modelId,
			reasoningLevels: [...option.reasoningLevels],
		})),
		currentModelOptionId: response.current.modelOptionId,
		currentReasoningLevel: response.current.reasoningLevel,
	};
}

/**
 * Adapts the authenticated Runtime response to the API's public reader seam.
 * Session/fence binding is supplied by the deployment resolver and every
 * response is checked against the exact request before projection.
 */
export function createRuntimeModelSelectionReaderV1(options: {
	readonly resolveRequest: (input: {
		readonly identity: IdentityContext;
		readonly conversationId: string;
		readonly signal: AbortSignal;
	}) => Promise<RuntimeModelDirectoryRequestV1 | null>;
	readonly transport: RuntimeModelDirectoryTransportV1;
}): ConversationModelSelectionReaderV1 {
	if (typeof options.resolveRequest !== "function" || !options.transport)
		throw new TypeError("Runtime model-directory reader options are invalid");
	return {
		async read(identity, conversationId) {
			const controller = new AbortController();
			try {
				const request = await options.resolveRequest({
					identity,
					conversationId,
					signal: controller.signal,
				});
				if (!request) return null;
				const bound = RuntimeModelDirectoryRequestV1Schema.parse(request);
				const response = RuntimeModelDirectoryResponseV1Schema.parse(
					await options.transport.read(bound, controller.signal),
				);
				if (response.executionId !== bound.executionId) return null;
				return projectRuntimeModelDirectory(
					identity,
					conversationId,
					bound,
					response,
				);
			} catch {
				return null;
			} finally {
				controller.abort();
			}
		},
	};
}

/**
 * API-side reader for the production API → Worker dispatch. The Worker owns
 * the RuntimeHost Grant; the API only supplies the already-bound Session
 * request and never manufactures a placeholder Grant.
 */
export function createRuntimeModelSelectionReaderFromDispatchV1(options: {
	readonly resolveRequest: (input: {
		readonly identity: IdentityContext;
		readonly conversationId: string;
		readonly signal: AbortSignal;
	}) => Promise<RuntimeModelDirectoryDispatchRequestV1 | null>;
	readonly transport: RuntimeModelDirectoryDispatchTransportV1;
}): ConversationModelSelectionReaderV1 {
	if (typeof options.resolveRequest !== "function" || !options.transport)
		throw new TypeError("Runtime model-directory dispatch options are invalid");
	return {
		async read(identity, conversationId) {
			const controller = new AbortController();
			try {
				const request = await options.resolveRequest({
					identity,
					conversationId,
					signal: controller.signal,
				});
				if (!request) return null;
				const bound =
					RuntimeModelDirectoryDispatchRequestV1Schema.parse(request);
				const response = RuntimeModelDirectoryResponseV1Schema.parse(
					await options.transport.read(bound, controller.signal),
				);
				if (response.executionId !== bound.executionId) return null;
				return projectRuntimeModelDirectory(
					identity,
					conversationId,
					bound,
					response,
				);
			} catch {
				return null;
			} finally {
				controller.abort();
			}
		},
	};
}

/** Compose the production reader from the Platform Store binding and Worker transport. */
export function createRuntimeModelSelectionReaderFromStoreV1(options: {
	readonly query: Pick<
		PostgresConversationQueryV1,
		"readRuntimeModelDirectoryDispatchRequestV1"
	>;
	readonly transport: RuntimeModelDirectoryDispatchTransportV1;
}): ConversationModelSelectionReaderV1 {
	return createRuntimeModelSelectionReaderFromDispatchV1({
		resolveRequest: ({ identity, conversationId, signal }) =>
			options.query
				.readRuntimeModelDirectoryDispatchRequestV1({
					scope: {
						actorId: identity.userId,
						channelId: "web",
						principal: { kind: "user", id: identity.userId },
					},
					conversationId,
					signal,
				})
				.then((request) => request ?? null),
		transport: options.transport,
	});
}

export type RuntimeModelSelectionReaderV1 = Reader;
