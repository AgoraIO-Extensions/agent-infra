import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../../features/application-shell.js";
import { collectionReadFailure } from "../../../features/collection-read-failure.js";
import { MySkillsScreen } from "../../../features/skill-hub/skill-hub-management-screen.js";
import {
	useSkillHubDirectory,
	useSkillHubProjects,
} from "../../../features/skill-hub/use-skill-hub.js";

export const Route = createFileRoute("/skills/manage/")({
	component: MySkillsRoute,
});

function MySkillsRoute() {
	const { identityKey } = useApplicationSession();
	const projects = useSkillHubProjects({ identityKey });
	const catalog = useSkillHubDirectory({ identityKey });
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
				catalog={
					catalog.isPending
						? { kind: "loading" }
						: catalog.isError || !catalog.data
							? { kind: "unavailable", retryable: catalog.retryable }
							: catalog.data
				}
				onRetry={() => void projects.refetch()}
				retrying={projects.isFetching}
			/>
		</main>
	);
}
