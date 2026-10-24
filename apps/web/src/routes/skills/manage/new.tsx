import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useApplicationSession } from "../../../features/application-shell.js";
import { readFailed } from "../../../features/background-read.js";
import { collectionReadFailure } from "../../../features/collection-read-failure.js";
import { PageLoadingState } from "../../../features/page-loading-state.js";
import { useSessionRecheck } from "../../../features/session-recheck.js";
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
	// 刚创建的项目：进入后编辑器按项目重新挂载，就地反馈与焦点交接由新编辑器接着做（#3269 N8-3-04）；
	// 切到别的项目后不再显示。
	const [created, setCreated] = useState<{ projectId: string; name: string }>();
	useEffect(() => {
		if (created && projectId && projectId !== created.projectId)
			setCreated(undefined);
	}, [created, projectId]);
	// 内容读取 401 时经壳层重新确认会话；仍有效则重读一次内容（W-03，#3292 N9-3-04）。
	const relogin = useSessionRecheck(() => void content.refetch());
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
					createdName={
						created && created.projectId === project?.projectId
							? created.name
							: undefined
					}
					onProjectsChanged={() => void invalidateProjects()}
					onProjectCreated={(createdId, name) => {
						setCreated({ projectId: createdId, name });
						// 项目列表刷新后再进入新项目，避免短暂显示「找不到项目」。
						void invalidateProjects().then(() =>
							navigate({
								to: "/skills/manage/new",
								search: { project: createdId },
							}),
						);
					}}
					content={
						content.isPending
							? { kind: "loading" }
							: // 后台重读的可重试失败不替换编辑器：SKILL.md 未保存的修改保留（#3387）。
								readFailed(
										content,
										(error) =>
											collectionReadFailure(
												(error as { status?: number } | null)?.status,
											).retryable,
									) || !content.data
								? collectionReadFailure(contentStatus)
								: { kind: "ready", content: content.data }
					}
					onContentRetry={() => content.refetch()}
					onContentRelogin={() => void relogin.recheck()}
					contentRetrying={content.isFetching || relogin.checking}
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
