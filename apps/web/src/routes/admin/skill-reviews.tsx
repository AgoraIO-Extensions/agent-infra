import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../features/application-shell.js";
import { isRetryableSkillHubError } from "../../features/skill-hub/skill-hub.js";
import { reviewSkillHubVersion } from "../../features/skill-hub/skill-hub-management.js";
import { useSkillReviewQueue } from "../../features/skill-hub/skill-review-queue.js";
import { SkillReviewsScreen } from "../../features/skill-hub/skill-review-screen.js";

export const Route = createFileRoute("/admin/skill-reviews")({
	component: SkillReviewsRoute,
});

function SkillReviewsRoute() {
	const { session, identityKey } = useApplicationSession();
	// 角色只决定是否发起读取；队列和审核的授权都由服务端判定。
	const isAdministrator = session.user.roles.includes("system_admin");
	const query = useSkillReviewQueue({
		identityKey,
		enabled: isAdministrator,
	});
	return (
		<main className="platform-content management-content ia-skill-hub">
			<SkillReviewsScreen
				isAdministrator={isAdministrator}
				currentUserId={session.user.userId}
				queue={
					query.isPending
						? { kind: "loading" }
						: query.isError || !query.data
							? {
									kind: "unavailable",
									retryable: isRetryableSkillHubError(query.error),
								}
							: query.data
				}
				onRetry={() => void query.refetch()}
				retrying={query.isFetching}
				review={reviewSkillHubVersion}
				onReviewed={() => void query.refetch()}
			/>
		</main>
	);
}
