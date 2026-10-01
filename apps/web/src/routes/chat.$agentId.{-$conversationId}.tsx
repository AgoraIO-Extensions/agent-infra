import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../features/application-shell.js";
import { ConversationScreen } from "../features/conversation/conversation-screen.js";
import { useBrowserSession } from "../features/use-browser-session.js";

export const Route = createFileRoute("/chat/$agentId/{-$conversationId}")({
	validateSearch: (search: Record<string, unknown>): { view?: "history" } => ({
		view: search.view === "history" ? "history" : undefined,
	}),
	component: ConversationRoute,
});

function ConversationRoute() {
	const { agentId, conversationId } = Route.useParams();
	const { view } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { identityKey } = useApplicationSession();
	const session = useBrowserSession();
	return (
		<main className="platform-content chat-content">
			<ConversationScreen
				key={`${identityKey}:${agentId}`}
				agentId={agentId}
				conversationId={conversationId}
				identityKey={identityKey}
				view={view ?? "conversation"}
				onViewChange={(next) => {
					void navigate({
						params: { agentId, conversationId },
						search: { view: next === "history" ? "history" : undefined },
					});
				}}
				onAccessDenied={() => {
					void session.refetch();
				}}
				onConversationChange={(next) => {
					void navigate({
						params: { agentId, conversationId: next },
						search: { view: undefined },
					});
				}}
			/>
		</main>
	);
}
