import { createFileRoute } from "@tanstack/react-router";
import { AuditWorkflow } from "../../features/audit/audit-workflow.js";

export const Route = createFileRoute("/admin/audit")({ component: AuditRoute });
function AuditRoute() {
	return (
		<main className="platform-content management-content">
			<AuditWorkflow scope="administrator" />
		</main>
	);
}
