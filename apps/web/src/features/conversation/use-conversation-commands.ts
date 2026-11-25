import { NativeCapabilityInvocationRequestV3Schema } from "@agent-infra/contracts/pilot";
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

// Retain bounded command metadata for a read-only lookup across a tab reload.
function pendingLookup(key: string | undefined): Attempt | undefined {
	if (!key) return;
	try {
		const raw = sessionStorage.getItem(key);
		if (!raw) return;
		const result = NativeCapabilityInvocationRequestV3Schema.safeParse(
			JSON.parse(raw),
		);
		if (!result.success) return;
		const { idempotencyKey: id, requestId, traceId, ...body } = result.data;
		if (body.parameters !== "" || id !== requestId || id !== traceId) return;
		return {
			id,
			command: { kind: "native-capability", body },
			target: { agentId: "" },
			controller: new AbortController(),
			pending: false,
			uncertain: true,
		};
	} catch {
		return;
	}
}

function saveLookup(key: string | undefined, attempt?: Attempt) {
	if (!key) return;
	try {
		if (!attempt) {
			sessionStorage.removeItem(key);
			return;
		}
		if (attempt.command.kind !== "native-capability") return;
		const body = attempt.command.body;
		if (
			!("schemaVersion" in body) ||
			body.schemaVersion !== 3 ||
			body.parameters !== ""
		)
			return;
		sessionStorage.setItem(
			key,
			JSON.stringify({
				...body,
				idempotencyKey: attempt.id,
				requestId: attempt.id,
				traceId: attempt.id,
			}),
		);
	} catch {
		/* A tab without browser storage can still verify its in-memory request. */
	}
}

/** identityKey changes with the authenticated subject/session. The hook owns
 * one local attempt; it does not submit on mount, reconnect or target changes. */
export function useConversationCommands({
	identityKey,
	userId,
	agentId,
	conversationId,
	executionId,
	client = defaultClient,
}: ConversationCommandTarget & {
	identityKey: string;
	userId?: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const instanceId = useRef(crypto.randomUUID()).current;
	const scope = useMemo(() => {
		const storageKey =
			userId && conversationId
				? JSON.stringify(["native-command-v3", userId, agentId, conversationId])
				: undefined;
		const original = pendingLookup(storageKey);
		if (original) original.target = { agentId, conversationId };
		return {
			storageKey,
			id: crypto.randomUUID(),
			identityKey,
			target: { agentId, conversationId },
			client,
			active: false,
			denied: false,
			attempt: original,
			lastAttemptId: undefined as string | undefined,
		};
	}, [identityKey, userId, agentId, conversationId, client]);
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
				attempt.uncertain === true &&
					attempt.command.kind === "native-capability" &&
					"schemaVersion" in attempt.command.body &&
					attempt.command.body.schemaVersion === 3,
			);
			if (!scope.active || scope.attempt !== attempt) return undefined;
			attempt.pending = false;
			attempt.uncertain = result.kind === "unknown";
			// 待确认的 404 不立刻闭锁：Agent 被停止时同样是 404，先由页面重新读取 Agent，
			// 确认确实失去访问权限才调用 confirmDenied（#2570）。
			if (result.kind === "denied" && !result.ambiguous) scope.denied = true;
			if (
				result.kind !== "unknown" &&
				!(result.kind === "rejected" && result.retryable)
			) {
				scope.attempt = undefined;
				saveLookup(scope.storageKey);
			}
			return result;
		},
		onSettled: removeOwnMutations,
	});
	useLayoutEffect(() => {
		scope.active = true;
		if (!scope.attempt) scope.attempt = pendingLookup(scope.storageKey);
		if (scope.attempt) scope.attempt.target = scope.target;
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
		saveLookup(scope.storageKey, attempt);
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
		saveLookup(scope.storageKey);
		setConfirmation((value) => value + 1);
	}, [scope]);
	const revoke = useCallback(() => {
		if (!scope.active) return;
		scope.denied = true;
		saveLookup(scope.storageKey);
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
			!scope.attempt.pending,
		result:
			visible && mutation.data
				? mutation.data
				: scope.attempt?.uncertain
					? { kind: "unknown" as const }
					: undefined,
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
		/** 撤回自己仍在排队的消息（#3376）；目标是该消息的等待 Execution，不是当前回复。 */
		withdraw: (targetExecutionId: string) =>
			start({
				kind: "withdraw",
				body: { schemaVersion: 1, targetExecutionId },
			}),
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
		retry: () => {
			const attempt = scope.attempt;
			if (!scope.active || scope.denied || !attempt || attempt.pending)
				return false;
			scope.lastAttemptId = attempt.id;
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
