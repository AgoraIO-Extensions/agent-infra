import { createFileRoute } from "@tanstack/react-router";

import { ApprovalPoliciesPage } from "../pages/approval-policies-page";

export const Route = createFileRoute("/connection/admin/approval")({
	component: ApprovalPoliciesPage,
});
