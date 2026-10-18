import { Link } from "@tanstack/react-router";
import { RefreshCw, Settings } from "lucide-react";
import { useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { withObjectName } from "@/lib/accessible-name";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { useAgentLifecycleCommand } from "../agent-administration/use-agent-lifecycle-command.js";

type RequestError = Error & { readonly retryable?: boolean };

export type AdminAgentRowActionsProps = {
	agent: AgentProjectionV2;
	/** 重试创建已被服务端受理：页面负责提示并重新读取列表。 */
	onRetryAccepted: (agent: AgentProjectionV2) => void;
	/** 重试创建未能提交：页面在表格上方给出唯一的失败提示。 */
	onRetryFailed: (agent: AgentProjectionV2, error: RequestError) => void;
	/** 开始一次新的行操作前清除上一条失败提示。 */
	onActionStart: () => void;
};

/**
 * Agent 管理表格「操作」列（设计 .tag-row，gap 6px），按顺序排列：
 * 1. ghost「配置」：进入该 Agent 的 Owner 配置页；已停用的 Agent 没有该入口。
 * 2. outline「重试」：只在创建失败时出现，直接提交 retry_creation。
 * 3. 预留：管理员「停用 Agent」（N-01，由 Owner 配置流迁入）作为最后一项追加在
 *    `admin-agent-row-actions` 容器内，使用 ConfirmDialog，可访问名称同样用
 *    withObjectName(可见文字, agent.name)，不要另起一列。
 * 已停用且没有任何操作时显示「—」。
 */
export function AdminAgentRowActions({
	agent,
	onRetryAccepted,
	onRetryFailed,
	onActionStart,
}: AdminAgentRowActionsProps) {
	const configure = useRef<HTMLAnchorElement>(null);
	const configurable = agent.managementStatus !== "disabled";
	const retryable = agent.managementStatus === "creation_failed";
	if (!configurable && !retryable) return <span aria-hidden="true">—</span>;
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
					// 列表重新读取后行数据变化时重置本地受理状态。
					key={`${agent.agentId}:${agent.managementStatus}`}
					agent={agent}
					onStart={onActionStart}
					onAccepted={() => {
						// 「重试」随后消失，焦点先交给同行稳定存在的「配置」。
						configure.current?.focus();
						onRetryAccepted(agent);
					}}
					onFailed={(error) => onRetryFailed(agent, error)}
				/>
			) : null}
		</div>
	);
}

function RetryCreationButton({
	agent,
	onStart,
	onAccepted,
	onFailed,
}: {
	agent: AgentProjectionV2;
	onStart: () => void;
	onAccepted: () => void;
	onFailed: (error: RequestError) => void;
}) {
	const lifecycle = useAgentLifecycleCommand(agent.agentId);
	const button = useRef<HTMLButtonElement>(null);
	const [submitting, setSubmitting] = useState(false);
	const [accepted, setAccepted] = useState(false);
	if (accepted) return null;
	const label = submitting ? "重试中…" : "重试";
	return (
		<Button
			ref={button}
			variant="outline"
			disabled={submitting}
			aria-label={withObjectName(label, agent.name)}
			onClick={() => {
				if (submitting) return;
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
						onFailed(error);
						// 提交中按钮被禁用会失去焦点，失败后交还给「重试」以便再次提交。
						requestAnimationFrame(() => button.current?.focus());
					},
				);
			}}
		>
			<RefreshCw aria-hidden="true" />
			{label}
		</Button>
	);
}
