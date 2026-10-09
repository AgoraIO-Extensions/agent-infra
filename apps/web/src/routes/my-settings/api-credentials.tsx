import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { ApiCredentialsScreen } from "../../features/api-credentials/api-credentials-screen.js";
import {
	useApiCredentials,
	useIssuePersonalApiCredential,
	useRevokePersonalApiCredential,
} from "../../features/api-credentials/use-api-credentials.js";
import { ApplicationManagementScreen } from "../../features/application-management/application-management-screen.js";
import {
	useDisableOwnApplication,
	useIssueOrRotateApplicationCredential,
	useOwnApplication,
	useRegisterOwnApplication,
} from "../../features/application-management/use-application-management.js";
import { useApplicationSession } from "../../features/application-shell.js";

export const Route = createFileRoute("/my-settings/api-credentials")({
	component: ApiCredentialsRoute,
});

function ApiCredentialsRoute() {
	const { identityKey } = useApplicationSession();
	const credentials = useApiCredentials({ identityKey });
	const issue = useIssuePersonalApiCredential();
	const revoke = useRevokePersonalApiCredential();
	const search = useLocation({ select: (location) => location.search });
	const requestedApplicationId =
		typeof (search as Record<string, unknown>).applicationId === "string"
			? (search as Record<string, unknown>).applicationId
			: undefined;
	const [applicationId, setApplicationId] = useState(requestedApplicationId);
	const application = useOwnApplication({ applicationId, identityKey });
	const register = useRegisterOwnApplication();
	const disable = useDisableOwnApplication();
	const issueApplicationCredential = useIssueOrRotateApplicationCredential();

	return (
		<main className="platform-content management-content space-y-12">
			<ApiCredentialsScreen
				state={credentials.state}
				onRetry={() => void credentials.refetch()}
				onIssue={issue.mutateAsync}
				onRevoke={revoke.mutateAsync}
				isIssuing={issue.isPending}
				revokingCredentialId={revoke.variables}
				issueError={issue.error}
				revokeError={revoke.error}
			/>
			<ApplicationManagementScreen
				state={application.state}
				onRetry={() => void application.refetch()}
				onRegister={async (name) => {
					const metadata = await register.mutateAsync(name);
					setApplicationId(metadata.applicationId);
					return metadata;
				}}
				onDisable={disable.mutateAsync}
				onIssueCredential={issueApplicationCredential.mutateAsync}
				isRegistering={register.isPending}
				isDisabling={disable.isPending}
				isIssuingCredential={issueApplicationCredential.isPending}
				actionError={register.error ?? disable.error ?? issueApplicationCredential.error}
			/>
		</main>
	);
}
