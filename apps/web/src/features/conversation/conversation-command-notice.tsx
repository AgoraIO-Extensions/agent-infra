import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import type { ConversationCommandResult } from "./conversation-commands.js";
import { commandFailure } from "./conversation-screen-state.js";
import type { AmbiguousDenialPhase } from "./use-ambiguous-denial.js";

/**
 * 命令反馈区：位于 composer 上方、任何折叠条之外，默认可见（NI-83）。
 * 受理之后的处理状态由对应回复卡接替，这里只说明提交本身的结果。
 */
export function CommandNotice({
	result,
	pending,
	retry,
	kind = "message",
	denial,
	unknownId,
	onResend,
	resendDisabled = false,
}: {
	result?: ConversationCommandResult;
	pending: boolean;
	retry?: () => void;
	/** 命令类型：创建会话遇 404 不使用「消息未送达 / 草稿已保留」类文案（NW-12）。 */
	kind?: "message" | "create";
	/** 404 复核阶段，见 useAmbiguousDenial。 */
	denial?: AmbiguousDenialPhase;
	/** 「提交结果尚未确认」说明的 id，供被禁用的输入框 aria-describedby 引用。 */
	unknownId?: string;
	/** Agent 恢复可用后，以当前草稿发起新的消息命令（G-04）。 */
	onResend?: () => void;
	resendDisabled?: boolean;
}) {
	if (pending) return <p role="status">正在提交，请勿重复操作…</p>;
	if (result?.kind === "unknown")
		return (
			<Alert role="alert" tone="warn">
				<AlertDescription id={unknownId}>
					提交结果尚未确认。原请求可能已受理，请核实原请求，避免重复创建回复。
				</AlertDescription>
				{retry && (
					<Button variant="outline" onClick={retry}>
						核实原请求
					</Button>
				)}
			</Alert>
		);
	if (result?.kind === "denied" && result.ambiguous) {
		if (denial === "verifying")
			return <p role="status">正在确认 Agent 状态…</p>;
		// 确认不可用期间只保留页顶一处提示；创建会话恢复后直接可以重新创建。
		if (denial !== "recovered" || kind === "create") return null;
		return (
			<Alert role="status" tone="warn" className="command-not-delivered">
				<AlertTitle>消息未送达</AlertTitle>
				<AlertDescription>
					消息没有送到 Agent，原文仍保留在输入框。Agent
					已恢复可用，可以重新发送。
				</AlertDescription>
				{onResend && (
					<Button
						variant="outline"
						disabled={resendDisabled}
						onClick={onResend}
					>
						重新发送
					</Button>
				)}
			</Alert>
		);
	}
	// 命令 / Skill 被拒绝的原因只在 composer 内显示一次（CK-02），这里不重复。
	if (result?.kind === "rejected")
		return (
			<Alert role="alert" tone="danger">
				<AlertDescription>{commandFailure(result.code)}</AlertDescription>
				{retry && (
					<Button variant="outline" onClick={retry}>
						重试原请求
					</Button>
				)}
			</Alert>
		);
	return null;
}
