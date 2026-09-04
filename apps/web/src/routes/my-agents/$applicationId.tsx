import { createFileRoute } from "@tanstack/react-router";

import { MyAgentApplicationDetailScreen } from "../../features/my-agents/my-agent-application-detail-screen.js";
import { useMyAgentApplication } from "../../features/my-agents/use-my-agent-application.js";
import { useWithdrawMyAgentApplication } from "../../features/my-agents/use-withdraw-my-agent-application.js";

export const Route = createFileRoute("/my-agents/$applicationId")({
	component: MyAgentApplicationRoute,
});

function MyAgentApplicationRoute() {
	const { applicationId } = Route.useParams();
	const query = useMyAgentApplication(applicationId);
	const withdrawal = useWithdrawMyAgentApplication(applicationId);

	return (
		<main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
			<MyAgentApplicationDetailScreen
				onWithdraw={() => withdrawal.mutate()}
				state={
					query.isPending
						? { kind: "loading" }
						: query.isError || !query.data
							? { kind: "unavailable", retryable: true }
							: query.data
				}
				withdrawalError={withdrawal.isError}
				withdrawing={withdrawal.isPending}
			/>
		</main>
	);
}
