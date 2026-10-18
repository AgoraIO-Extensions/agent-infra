import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../features/application-shell.js";
import { reviewSkillHubVersion } from "../../features/skill-hub/skill-hub-management.js";
import { SkillReviewsScreen } from "../../features/skill-hub/skill-review-screen.js";

export const Route = createFileRoute("/admin/skill-reviews")({
	component: SkillReviewsRoute,
});

function SkillReviewsRoute() {
	const { session } = useApplicationSession();
	return (
		<main className="platform-content management-content ia-skill-hub">
			{/* 契约还没有管理员可读的待审队列，页面如实显示不可用，不发出审核请求。 */}
			<SkillReviewsScreen
				isAdministrator={session.user.roles.includes("system_admin")}
				currentUserId={session.user.userId}
				queue={{ kind: "unavailable" }}
				review={reviewSkillHubVersion}
			/>
		</main>
	);
}
