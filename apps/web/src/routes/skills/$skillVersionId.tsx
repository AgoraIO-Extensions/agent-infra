import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../features/application-shell.js";
import { isRetryableSkillHubError } from "../../features/skill-hub/skill-hub.js";
import { SkillHubVersionScreen } from "../../features/skill-hub/skill-hub-screen.js";
import { useSkillHubVersion } from "../../features/skill-hub/use-skill-hub.js";

export const Route = createFileRoute("/skills/$skillVersionId")({
	component: SkillHubVersionRoute,
});

function SkillHubVersionRoute() {
	const { skillVersionId } = Route.useParams();
	const { identityKey } = useApplicationSession();
	const query = useSkillHubVersion({ identityKey, skillVersionId });
	const retryable = query.isError
		? isRetryableSkillHubError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;

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
			/>
		</main>
	);
}
