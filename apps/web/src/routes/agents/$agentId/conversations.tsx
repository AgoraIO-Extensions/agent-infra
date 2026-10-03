import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agents/$agentId/conversations")({
	validateSearch: (
		search: Record<string, unknown>,
	): { conversation?: string; view?: "history" } => ({
		view: search.view === "history" ? "history" : undefined,
		conversation:
			typeof search.conversation === "string" &&
			search.conversation.length <= 256
				? search.conversation
				: undefined,
	}),
	beforeLoad: ({ params, search }) => {
		throw redirect({
			to: "/chat/$agentId/{-$conversationId}",
			params: {
				agentId: params.agentId,
				conversationId: search.conversation,
			},
			search: { view: search.view },
			replace: true,
		});
	},
});
