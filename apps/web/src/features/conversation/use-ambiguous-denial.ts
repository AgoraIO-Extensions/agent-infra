import { useEffect, useRef, useState } from "react";
import type { ConversationCommandResult } from "./conversation-commands.js";

/**
 * 命令得到的 404 同时表示「失去访问权限」与「Agent 已停止 / 不可用」，服务端有意不区分（#2570）。
 * 页面先重新读取 Agent：
 * - verifying：复核进行中，命令反馈区只显示中性的「正在确认 Agent 状态…」（NW-13）；
 * - unavailable：Agent 确实不可用，只保留页顶一处不可用提示，命令区不重复（NW-12、NW-13）；
 * - recovered：之后 Agent 恢复可用，消息命令显示「消息未送达」与「重新发送」（G-04）。
 * 复核结果为 Agent 仍可用时调用 onDenialStands，由页面按失去访问权限处理。
 */
export type AmbiguousDenialPhase = "verifying" | "unavailable" | "recovered";

export function useAmbiguousDenial({
	result,
	available,
	verifyAgent,
	onDenialStands,
}: {
	result: ConversationCommandResult | undefined;
	/** 页面当前读到的 Agent 是否可用（管理状态可用且服务就绪）。 */
	available: boolean;
	/** 重新读取 Agent；true 表示 Agent 仍然可用，404 就是失去访问权限。 */
	verifyAgent: () => Promise<boolean>;
	onDenialStands: () => void;
}): AmbiguousDenialPhase | undefined {
	const ambiguous =
		result?.kind === "denied" && result.ambiguous === true ? result : undefined;
	const [state, setState] = useState<{
		result: ConversationCommandResult;
		phase: "unavailable" | "recovered";
	}>();
	useEffect(() => {
		if (!ambiguous) return;
		let current = true;
		void verifyAgent().then((denialStands) => {
			if (!current) return;
			if (denialStands) onDenialStands();
			else setState({ result: ambiguous, phase: "unavailable" });
		});
		return () => {
			current = false;
		};
	}, [ambiguous, verifyAgent, onDenialStands]);
	const settled = state && state.result === ambiguous ? state : undefined;
	// 复核读到的 Agent 不可用；要先在页面上看到不可用、再看到恢复，才进入 recovered，
	// 避免复核结果先于 Agent 投影更新时闪现「重新发送」。
	const sawUnavailable = useRef(false);
	useEffect(() => {
		if (settled?.phase !== "unavailable") {
			sawUnavailable.current = false;
			return;
		}
		if (!available) sawUnavailable.current = true;
		else if (sawUnavailable.current)
			setState({ result: settled.result, phase: "recovered" });
	}, [settled, available]);
	if (!ambiguous) return undefined;
	return settled?.phase ?? "verifying";
}
