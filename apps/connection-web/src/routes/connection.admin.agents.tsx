import { createFileRoute } from "@tanstack/react-router";
import { AdministratorAccess } from "../administrator-access";

import { PatConsumersPage } from "../pages/pat-consumers-page";

export const Route = createFileRoute("/connection/admin/agents")({
	component: () => (
		<AdministratorAccess>
			<PatConsumersPage />
		</AdministratorAccess>
	),
});
