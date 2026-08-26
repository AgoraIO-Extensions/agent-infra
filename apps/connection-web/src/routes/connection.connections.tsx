import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsPage } from "../pages/connections-page";

export const Route = createFileRoute("/connection/connections")({
	component: ConnectionsPage,
});
