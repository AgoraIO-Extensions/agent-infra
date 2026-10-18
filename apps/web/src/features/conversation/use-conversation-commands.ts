import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Client } from "../../pilot/generated/client/index.js";
import { client as defaultClient } from "../../pilot/generated/client.gen.js";
import {
	type BrowserCommandBody,
	type ConversationCommand,
	type ConversationCommandTarget,
	type NativeCapabilityCommandBody,
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
	const scope = useMemo(() => {
		return {
			id: crypto.randomUUID(),
			identityKey,
			target: { agentId, conversationId },
			client,
			active: false,
			denied: false,
			attempt: undefined as Attempt | undefined,
			lastAttemptId: undefined as string | undefined,
		};
	}, [identityKey, agentId, conversationId, client]);
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
			// 待确认的 404 不立刻闭锁：Agent 被停止时同样是 404，先由页面重新读取 Agent，
			// 确认确实失去访问权限才调用 confirmDenied（#2570）。
			if (result.kind === "denied" && !result.ambiguous) scope.denied = true;
			const retryable =
				result.kind === "unknown" ||
				(result.kind === "denied" && result.ambiguous === true) ||
				(result.kind === "rejected" && result.retryable);
			if (!retryable) scope.attempt = undefined;
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
	function submitText(text: SubmitText, attachments: readonly string[] = []) {
		// The server chooses initial or supplement atomically at acceptance.
		// Only the receipt establishes which execution accepted this message.
		return start({
			kind: "message",
			body: {
				schemaVersion: 1,
				text,
				...(attachments.length ? { attachments: [...attachments] } : {}),
			},
		});
	}
	const visible = scope.active && scope.lastAttemptId === mutation.variables;
	const [, setConfirmation] = useState(0);
	const confirmDenied = useCallback(() => {
		if (!scope.active || scope.denied) return;
		scope.denied = true;
		setConfirmation((value) => value + 1);
	}, [scope]);
	const revoke = useCallback(() => {
		if (!scope.active) return;
		scope.denied = true;
		scope.attempt?.controller.abort();
		scope.attempt = undefined;
		scope.lastAttemptId = undefined;
		mutation.reset();
		removeOwnMutations();
	}, [scope, mutation.reset, removeOwnMutations]);
	return {
		isPending: visible && mutation.isPending,
		isDenied: scope.denied,
		canRetry:
			scope.active &&
			!scope.denied &&
			scope.attempt !== undefined &&
			!scope.attempt.pending &&
			scope.attempt.command.kind !== "create",
		result: visible ? mutation.data : undefined,
		revoke,
		confirmDenied,
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
		invokeCapability: (body: NativeCapabilityCommandBody) =>
			start({ kind: "native-capability", body }),
		invokeBrowser: (body: BrowserCommandBody) =>
			start({ kind: "browser", body }),
		retry: (text?: string) => {
			const attempt = scope.attempt;
			if (!scope.active || scope.denied || !attempt || attempt.pending)
				return false;
			if (text !== undefined && attempt.command.kind === "message") {
				attempt.command = {
					...attempt.command,
					body: { ...attempt.command.body, text },
				};
			}
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
