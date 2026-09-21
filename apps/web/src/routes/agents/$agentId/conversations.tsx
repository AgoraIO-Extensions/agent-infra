import { createFileRoute } from "@tanstack/react-router";
import { useBrowserSession } from "../../../features/agent-administration/use-browser-session.js";
import { useApplicationSession } from "../../../features/application-shell.js";
import { ConversationScreen } from "../../../features/conversation/conversation-screen.js";

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
	component: ConversationRoute,
});

function ConversationRoute() {
	const { agentId } = Route.useParams();
	const { conversation, view } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { identityKey } = useApplicationSession();
	const session = useBrowserSession();
	return (
		<main className="platform-content chat-content">
			<ConversationScreen
				key={`${identityKey}:${agentId}`}
				agentId={agentId}
				conversationId={conversation}
				identityKey={identityKey}
				view={view ?? "conversation"}
				onViewChange={(next) => {
					void navigate({
						search: {
							conversation,
							view: next === "history" ? "history" : undefined,
						},
					});
				}}
				onAccessDenied={() => {
					void session.refetch();
				}}
				onConversationChange={(next) => {
					void navigate({ search: { conversation: next, view: undefined } });
				}}
			/>
		</main>
	);
}
