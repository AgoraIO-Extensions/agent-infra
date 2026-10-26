import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../features/application-shell.js";
import { readFailed } from "../../features/background-read.js";
import { useSessionRecheck } from "../../features/session-recheck.js";
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
	// 队列读取 401 时经壳层重新确认会话；仍有效则重读一次队列（W-03，#3292 N9-3-04）。
	const relogin = useSessionRecheck(() => void query.refetch());
	return (
		<main className="platform-content management-content ia-skill-hub">
			<SkillReviewsScreen
				isAdministrator={isAdministrator}
				currentUserId={session.user.userId}
				queue={
					query.isPending
						? { kind: "loading" }
						: // 后台重读（回到标签页、审核后的重读）的可重试失败不替换队列（#3387）。
							readFailed(query, isRetryableSkillHubError) || !query.data
							? {
									kind: "unavailable",
									retryable: isRetryableSkillHubError(query.error),
								}
							: query.data
				}
				onRetry={() => void query.refetch()}
				onRelogin={() => void relogin.recheck()}
				retrying={query.isFetching || relogin.checking}
				review={reviewSkillHubVersion}
				onReviewed={() => void query.refetch()}
			/>
		</main>
	);
}
