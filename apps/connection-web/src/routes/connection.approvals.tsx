import { createFileRoute } from "@tanstack/react-router";

import { ApprovalQueuePage } from "../pages/approval-queue-page";

export const Route = createFileRoute("/connection/approvals")({
	component: ApprovalQueuePage,
});
