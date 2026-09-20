import { createFileRoute, Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { AdminAgentApplicationsWorkflow } from "../../features/agent-administration/admin-agent-applications-workflow.js";
import { AgentLifecycleWorkflow } from "../../features/agent-administration/agent-lifecycle-workflow.js";
import { useAgentDiscovery } from "../../features/agent-discovery/use-agent-discovery.js";
import { useApplicationSession } from "../../features/application-shell.js";

export const Route = createFileRoute("/admin/approvals")({
	component: AdminApprovalsRoute,
});

function RunningQualification() {
	const agents = useAgentDiscovery();
	return (
		<section
			aria-labelledby="running-qualification-heading"
			className="mt-12 border-border border-t pt-8"
		>
			<h2 id="running-qualification-heading" className="font-semibold text-xl">
				运行资格
			</h2>
			<p className="mt-2 text-muted-foreground text-sm">
				检查当前有权管理的 Agent。停用会撤销运行资格，并停止新的执行。
			</p>
			{agents.isPending ? (
				<p role="status">正在读取 Agent…</p>
			) : agents.isError || agents.data?.kind !== "ready" ? (
				<div className="mt-4 space-y-3">
					<p role="alert">暂时无法读取运行资格。</p>
					<Button variant="outline" onClick={() => void agents.refetch()}>
						重新读取
					</Button>
				</div>
			) : agents.data.agents.length === 0 ? (
				<p className="mt-4 text-muted-foreground">暂无可管理的 Agent。</p>
			) : (
				<ul className="mt-4 divide-y divide-border">
					{agents.data.agents.map((agent) => (
						<li key={agent.agentId} className="py-6">
							<Link
								to="/agents/$agentId"
								params={{ agentId: agent.agentId }}
								className={buttonVariants({
									variant: "link",
									className: "px-0 font-semibold",
								})}
							>
								{agent.name}
							</Link>
							<AgentLifecycleWorkflow agent={agent} />
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function AdminApprovalsRoute() {
	const { session } = useApplicationSession();
	return (
		<main className="platform-content management-content">
			<AdminAgentApplicationsWorkflow />
			{session.user.roles.includes("system_admin") && <RunningQualification />}
		</main>
	);
}
