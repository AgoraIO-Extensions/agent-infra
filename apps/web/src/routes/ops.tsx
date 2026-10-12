import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../features/application-shell.js";
import { OperationsEntry } from "../features/operations/operations-entry.js";

export const Route = createFileRoute("/ops")({
	component: OperationsRoute,
});

function OperationsRoute() {
	const { session } = useApplicationSession();
	return (
		<main className="platform-content management-content">
			<OperationsEntry
				isAdministrator={session.user.roles.includes("system_admin")}
			/>
		</main>
	);
}
