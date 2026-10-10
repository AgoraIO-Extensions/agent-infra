import {
	createFileRoute,
	useLocation,
	useRouter,
} from "@tanstack/react-router";
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
	const router = useRouter();
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
	const application = useOwnApplication({
		applicationId: requestedApplicationId,
		identityKey,
	});
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
				revokingCredentialId={revoke.isPending ? revoke.variables : undefined}
				issueError={issue.error}
				revokeError={revoke.error}
			/>
			<ApplicationManagementScreen
				key={identityKey}
				state={application.state}
				onRetry={() => void application.refetch()}
				onOpenApplication={(applicationId) =>
					router.history.push(
						`/my-settings/api-credentials?applicationId=${encodeURIComponent(applicationId)}`,
					)
				}
				onRegister={async (name) => {
					const metadata = await register.mutateAsync(name);
					router.history.replace(
						`/my-settings/api-credentials?applicationId=${encodeURIComponent(metadata.applicationId)}`,
					);
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
