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
	useNarrowPersonalApiCredential,
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
	const narrow = useNarrowPersonalApiCredential();
	const [narrowingCredentialId, setNarrowingCredentialId] = useState<string>();
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
				onNarrow={async (credentialId, body) => {
					setNarrowingCredentialId(credentialId);
					try {
						const result = await narrow.mutateAsync({ credentialId, body });
						const refreshed = await credentials.refetch();
						if (refreshed?.error || refreshed?.data?.kind !== "ready") {
							throw new Error(
								"更新已受理，但无法读取最新元数据。请重新加载确认状态。",
							);
						}
						const current = refreshed.data.credentials.find(
							(item) => item.credentialId === credentialId,
						);
						if (
							!current ||
							current.expiresAt !== result.metadata.expiresAt ||
							current.scopes.length !== result.metadata.scopes.length ||
							!current.scopes.every((scope) =>
								result.metadata.scopes.includes(scope),
							)
						) {
							throw new Error(
								"更新已受理，但读取的元数据尚未同步。请重新加载确认状态。",
							);
						}
						return result;
					} finally {
						setNarrowingCredentialId(undefined);
					}
				}}
				narrowingCredentialId={narrowingCredentialId}
				isIssuing={issue.isPending}
				revokingCredentialId={revoke.isPending ? revoke.variables : undefined}
				issueError={issue.error}
				revokeError={revoke.error}
			/>
			<ApplicationManagementScreen
				state={application.state}
				onRetry={() => void application.refetch()}
				onRegister={async (name) => {
					const metadata = await register.mutateAsync(name);
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
