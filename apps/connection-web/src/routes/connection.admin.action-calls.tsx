import { createFileRoute } from "@tanstack/react-router";
import { ActionCallsPage } from "../pages/action-calls-page";

export const Route = createFileRoute("/connection/admin/action-calls")({
	component: ActionCallsPage,
});
