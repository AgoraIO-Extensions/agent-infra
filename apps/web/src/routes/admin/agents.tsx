import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "../../components/ui/button.js";
import { AdminAgentManagementScreen } from "../../features/agent-administration/admin-agent-management-screen.js";
import { useApplicationSession } from "../../features/application-shell.js";

export const Route = createFileRoute("/admin/agents")({
	component: AdminAgentsRoute,
});

function AdminAgentsRoute() {
	const session = useApplicationSession();
	const isAdmin = session.session.user.roles.includes("system_admin");
	if (!isAdmin) {
		return (
			<main className="platform-content management-content">
				<section
					className="space-y-4"
					aria-labelledby="admin-agents-denied-heading"
				>
					<h1
						id="admin-agents-denied-heading"
						className="font-semibold text-[28px]"
					>
						无权访问 Agent 管理
					</h1>
					<p className="text-muted-foreground">
						当前身份不能执行系统级 Agent 操作。
					</p>
					<Link
						className={buttonVariants({ variant: "link", className: "px-0" })}
						to="/"
					>
						返回工作台
					</Link>
				</section>
			</main>
		);
	}
	return (
		<main className="platform-content management-content ia-admin-agents">
			<AdminAgentManagementScreen state={{ kind: "contract-pending" }} />
		</main>
	);
}
