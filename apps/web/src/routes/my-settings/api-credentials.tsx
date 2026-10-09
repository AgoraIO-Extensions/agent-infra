import {
	createFileRoute,
	useLocation,
	useNavigate,
} from "@tanstack/react-router";
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
	const navigate = useNavigate({ from: "/my-settings/api-credentials" });
	const credentials = useApiCredentials({ identityKey });
	const issue = useIssuePersonalApiCredential();
	const revoke = useRevokePersonalApiCredential();
	const search = useLocation({
		select: (location) => location.search as Record<string, unknown>,
	});
	const candidateApplicationId = search.applicationId;
	const requestedApplicationId =
		typeof candidateApplicationId === "string"
			? candidateApplicationId
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
				onIssue={async (body) => {
					const result = await issue.mutateAsync(body);
					await credentials.refetch().catch(() => undefined);
					return result;
				}}
				onRevoke={async (credentialId) => {
					const result = await revoke.mutateAsync(credentialId);
					await credentials.refetch().catch(() => undefined);
					return result;
				}}
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
					await navigate({
						replace: true,
						search: { applicationId: metadata.applicationId },
					});
					return metadata;
				}}
				onDisable={async (applicationId) => {
					const result = await disable.mutateAsync(applicationId);
					await application.refetch().catch(() => undefined);
					return result;
				}}
				onIssueCredential={issueApplicationCredential.mutateAsync}
				isRegistering={register.isPending}
				isDisabling={disable.isPending}
				isIssuingCredential={issueApplicationCredential.isPending}
				actionError={
					register.error ?? disable.error ?? issueApplicationCredential.error
				}
			/>
		</main>
	);
}
