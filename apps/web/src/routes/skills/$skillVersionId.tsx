import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useApplicationSession } from "../../features/application-shell.js";
import { isRetryableSkillHubError } from "../../features/skill-hub/skill-hub.js";
import {
	installSkillHubVersion,
	revokeSkillHubVersion,
	uninstallSkillHubInstallation,
} from "../../features/skill-hub/skill-hub-management.js";
import {
	type SkillDetailTab,
	SkillHubVersionScreen,
} from "../../features/skill-hub/skill-hub-version-screen.js";
import {
	useOwnedSkillHubVersions,
	useSkillHubDirectory,
	useSkillHubProjects,
	useSkillHubVersion,
} from "../../features/skill-hub/use-skill-hub.js";

// 默认 Tab「用途与内容」不写入地址；切换版本时保留 ?tab=versions。
export const Route = createFileRoute("/skills/$skillVersionId")({
	validateSearch: (search: Record<string, unknown>): { tab?: "versions" } =>
		search.tab === "versions" ? { tab: "versions" } : {},
	component: SkillHubVersionRoute,
});

function SkillHubVersionRoute() {
	const { skillVersionId } = Route.useParams();
	const { tab } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { identityKey, session } = useApplicationSession();
	const query = useSkillHubVersion({ identityKey, skillVersionId });
	const catalog = useSkillHubDirectory({ identityKey });
	const ownedVersions = useOwnedSkillHubVersions({ identityKey });
	const projects = useSkillHubProjects({ identityKey });
	const retryable = query.isError
		? isRetryableSkillHubError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;
	const version = query.data?.kind === "ready" ? query.data.version : undefined;
	const owned = Boolean(
		version &&
			projects.data?.items.some((item) => item.projectId === version.skillId),
	);
	const userId = session.user.userId;

	return (
		<main className="platform-content management-content ia-skill-hub">
			<SkillHubVersionScreen
				state={
					query.isPending
						? { kind: "loading" }
						: query.isError || !query.data
							? { kind: "unavailable", retryable: Boolean(retryable) }
							: query.data
				}
				onRetry={() => void query.refetch()}
				retrying={query.isFetching}
				catalog={
					catalog.isPending
						? { kind: "loading" }
						: catalog.isError || !catalog.data
							? { kind: "unavailable", retryable: catalog.retryable }
							: catalog.data
				}
				ownedVersions={
					ownedVersions.isPending
						? { kind: "loading" }
						: ownedVersions.isError || !ownedVersions.data
							? { kind: "unavailable", retryable: ownedVersions.retryable }
							: ownedVersions.data
				}
				onCatalogChanged={() => {
					void catalog.refetch();
					void ownedVersions.refetch();
				}}
				onVersionChanged={() => void query.refetch()}
				tab={tab ?? "overview"}
				onTabChange={(next: SkillDetailTab) =>
					void navigate({
						search: next === "versions" ? { tab: "versions" } : {},
						replace: true,
					})
				}
				owned={owned}
				actions={{
					// 主体固定为当前会话用户，页面没有可填写的主体或版本 ID。
					install: (id, idempotencyKey) =>
						installSkillHubVersion(
							{
								principalType: "user",
								principalId: userId,
								skillVersionId: id,
							},
							idempotencyKey,
						),
					uninstall: (installationId, idempotencyKey) =>
						uninstallSkillHubInstallation(installationId, idempotencyKey),
					revoke: (id, idempotencyKey) =>
						revokeSkillHubVersion(id, idempotencyKey),
				}}
			/>
		</main>
	);
}
