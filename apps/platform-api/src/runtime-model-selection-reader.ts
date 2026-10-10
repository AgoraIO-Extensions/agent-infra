import {
	type RuntimeModelDirectoryRequestV1,
	RuntimeModelDirectoryRequestV1Schema,
	RuntimeModelDirectoryResponseV1Schema,
} from "@agent-infra/contracts/runtime";
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
				if (
					bound.actorId !== identity.userId ||
					bound.conversationId !== conversationId ||
					bound.channelId !== "web"
				)
					return null;
				const response = RuntimeModelDirectoryResponseV1Schema.parse(
					await options.transport.read(bound, controller.signal),
				);
				if (
					response.hostSessionRef !== bound.hostSessionRef ||
					response.executionId !== bound.executionId
				)
					return null;
				const current = response.options.find(
					(option) => option.modelOptionId === response.current.modelOptionId,
				);
				if (
					!current?.reasoningLevels.includes(response.current.reasoningLevel) ||
					new Set(response.options.map((option) => option.modelOptionId))
						.size !== response.options.length
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
			} catch {
				return null;
			} finally {
				controller.abort();
			}
		},
	};
}

export type RuntimeModelSelectionReaderV1 = Reader;
