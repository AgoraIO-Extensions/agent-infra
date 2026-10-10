import { createFileRoute } from "@tanstack/react-router";
import { AdministratorAccess } from "../administrator-access";

import { AdministratorsPage } from "../pages/administrators-page";

export const Route = createFileRoute("/connection/admin/administrators")({
	component: () => (
		<AdministratorAccess>
			<AdministratorsPage />
		</AdministratorAccess>
	),
});
