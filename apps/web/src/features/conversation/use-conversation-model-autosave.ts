import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Client } from "../../pilot/generated/client/index.js";
import { client as defaultClient } from "../../pilot/generated/client.gen.js";
import {
	type ConversationCommandResult,
	performConversationCommand,
} from "./conversation-commands.js";
import { commandFailure } from "./conversation-screen-state.js";

export type ModelSelectionValue = Readonly<{
	modelOptionId: string;
	reasoningLevel: string;
}>;

export type ModelAutosavePhase = "idle" | "saving" | "error";

type Attempt = {
	key: string;
	value: ModelSelectionValue;
	controller: AbortController;
};

/**
 * 模型与思考档位「选中即保存」。保存请求使用独立于消息命令的请求槽：它的挂起与待核实
 * 不锁住草稿、停止回复或消息命令（CK-06、NI-84），只阻止发送。
 *
 * - 保存中再次选择：以最后一次为准，当前请求结束后补发一次。
 * - 5xx、网络错误、回执不合法或可重试拒绝（503 RUNTIME_UNAVAILABLE）：进入 error，
 *   「重试」复用同一个 Idempotency-Key；用户重新选择则用新键覆盖并丢弃待核实的旧请求。
 * - 不可重试拒绝（如 409 MODEL_SELECTION_INVALID）：回到服务端已保存的选择并说明原因。
 */
export function useConversationModelAutosave({
	agentId,
	conversationId,
	onSaved,
	onFailed,
	onDenied,
	client = defaultClient,
}: {
	agentId: string;
	conversationId: string;
	/** 成功后重读投影，让已保存的值成为权威值。 */
	onSaved: () => void;
	/** 进入 error 时的补充反馈（Toast）；失败本身由「重试」表达。 */
	onFailed?: () => void;
	/** 401/403 或 404 等访问边界交给页面统一处理。 */
	onDenied: (
		result: Extract<ConversationCommandResult, { kind: "denied" }>,
	) => void;
	client?: Client;
}) {
	const [desired, setDesired] = useState<ModelSelectionValue>();
	const [phase, setPhase] = useState<ModelAutosavePhase>("idle");
	const [failure, setFailure] = useState<string>();
	const [saved, setSaved] = useState(false);
	const active = useRef(true);
	const inflight = useRef<Attempt | undefined>(undefined);
	const failed = useRef<Attempt | undefined>(undefined);
	const queued = useRef<ModelSelectionValue | undefined>(undefined);
	const callbacks = useRef({ onSaved, onFailed, onDenied });
	callbacks.current = { onSaved, onFailed, onDenied };
	useLayoutEffect(() => {
		active.current = true;
		return () => {
			// 切换会话后迟到的结果不得改动新会话的草稿与模型入口。
			active.current = false;
			inflight.current?.controller.abort();
			inflight.current = undefined;
		};
	}, []);
	const send = useCallback(
		async (attempt: Attempt) => {
			inflight.current = attempt;
			failed.current = undefined;
			setFailure(undefined);
			setPhase("saving");
			const result = await performConversationCommand(
				{
					kind: "selection",
					body: { schemaVersion: 1, ...attempt.value },
				},
				{ agentId, conversationId },
				attempt.key,
				client,
				attempt.controller.signal,
			);
			if (!active.current || inflight.current !== attempt) return;
			inflight.current = undefined;
			const next = queued.current;
			queued.current = undefined;
			if (next) {
				// 用户在保存期间又改了选择：以最后一次为准，用新键覆盖。
				await send(newAttempt(next));
				return;
			}
			if (result.kind === "selection-updated") {
				setPhase("idle");
				setSaved(true);
				callbacks.current.onSaved();
				return;
			}
			if (
				result.kind === "unknown" ||
				(result.kind === "rejected" && result.retryable)
			) {
				failed.current = attempt;
				setPhase("error");
				callbacks.current.onFailed?.();
				return;
			}
			// 不可重试：回到服务端已保存的选择，并说明原因；发送恢复可用。
			setDesired(undefined);
			setPhase("idle");
			if (result.kind === "denied") {
				callbacks.current.onDenied(result);
				return;
			}
			setFailure(
				result.kind === "rejected"
					? commandFailure(result.code)
					: commandFailure("INVALID_REQUEST"),
			);
		},
		[agentId, conversationId, client],
	);
	const choose = useCallback(
		(value: ModelSelectionValue) => {
			setDesired(value);
			setSaved(false);
			if (inflight.current) {
				queued.current = value;
				return;
			}
			void send(newAttempt(value));
		},
		[send],
	);
	/** 重试上次失败的保存；返回的 Promise 在这次保存（含期间改选的覆盖保存）结束后完成。 */
	const retry = useCallback(() => {
		const attempt = failed.current;
		if (!attempt || inflight.current) return undefined;
		return send({ ...attempt, controller: new AbortController() });
	}, [send]);
	return {
		/** 用户刚选、尚未被投影确认的值；回滚或未选择时为 undefined。 */
		desired,
		phase,
		/** 不可重试拒绝的原因，显示在工具栏旁。 */
		failure,
		/** 本会话内至少成功保存过一次：用于 sr-only 的成功状态。 */
		saved,
		choose,
		retry,
	};
}

function newAttempt(value: ModelSelectionValue): Attempt {
	return { key: crypto.randomUUID(), value, controller: new AbortController() };
}
