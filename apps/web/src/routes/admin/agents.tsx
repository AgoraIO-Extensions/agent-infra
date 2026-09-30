import { createFileRoute } from "@tanstack/react-router";
import {
	AdminAgentsScreen,
	validateAdminAgentSearch,
} from "../../features/admin-agents/admin-agents-screen.js";
import { useAdminAgents } from "../../features/admin-agents/use-admin-agents.js";
import { useApplicationSession } from "../../features/application-shell.js";

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
				refreshing={query.isFetching}
			/>
		</main>
	);
}
