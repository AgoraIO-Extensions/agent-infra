import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../features/application-shell.js";
import { useSessionRecheck } from "../features/session-recheck.js";
import { useTemplateNameLookup } from "../features/template-display-name.js";
import { useRecentPersonalConversations } from "../features/workbench/use-recent-personal-conversations.js";
import { useWorkbenchCollections } from "../features/workbench/use-workbench-collections.js";
import {
	WorkbenchScreen,
	workbenchRecentLimit,
} from "../features/workbench/workbench-screen.js";

export const Route = createFileRoute("/")({
	component: WorkbenchRoute,
});

function WorkbenchRoute() {
	const { identityKey, session } = useApplicationSession();
	const administrator = session.user.roles.includes("system_admin");
	const { reload, ...collections } = useWorkbenchCollections({
		identityKey,
		administrator,
	});
	const recent = useRecentPersonalConversations({
		identityKey,
		limit: workbenchRecentLimit,
	});
	const templateName = useTemplateNameLookup();
	// 会话仍有效时解除各分区不可重试的失败（401 等）并重读一次（W-03）。
	const relogin = useSessionRecheck(() => {
		reload();
		void recent.reload();
	});
	return (
		<main className="platform-content management-content">
			<WorkbenchScreen
				{...collections}
				administrator={administrator}
				recent={recent.state}
				refreshing={
					collections.refreshing || recent.isFetching || relogin.checking
				}
				onRetry={() => {
					collections.onRetry();
					void recent.refresh();
				}}
				onRelogin={() => void relogin.recheck()}
				templateName={templateName}
			/>
		</main>
	);
}
