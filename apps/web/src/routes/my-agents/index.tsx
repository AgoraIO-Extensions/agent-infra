import { createFileRoute } from "@tanstack/react-router";
import { isRetryableAgentDiscoveryError } from "../../features/agent-discovery/agent-discovery.js";
import { useAgentDiscovery } from "../../features/agent-discovery/use-agent-discovery.js";
import { useApplicationSession } from "../../features/application-shell.js";
import { isRetryableMyAgentApplicationError } from "../../features/my-agents/my-agent-applications.js";
import { MyAgentsScreen } from "../../features/my-agents/my-agents-screen.js";
import { useMyAgentApplications } from "../../features/my-agents/use-my-agent-applications.js";

export const Route = createFileRoute("/my-agents/")({
	// 只认「已创建」一个值；默认的「申请」不写参数，其他值一律忽略。
	validateSearch: (search: Record<string, unknown>): { tab?: "owned" } => ({
		tab: search.tab === "owned" ? "owned" : undefined,
	}),
	component: MyAgentsRoute,
});

function MyAgentsRoute() {
	const { tab } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { identityKey } = useApplicationSession();
	const query = useMyAgentApplications({ identityKey });
	const owned = useAgentDiscovery({ identityKey, scope: "owner" });
	const applicationsRetryable = query.isError
		? isRetryableMyAgentApplicationError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;
	const ownedAgentsRetryable = owned.isError
		? isRetryableAgentDiscoveryError(owned.error)
		: owned.data?.kind === "unavailable" && owned.data.retryable;

	return (
		<main className="platform-content management-content">
			<MyAgentsScreen
				tab={tab === "owned" ? "owned" : "applications"}
				onTabChange={(next) => {
					void navigate({
						search: { tab: next === "owned" ? "owned" : undefined },
						replace: true,
						resetScroll: false,
					});
				}}
				ownedAgents={
					owned.data?.kind === "ready" ? owned.data.agents : undefined
				}
				ownedAgentsLoading={owned.isPending}
				ownedAgentsUnavailable={
					owned.isError || owned.data?.kind === "unavailable"
				}
				ownedAgentsRetryable={ownedAgentsRetryable}
				onRetryApplications={() => void query.refetch()}
				onRetryOwnedAgents={() => void owned.refetch()}
				retryingApplications={query.isFetching}
				retryingOwnedAgents={owned.isFetching}
				state={
					query.isPending
						? { kind: "loading" }
						: query.isError || !query.data
							? { kind: "unavailable", retryable: applicationsRetryable }
							: query.data
				}
			/>
		</main>
	);
}
