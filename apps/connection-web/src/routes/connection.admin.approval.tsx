import { createFileRoute } from "@tanstack/react-router";
import { AdministratorAccess } from "../administrator-access";

import { ApprovalPoliciesPage } from "../pages/approval-policies-page";

export const Route = createFileRoute("/connection/admin/approval")({
	component: () => (
		<AdministratorAccess>
			<ApprovalPoliciesPage />
		</AdministratorAccess>
	),
});
