import { createFileRoute } from "@tanstack/react-router";
import { AdministratorAccess } from "../administrator-access";

import { SharedConnectionsPage } from "../pages/shared-connections-page";

export const Route = createFileRoute("/connection/admin/shared-connections")({
	component: () => (
		<AdministratorAccess>
			<SharedConnectionsPage />
		</AdministratorAccess>
	),
});
