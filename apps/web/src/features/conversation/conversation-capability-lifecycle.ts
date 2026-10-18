import type { ConversationCapabilityV1 } from "./conversation-capability-picker.js";
import type { ExecutionStatus } from "./conversation-screen-state.js";

/** 一次已受理的命令 / Skill 调用：标题来自选择时的目录项，阶段只由该 Execution 的状态推导。 */
export type CapabilityInvocation = Readonly<{
	executionId: string;
	kind: ConversationCapabilityV1["kind"];
	name: string;
	source: string;
	version?: string;
}>;

export type CapabilityReceiptPhase =
	| "accepted"
	| "running"
	| "completed"
	| "failed"
	| "unknown"
	| "cancelled";

export const capabilityReceiptLabels: Record<CapabilityReceiptPhase, string> = {
	accepted: "已受理，尚未开始",
	running: "正在执行",
	completed: "已完成",
	failed: "调用失败",
	unknown: "结果待核实",
	cancelled: "已停止",
};

/** Execution 状态 → 回执阶段；尚未读到状态时视为刚受理。 */
export function capabilityReceiptPhase(
	status: ExecutionStatus | undefined,
): CapabilityReceiptPhase {
	switch (status) {
		case "processing":
			return "running";
		case "completed":
		case "failed":
		case "unknown":
		case "cancelled":
			return status;
		default:
			return "accepted";
	}
}

/** 受理、执行中与待核实期间禁止发送、Enter 提交与再次唤起（设计 capabilityBusy）。 */
export function capabilityReceiptBusy(phase: CapabilityReceiptPhase) {
	return phase === "accepted" || phase === "running" || phase === "unknown";
}

export function capabilityKindLabel(kind: ConversationCapabilityV1["kind"]) {
	return kind === "skill" ? "Skill" : "原生命令";
}

/** Skill 版本前加 v，命令版本原样显示。 */
export function capabilityVersionLabel(
	kind: ConversationCapabilityV1["kind"],
	version: string | undefined,
) {
	if (!version) return undefined;
	return kind === "skill" ? `v${version}` : version;
}

const notDowngraded = "内容没有降级为普通消息。";

/** 调用被拒绝时的可读原因；原始枚举不进入页面，统一说明没有降级为普通消息。 */
export function capabilityRejectionMessage(outcome: string, reason?: string) {
	const cause =
		reason === "authorization_lost" || outcome === "denied"
			? "当前账号已无权使用所选命令或 Skill，请重新选择。"
			: reason === "conversation_unavailable"
				? "当前会话不可用，历史保持只读。"
				: reason === "metadata_unavailable" || outcome === "unavailable"
					? "命令与 Skill 目录暂时不可用，请稍后重试。"
					: outcome === "stale"
						? "所选版本已变化，请重新选择。"
						: outcome === "busy" || outcome === "conflict"
							? "当前会话仍有任务在处理，请等它结束后再试。"
							: outcome === "disabled" || outcome === "unsupported"
								? "当前 Agent 没有启用所选命令或 Skill。"
								: outcome === "invalid_parameters"
									? "补充内容不符合所选项的要求，请调整后再发送。"
									: "所选命令或 Skill 未被受理，请稍后重试。";
	return `${cause}${notDowngraded}`;
}

export const capabilityFailedNotice = `所选版本加载失败。${notDowngraded}`;
