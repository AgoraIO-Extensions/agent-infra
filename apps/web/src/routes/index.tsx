import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../features/application-shell.js";
import { useRecentPersonalConversations } from "../features/workbench/use-recent-personal-conversations.js";
import { useWorkbenchCollections } from "../features/workbench/use-workbench-collections.js";
import { WorkbenchScreen } from "../features/workbench/workbench-screen.js";

export const Route = createFileRoute("/")({
	component: WorkbenchRoute,
});

function WorkbenchRoute() {
	const { identityKey, session } = useApplicationSession();
	const administrator = session.user.roles.includes("system_admin");
	const collections = useWorkbenchCollections({ identityKey, administrator });
	const recent = useRecentPersonalConversations({ identityKey });
	return (
		<main className="platform-content management-content">
			<WorkbenchScreen
				{...collections}
				administrator={administrator}
				recent={recent.state}
				refreshing={collections.refreshing || recent.isFetching}
				onRetry={() => {
					collections.onRetry();
					void recent.refresh();
				}}
				onLoadMoreRecent={() => void recent.loadMore()}
			/>
		</main>
	);
}
