import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../features/application-shell.js";
import { isRetryableSkillHubError } from "../../features/skill-hub/skill-hub.js";
import { SkillHubManagementScreen } from "../../features/skill-hub/skill-hub-management-screen.js";
import { useSkillHubDirectory } from "../../features/skill-hub/use-skill-hub.js";

export const Route = createFileRoute("/skills/manage")({
	component: SkillHubManagementRoute,
});

function SkillHubManagementRoute() {
	const { identityKey, session } = useApplicationSession();
	const query = useSkillHubDirectory({ identityKey });
	const retryable = query.isError
		? isRetryableSkillHubError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;
	return (
		<main className="platform-content management-content ia-skill-hub">
			<SkillHubManagementScreen
				isAdministrator={session.user.roles.includes("system_admin")}
				state={
					query.isPending
						? { kind: "loading" }
						: query.isError || !query.data
							? { kind: "unavailable", retryable: Boolean(retryable) }
							: query.data
				}
				onRetry={() => void query.refetch()}
				retrying={query.isFetching}
			/>
		</main>
	);
}
