import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useApplicationSession } from "../../../features/application-shell.js";
import { collectionReadFailure } from "../../../features/collection-read-failure.js";
import { PageLoadingState } from "../../../features/page-loading-state.js";
import { readSkillHubProjectContent } from "../../../features/skill-hub/skill-hub-management.js";
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
	const navigate = useNavigate();
	const { identityKey } = useApplicationSession();
	const queryClient = useQueryClient();
	const projects = useSkillHubProjects({ identityKey });
	const project = projectId
		? projects.data?.items.find((item) => item.projectId === projectId)
		: undefined;
	// 项目内容只在本人项目列表中确认存在后读取；服务端仍按会话主体授权。
	const content = useQuery({
		queryKey: ["skill-hub", "project-content", identityKey, project?.projectId],
		queryFn: () => readSkillHubProjectContent(project?.projectId ?? ""),
		enabled: Boolean(identityKey && project),
		retry: false,
	});
	const contentStatus = (content.error as { status?: number } | null)?.status;
	const invalidateProjects = () =>
		queryClient.invalidateQueries({
			queryKey: ["skill-hub", "projects", identityKey],
		});
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
					onProjectsChanged={() => void invalidateProjects()}
					onProjectCreated={(createdId) =>
						// 项目列表刷新后再进入新项目，避免短暂显示「找不到项目」。
						void invalidateProjects().then(() =>
							navigate({
								to: "/skills/manage/new",
								search: { project: createdId },
							}),
						)
					}
					content={
						content.isPending
							? { kind: "loading" }
							: content.isError || !content.data
								? collectionReadFailure(contentStatus)
								: { kind: "ready", content: content.data }
					}
					onContentRetry={() => content.refetch()}
					contentRetrying={content.isFetching}
					onPublished={() =>
						void queryClient.invalidateQueries({
							queryKey: ["skill-hub", "owned-versions", identityKey],
						})
					}
				/>
			)}
		</main>
	);
}
