import { Link } from "@tanstack/react-router";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentAvailabilityStatus } from "../agent-management-status.js";
import { formatPerson } from "../directory-names.js";
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
	// 设计 tag-row：一个可用性 chip（与 Agent 目录、详情同一派生规则）加一个「Owner · 名称」tag。
	const availability = agentAvailabilityStatus(agent);
	const owners = agent.configuration.owners
		.map((owner) => formatPerson({ displayName: owner.displayName }).name)
		.join("、");
	return (
		<>
			<header className="page-heading">
				<div>
					{/* 站内导航用路由 Link，不整页刷新；exact 避免前缀匹配把返回链接标成当前页。 */}
					<Link
						className={buttonVariants({ variant: "ghost", size: "sm" })}
						to="/agents/$agentId"
						params={{ agentId: agent.agentId }}
						activeOptions={{ exact: true }}
					>
						<ArrowLeft aria-hidden="true" />
						返回 Agent 详情
					</Link>
					<p className="page-eyebrow">Owner 配置 · {agent.name}</p>
					<h1 id={configurationHeadingId} tabIndex={-1}>
						配置 Agent 的 Owner、范围和运行方式。
					</h1>
					{/* 设计原文；与 Secret 分区「等待 Worker 激活」的用语一致（O-12）。 */}
					<p>保存后由 Worker 更新实例；Secret 只显示状态和版本。</p>
				</div>
				<div className="tag-row">
					<Badge variant="chip" tone={availability.tone}>
						{availability.label}
					</Badge>
					{owners ? <Badge variant="tag">Owner · {owners}</Badge> : null}
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
