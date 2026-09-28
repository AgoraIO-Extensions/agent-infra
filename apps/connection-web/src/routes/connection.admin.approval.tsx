import { createFileRoute } from "@tanstack/react-router";

import { ApprovalCatalogPrototype } from "../pages/approval-catalog.prototype";
import { ApprovalPoliciesPage } from "../pages/approval-policies-page";

export const Route = createFileRoute("/connection/admin/approval")({
	component: () =>
		import.meta.env.DEV &&
		new URLSearchParams(location.search).has("variant") ? (
			<ApprovalCatalogPrototype />
		) : (
			<ApprovalPoliciesPage />
		),
});
