import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../features/application-shell.js";
import { EvaluationWorkbench } from "../features/evaluation/evaluation-workbench.js";

export const Route = createFileRoute("/eval")({
	component: EvaluationRoute,
});

function EvaluationRoute() {
	const { session } = useApplicationSession();
	return (
		<main className="platform-content management-content">
			<EvaluationWorkbench
				userDisplayName={session.user.displayName}
				isAdministrator={session.user.roles.includes("system_admin")}
			/>
		</main>
	);
}
