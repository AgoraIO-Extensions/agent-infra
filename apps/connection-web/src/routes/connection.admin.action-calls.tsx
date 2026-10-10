import { createFileRoute } from "@tanstack/react-router";
import { AdministratorAccess } from "../administrator-access";
import { ActionCallsPage } from "../pages/action-calls-page";

export const Route = createFileRoute("/connection/admin/action-calls")({
	component: () => (
		<AdministratorAccess>
			<ActionCallsPage />
		</AdministratorAccess>
	),
});
