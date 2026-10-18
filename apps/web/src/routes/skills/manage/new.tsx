import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../../features/application-shell.js";
import { PageLoadingState } from "../../../features/page-loading-state.js";
import { SkillEditorScreen } from "../../../features/skill-hub/skill-hub-management-screen.js";
import { useSkillHubProjects } from "../../../features/skill-hub/use-skill-hub.js";

// ?project= 只用于从「编辑新版本」进入时选中自己的项目；项目必须在本人的项目列表中。
export const Route = createFileRoute("/skills/manage/new")({
	validateSearch: (search: Record<string, unknown>): { project?: string } =>
		typeof search.project === "string" && search.project
			? { project: search.project }
			: {},
	component: SkillEditorRoute,
});

function SkillEditorRoute() {
	const { project: projectId } = Route.useSearch();
	const { identityKey } = useApplicationSession();
	const queryClient = useQueryClient();
	const projects = useSkillHubProjects({ identityKey });
	const project = projectId
		? projects.data?.items.find((item) => item.projectId === projectId)
		: undefined;
	return (
		<main className="platform-content management-content ia-skill-hub">
			{projectId && projects.isPending ? (
				<PageLoadingState
					title="创建与发布 Skill"
					message="正在读取 Skill 项目…"
				/>
			) : (
				<SkillEditorScreen
					key={project?.projectId ?? "new"}
					project={project}
					projectMissing={Boolean(projectId && !project)}
					onProjectsChanged={() =>
						void queryClient.invalidateQueries({
							queryKey: ["skill-hub", "projects", identityKey],
						})
					}
				/>
			)}
		</main>
	);
}
