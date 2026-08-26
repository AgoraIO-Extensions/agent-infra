import { createFileRoute } from "@tanstack/react-router";

import { SharedConnectionsPage } from "../pages/shared-connections-page";

export const Route = createFileRoute("/connection/admin/shared-connections")({
	component: SharedConnectionsPage,
});
