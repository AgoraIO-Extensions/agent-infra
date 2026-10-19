import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../../features/application-shell.js";
import { collectionReadFailure } from "../../../features/collection-read-failure.js";
import { MySkillsScreen } from "../../../features/skill-hub/skill-hub-management-screen.js";
import {
	useOwnedSkillHubVersions,
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
	const status = (projects.error as { status?: number } | null)?.status;
	return (
		<main className="platform-content management-content ia-skill-hub">
			<MySkillsScreen
				projects={
					projects.isPending
						? { kind: "loading" }
						: projects.isError || !projects.data
							? collectionReadFailure(status)
							: { kind: "ready", items: projects.data.items }
				}
				versions={
					versions.isPending
						? { kind: "loading" }
						: versions.isError || !versions.data
							? { kind: "unavailable", retryable: versions.retryable }
							: versions.data
				}
				onRetry={() => void projects.refetch()}
				retrying={projects.isFetching}
			/>
		</main>
	);
}
