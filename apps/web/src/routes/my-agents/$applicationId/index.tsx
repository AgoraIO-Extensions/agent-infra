import { createFileRoute } from "@tanstack/react-router";

import { MyAgentApplicationDetailScreen } from "../../../features/my-agents/my-agent-application-detail-screen.js";
import { isRetryableMyAgentApplicationError } from "../../../features/my-agents/my-agent-applications.js";
import { useMyAgentApplication } from "../../../features/my-agents/use-my-agent-application.js";
import { useWithdrawMyAgentApplication } from "../../../features/my-agents/use-withdraw-my-agent-application.js";

export const Route = createFileRoute("/my-agents/$applicationId/")({
	component: MyAgentApplicationRoute,
});

function MyAgentApplicationRoute() {
	const { applicationId } = Route.useParams();
	const query = useMyAgentApplication(applicationId);
	const withdrawal = useWithdrawMyAgentApplication(applicationId);
	const retryable =
		(query.isError && isRetryableMyAgentApplicationError(query.error)) ||
		(query.data?.kind === "unavailable" && query.data.retryable) ||
		false;

	return (
		<main className="platform-content management-content">
			<MyAgentApplicationDetailScreen
				onRetry={() => void query.refetch()}
				onWithdraw={() => withdrawal.mutate()}
				retrying={query.isFetching}
				state={
					query.isPending
						? { kind: "loading" }
						: query.isError || !query.data
							? { kind: "unavailable", retryable }
							: query.data
				}
				withdrawalError={withdrawal.isError}
				withdrawalResult={withdrawal.data}
				withdrawing={withdrawal.isPending}
			/>
		</main>
	);
}
