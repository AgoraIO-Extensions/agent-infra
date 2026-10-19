import { Link } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { ConfigurationHeadSection } from "./configuration-section-head.js";

/**
 * Owner 配置「Skill」分区（O-02）：版本绑定、同步与对话可用性在 Agent 的 Skill 页单独管理，
 * 这里只给入口（路由 Link，不整页刷新）。
 */
export function ConfigurationSkillSection({ agentId }: { agentId: string }) {
	return (
		<ConfigurationHeadSection
			data-od-id="owner-skill-entry"
			title="Skill"
			description="Skill 版本、同步和对话可用性分开管理。"
			aside={
				<Link
					className={buttonVariants({ variant: "outline" })}
					to="/agents/$agentId/skills"
					params={{ agentId }}
				>
					<Layers aria-hidden="true" data-icon="inline-start" />
					管理 Skill 绑定
				</Link>
			}
		/>
	);
}
