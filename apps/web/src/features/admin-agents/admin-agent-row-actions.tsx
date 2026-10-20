import { Link } from "@tanstack/react-router";
import { Ban, RefreshCw, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { withObjectName } from "@/lib/accessible-name";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	commandProgressLabels,
	confirmationCopy,
} from "../agent-administration/agent-lifecycle-commands.js";
import { useAgentLifecycleCommand } from "../agent-administration/use-agent-lifecycle-command.js";

type RequestError = Error & { readonly retryable?: boolean };
type RowLifecycle = ReturnType<typeof useAgentLifecycleCommand>;

export type AdminAgentRowActionsProps = {
	agent: AgentProjectionV2;
	/** 重试创建已被服务端受理：页面负责提示并重新读取列表。 */
	onRetryAccepted: (agent: AgentProjectionV2) => void;
	/** 停用已被服务端受理：页面负责提示、重新读取列表并安置焦点（该行随后不再有操作）。 */
	onDisableAccepted: (agent: AgentProjectionV2) => void;
	/** 行操作未能提交：页面在表格上方给出唯一的失败提示。 */
	onActionFailed: (agent: AgentProjectionV2, error: RequestError) => void;
	/** 开始一次新的行操作前清除上一条失败提示。 */
	onActionStart: () => void;
};

/** 服务端允许管理员停用的管理状态（PRD §6.3）；已停用的 Agent 没有该入口。 */
const disableableStatuses: readonly AgentProjectionV2["managementStatus"][] = [
	"creating",
	"available",
	"stopped",
	"creation_failed",
];

/**
 * Agent 管理表格「操作」列（设计 .tag-row，gap 6px），按顺序排列：
 * 1. ghost「配置」：进入该 Agent 的配置页；已停用的 Agent 没有该入口。管理员不在使用范围内时
 *    配置页改读服务端管理员投影（#3033）。
 * 2. outline「重试」：只在创建失败时出现，直接提交 retry_creation。
 * 3. outline「停用」（管理员停用 Agent，N-01、#3033）：不依赖管理员个人使用范围，确认后提交
 *    disable；可访问名称为 withObjectName(可见文字, agent.name)，不另起一列。
 * 同一行共用一个生命周期 mutation：任一命令进行中时其余命令禁用。服务端对每条命令重新鉴权。
 * 已停用且没有任何操作时显示「—」。
 */
export function AdminAgentRowActions({
	agent,
	onRetryAccepted,
	onDisableAccepted,
	onActionFailed,
	onActionStart,
}: AdminAgentRowActionsProps) {
	const configure = useRef<HTMLAnchorElement>(null);
	const lifecycle = useAgentLifecycleCommand(agent.agentId);
	const configurable = agent.managementStatus !== "disabled";
	const retryable = agent.managementStatus === "creation_failed";
	const disableable = disableableStatuses.includes(agent.managementStatus);
	// 列表重新读取后行数据变化时重置本地受理状态。
	const rowKey = `${agent.agentId}:${agent.managementStatus}`;
	if (!configurable && !retryable && !disableable)
		return <span aria-hidden="true">—</span>;
	return (
		<div className="tag-row admin-agent-row-actions">
			{configurable ? (
				<Link
					ref={configure}
					className={buttonVariants({ variant: "ghost" })}
					params={{ agentId: agent.agentId }}
					to="/agents/$agentId/configuration"
					aria-label={withObjectName("配置", agent.name)}
				>
					<Settings aria-hidden="true" />
					配置
				</Link>
			) : null}
			{retryable ? (
				<RetryCreationButton
					key={`retry:${rowKey}`}
					agent={agent}
					lifecycle={lifecycle}
					onStart={onActionStart}
					onAccepted={() => {
						// 「重试」随后消失，焦点先交给同行稳定存在的「配置」。
						configure.current?.focus();
						onRetryAccepted(agent);
					}}
					onFailed={(error) => onActionFailed(agent, error)}
				/>
			) : null}
			{disableable ? (
				<DisableAgentButton
					key={`disable:${rowKey}`}
					agent={agent}
					lifecycle={lifecycle}
					onStart={onActionStart}
					onAccepted={() => onDisableAccepted(agent)}
					onFailed={(error) => onActionFailed(agent, error)}
				/>
			) : null}
		</div>
	);
}

/** 提交中按钮被禁用会失去焦点：失败后等按钮重新可用的那次提交再交还焦点。 */
function useRefocusAfterFailure(submitting: boolean) {
	const button = useRef<HTMLButtonElement>(null);
	const [refocus, setRefocus] = useState(false);
	// 不依赖 requestAnimationFrame 与 React 提交的先后（高负载下 rAF 可能先于提交执行）。
	useEffect(() => {
		if (!refocus || submitting) return;
		setRefocus(false);
		button.current?.focus();
	}, [refocus, submitting]);
	return { button, refocus: () => setRefocus(true) };
}

function RetryCreationButton({
	agent,
	lifecycle,
	onStart,
	onAccepted,
	onFailed,
}: {
	agent: AgentProjectionV2;
	lifecycle: RowLifecycle;
	onStart: () => void;
	onAccepted: () => void;
	onFailed: (error: RequestError) => void;
}) {
	const [submitting, setSubmitting] = useState(false);
	const [accepted, setAccepted] = useState(false);
	const { button, refocus } = useRefocusAfterFailure(submitting);
	if (accepted) return null;
	const label = submitting ? "重试中…" : "重试";
	return (
		<Button
			ref={button}
			variant="outline"
			disabled={submitting || lifecycle.isPending}
			aria-label={withObjectName(label, agent.name)}
			onClick={() => {
				if (submitting || lifecycle.isPending) return;
				onStart();
				setSubmitting(true);
				lifecycle.mutateAsync("retry_creation").then(
					() => {
						setSubmitting(false);
						setAccepted(true);
						onAccepted();
					},
					(error: RequestError) => {
						setSubmitting(false);
						// 失败后把焦点交还给「重试」以便再次提交。
						refocus();
						onFailed(error);
					},
				);
			}}
		>
			<RefreshCw aria-hidden="true" />
			{label}
		</Button>
	);
}

function DisableAgentButton({
	agent,
	lifecycle,
	onStart,
	onAccepted,
	onFailed,
}: {
	agent: AgentProjectionV2;
	lifecycle: RowLifecycle;
	onStart: () => void;
	onAccepted: () => void;
	onFailed: (error: RequestError) => void;
}) {
	const [submitting, setSubmitting] = useState(false);
	const [accepted, setAccepted] = useState(false);
	const { button, refocus } = useRefocusAfterFailure(submitting);
	if (accepted) return null;
	const copy = confirmationCopy.disable;
	// 行内与「配置」「重试」同为短动词，操作列放得下；确认弹窗仍写明「停用 Agent？」。
	const label = submitting ? commandProgressLabels.disable : "停用";
	return (
		<ConfirmDialog
			disabled={submitting || lifecycle.isPending}
			trigger={
				// 与配置页管理员区相同：outline + Ban 图标，与 Owner 的「停止」区分（N-01）。
				<Button
					ref={button}
					variant="outline"
					aria-label={withObjectName(label, agent.name)}
				>
					<Ban aria-hidden="true" />
					{label}
				</Button>
			}
			title={copy.title()}
			subject={{ name: agent.name }}
			description={copy.description}
			confirmLabel={copy.confirm}
			tone="danger"
			onConfirm={() => {
				if (submitting || lifecycle.isPending) return;
				onStart();
				setSubmitting(true);
				lifecycle.mutateAsync("disable").then(
					() => {
						setSubmitting(false);
						setAccepted(true);
						onAccepted();
					},
					(error: RequestError) => {
						setSubmitting(false);
						// 失败后把焦点交还给「停用」以便再次提交。
						refocus();
						onFailed(error);
					},
				);
			}}
		/>
	);
}
