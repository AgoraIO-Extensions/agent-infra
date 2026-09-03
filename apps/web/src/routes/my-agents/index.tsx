import { createFileRoute } from "@tanstack/react-router";

import { MyAgentsScreen } from "../../features/my-agents/my-agents-screen.js";
import { useMyAgentApplications } from "../../features/my-agents/use-my-agent-applications.js";

export const Route = createFileRoute("/my-agents/")({
	component: MyAgentsRoute,
});

function MyAgentsRoute() {
	const query = useMyAgentApplications();

	return (
		<main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
			<MyAgentsScreen
				state={
					query.isPending
						? { kind: "loading" }
						: query.isError || !query.data
							? { kind: "unavailable", retryable: true }
							: query.data
				}
			/>
		</main>
	);
}
