import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../features/application-shell.js";
import { useSessionRecheck } from "../../features/session-recheck.js";
import { isRetryableSkillHubError } from "../../features/skill-hub/skill-hub.js";
import { SkillHubDirectoryScreen } from "../../features/skill-hub/skill-hub-screen.js";
import { useSkillHubDirectory } from "../../features/skill-hub/use-skill-hub.js";

export const Route = createFileRoute("/skills/")({
	component: SkillHubDirectoryRoute,
});

function SkillHubDirectoryRoute() {
	const { identityKey } = useApplicationSession();
	const query = useSkillHubDirectory({ identityKey });
	// 401 时经壳层重新确认会话；仍有效则解除不可重试锁定、重读一次目录（W-03，#3292 N9-3-04）。
	const relogin = useSessionRecheck(() => void query.reload());
	const retryable = query.isError
		? isRetryableSkillHubError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;

	return (
		<main className="platform-content management-content ia-skill-hub">
			<SkillHubDirectoryScreen
				state={
					query.isPending
						? { kind: "loading" }
						: // 后台重读的可重试失败不替换已显示的目录（#3387）。
							query.failed || !query.data
							? { kind: "unavailable", retryable: Boolean(retryable) }
							: query.data
				}
				onRetry={() => void query.refetch()}
				onRelogin={() => void relogin.recheck()}
				retrying={query.isFetching || relogin.checking}
			/>
		</main>
	);
}
