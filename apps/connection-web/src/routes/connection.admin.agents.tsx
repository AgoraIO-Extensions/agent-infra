import { createFileRoute } from "@tanstack/react-router";

import { PatConsumersPage } from "../pages/pat-consumers-page";

export const Route = createFileRoute("/connection/admin/agents")({
	component: PatConsumersPage,
});
