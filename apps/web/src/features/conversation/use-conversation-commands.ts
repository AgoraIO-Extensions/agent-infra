import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { Client } from "../../pilot/generated/client/index.js";
import { client as defaultClient } from "../../pilot/generated/client.gen.js";
import {
	type ConversationCommand,
	type ConversationCommandTarget,
	performConversationCommand,
} from "./conversation-commands.js";

type Attempt = {
	id: string;
	command: ConversationCommand;
	target: ConversationCommandTarget;
	controller: AbortController;
	pending: boolean;
	uncertain?: boolean;
};

/** identityKey changes with the authenticated subject/session. The hook owns
 * one local attempt; it does not submit on mount, reconnect or target changes. */
export function useConversationCommands({
	identityKey,
	agentId,
	conversationId,
	executionId,
	client = defaultClient,
}: ConversationCommandTarget & { identityKey: string; client?: Client }) {
	const queryClient = useQueryClient();
	const instanceId = useRef(crypto.randomUUID()).current;
	const scope = useMemo(
		() => ({
			id: crypto.randomUUID(),
			identityKey,
			target: { agentId, conversationId },
			client,
			active: false,
			denied: false,
			attempt: undefined as Attempt | undefined,
			lastAttemptId: undefined as string | undefined,
		}),
		[identityKey, agentId, conversationId, client],
	);
	const mutationKey = useMemo(
		() => ["conversation-command", instanceId, scope.id],
		[instanceId, scope.id],
	);
	const removeOwnMutations = useCallback(() => {
		for (const item of queryClient
			.getMutationCache()
			.findAll({ mutationKey, exact: true }))
			queryClient.getMutationCache().remove(item);
	}, [queryClient, mutationKey]);
	const mutation = useMutation({
		mutationKey,
		retry: false,
		networkMode: "always",
		gcTime: 0,
		mutationFn: async (id: string) => {
			const attempt = scope.attempt;
			if (!scope.active || !attempt || attempt.id !== id) return undefined;
			const result = await performConversationCommand(
				attempt.command,
				attempt.target,
				id,
				scope.client,
				attempt.controller.signal,
			);
			if (!scope.active || scope.attempt !== attempt) return undefined;
			attempt.pending = false;
			attempt.uncertain = result.kind === "unknown";
			if (result.kind === "denied") scope.denied = true;
			if (
				result.kind !== "unknown" &&
				!(result.kind === "rejected" && result.retryable)
			)
				scope.attempt = undefined;
			return result;
		},
		onSettled: removeOwnMutations,
	});
	useLayoutEffect(() => {
		scope.active = true;
		mutation.reset();
		return () => {
			scope.active = false;
			scope.attempt?.controller.abort();
			scope.attempt = undefined;
			removeOwnMutations();
		};
	}, [scope, mutation.reset, removeOwnMutations]);
	function start(command: ConversationCommand) {
		if (
			!scope.active ||
			scope.denied ||
			!scope.identityKey ||
			!scope.target.agentId ||
			scope.attempt?.pending ||
			scope.attempt?.uncertain
		)
			return false;
		const attempt: Attempt = {
			id: crypto.randomUUID(),
			command,
			target: { ...scope.target, executionId },
			controller: new AbortController(),
			pending: true,
		};
		scope.attempt = attempt;
		scope.lastAttemptId = attempt.id;
		mutation.mutate(attempt.id);
		return true;
	}
	function submitText(text: SubmitText) {
		// The server chooses initial or supplement atomically at acceptance.
		// Only the receipt establishes which execution accepted this message.
		return start({ kind: "message", body: { schemaVersion: 1, text } });
	}
	const visible = scope.active && scope.lastAttemptId === mutation.variables;
	return {
		isPending: visible && mutation.isPending,
		isDenied: scope.denied,
		canRetry:
			scope.active &&
			!scope.denied &&
			scope.attempt !== undefined &&
			!scope.attempt.pending,
		result: visible ? mutation.data : undefined,
		revoke: () => {
			if (!scope.active) return;
			scope.denied = true;
			scope.attempt?.controller.abort();
			scope.attempt = undefined;
			scope.lastAttemptId = undefined;
			mutation.reset();
			removeOwnMutations();
		},
		create: () => start({ kind: "create", body: { schemaVersion: 1 } }),
		submitText,
		supplement: submitText,
		stop: () =>
			start({
				kind: "stop",
				body: {
					schemaVersion: 1,
					targetExecutionId: executionId ?? "",
				},
			}),
		regenerate: (messageId: string) =>
			start({ kind: "regenerate", body: { schemaVersion: 1, messageId } }),
		selectModel: (
			selection: Omit<
				Extract<ConversationCommand, { kind: "selection" }>["body"],
				"schemaVersion"
			>,
		) => start({ kind: "selection", body: { schemaVersion: 1, ...selection } }),
		retry: () => {
			const attempt = scope.attempt;
			if (!scope.active || scope.denied || !attempt || attempt.pending)
				return false;
			attempt.controller = new AbortController();
			attempt.pending = true;
			mutation.mutate(attempt.id);
			return true;
		},
	};
}

type SubmitText = Extract<
	ConversationCommand,
	{ kind: "message" }
>["body"]["text"];
