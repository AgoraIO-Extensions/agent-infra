import { createFileRoute } from "@tanstack/react-router";

import { AdministratorsPage } from "../pages/administrators-page";

export const Route = createFileRoute("/connection/admin/administrators")({
	component: AdministratorsPage,
});
