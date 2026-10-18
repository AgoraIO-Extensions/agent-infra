import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { statusTone } from "@/lib/status-tone";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	agentManagementStatusLabels,
	agentServiceAvailabilityLabel,
} from "../agent-management-status.js";
import { configurationHeadingId } from "./configuration-lifecycle.js";

/**
 * Owner 配置页头与权限边界说明；Owner 与纯管理员视图共用（O-05、O-12、N-02）。
 * h1 可被程序聚焦，作为操作区卸载后的焦点落点。
 */
export function ConfigurationPageHeading({
	agent,
}: {
	agent: AgentProjectionV2;
}) {
	return (
		<>
			<header className="page-heading">
				<div>
					<a
						className={buttonVariants({ variant: "ghost", size: "sm" })}
						href={`/agents/${encodeURIComponent(agent.agentId)}`}
					>
						<ArrowLeft aria-hidden="true" />
						返回 Agent 详情
					</a>
					<p className="page-eyebrow">Owner 配置 · {agent.name}</p>
					<h1 id={configurationHeadingId} tabIndex={-1}>
						配置 Agent 的 Owner、范围和运行方式。
					</h1>
					{/* 设计稿写「由 Worker 更新实例」；产品界面不展示运行时组件名，按 PRD 去掉 Worker。 */}
					<p>保存后更新运行实例；Secret 只显示状态和版本。</p>
				</div>
				<div className="tag-row">
					<Badge tone={statusTone(agent.managementStatus)}>
						{agentManagementStatusLabels[agent.managementStatus]}
					</Badge>
					{agent.serviceAvailability && (
						<Badge tone={statusTone(agent.serviceAvailability)}>
							{agentServiceAvailabilityLabel(agent.serviceAvailability)}
						</Badge>
					)}
				</div>
			</header>
			<div className="configuration-notices">
				{agent.managementStatus === "disabled" ? (
					<Alert tone="warn">
						<AlertTitle>已停用</AlertTitle>
						<AlertDescription>
							运行资格已撤销，Owner 无法恢复。
						</AlertDescription>
					</Alert>
				) : null}
				{/* 设计文案写「Owner 或系统管理员可以修改配置」；PRD §2.3 只允许管理员在 Owner 失效时交接 Owner，按 PRD 表述。 */}
				<Alert tone="info" icon={<ShieldCheck aria-hidden="true" />}>
					<AlertTitle>权限边界</AlertTitle>
					<AlertDescription>
						只有当前 Owner 可以修改配置；Owner 失效时由系统管理员代为交接
						Owner。Connection 授权由使用者自己完成。
					</AlertDescription>
				</Alert>
			</div>
		</>
	);
}
