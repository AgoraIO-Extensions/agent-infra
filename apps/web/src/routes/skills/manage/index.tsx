import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../../features/application-shell.js";
import { readFailed } from "../../../features/background-read.js";
import { collectionReadFailure } from "../../../features/collection-read-failure.js";
import { useSessionRecheck } from "../../../features/session-recheck.js";
import { MySkillsScreen } from "../../../features/skill-hub/skill-hub-management-screen.js";
import {
	useOwnedSkillHubVersions,
	useSkillHubInstallations,
	useSkillHubProjects,
} from "../../../features/skill-hub/use-skill-hub.js";

export const Route = createFileRoute("/skills/manage/")({
	component: MySkillsRoute,
});

function MySkillsRoute() {
	const { identityKey } = useApplicationSession();
	const projects = useSkillHubProjects({ identityKey });
	// 本人的全部版本（含审核中、已驳回、已撤销），不再借用只含已发布版本的目录。
	const versions = useOwnedSkillHubVersions({ identityKey });
	// 「我的安装」只读服务端按会话主体返回的本人安装（#2953）。
	const installations = useSkillHubInstallations({ identityKey });
	// 401 时经壳层重新确认会话；仍有效则解除不可重试锁定、重读三份读取（W-03，#3292 N9-3-04）。
	const relogin = useSessionRecheck(() => {
		void projects.refetch();
		void versions.reload();
		void installations.reload();
	});
	const status = (projects.error as { status?: number } | null)?.status;
	// 后台重读的可重试失败不替换已显示的三个分区（#3387）；401 等不可重试的失败照常显示。
	const projectsFailed = readFailed(
		projects,
		(error) =>
			collectionReadFailure((error as { status?: number } | null)?.status)
				.retryable,
	);
	return (
		<main className="platform-content management-content ia-skill-hub">
			<MySkillsScreen
				projects={
					projects.isPending
						? { kind: "loading" }
						: projectsFailed || !projects.data
							? collectionReadFailure(status)
							: { kind: "ready", items: projects.data.items }
				}
				versions={
					versions.isPending
						? { kind: "loading" }
						: versions.failed || !versions.data
							? { kind: "unavailable", retryable: versions.retryable }
							: versions.data
				}
				installations={
					installations.isPending
						? { kind: "loading" }
						: installations.failed || !installations.data
							? { kind: "unavailable", retryable: installations.retryable }
							: installations.data
				}
				onRetry={() => void projects.refetch()}
				onRelogin={() => void relogin.recheck()}
				retrying={projects.isFetching || relogin.checking}
				onInstallationsRetry={() => void installations.refetch()}
				installationsRetrying={installations.isFetching || relogin.checking}
				onInstallationsChanged={() => void installations.refetch()}
			/>
		</main>
	);
}
