import { createFileRoute } from "@tanstack/react-router";
import {
	AdminAgentsScreen,
	validateAdminAgentSearch,
} from "../../features/admin-agents/admin-agents-screen.js";
import { useAdminAgents } from "../../features/admin-agents/use-admin-agents.js";
import { useApplicationSession } from "../../features/application-shell.js";
import { useSessionRecheck } from "../../features/session-recheck.js";
import { useTemplateNameLookup } from "../../features/template-display-name.js";

export const Route = createFileRoute("/admin/agents")({
	validateSearch: validateAdminAgentSearch,
	component: AdminAgentsRoute,
});

function AdminAgentsRoute() {
	const { identityKey, session } = useApplicationSession();
	const filters = Route.useSearch();
	const navigate = Route.useNavigate();
	const query = useAdminAgents({
		identityKey,
		enabled: session.user.roles.includes("system_admin"),
	});
	const templateName = useTemplateNameLookup();
	// 列表读取 401 时经壳层重新确认会话；仍有效则解除锁定、重读一次列表（W-03，#3292 N9-3-04）。
	const relogin = useSessionRecheck(() => void query.reload());
	return (
		<main className="platform-content management-content ia-admin-agents">
			<AdminAgentsScreen
				state={query.state}
				filters={filters}
				onFiltersChange={(search) => {
					void navigate({ search, replace: true, resetScroll: false });
				}}
				onRefresh={() => {
					void query.refetch();
				}}
				onRelogin={() => void relogin.recheck()}
				refreshing={query.isFetching || relogin.checking}
				templateName={templateName}
			/>
		</main>
	);
}
