import {
	createFileRoute,
	useLocation,
	useRouter,
} from "@tanstack/react-router";
import { useRef, useState } from "react";
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
import { useSessionRecheck } from "../../features/session-recheck.js";

export const Route = createFileRoute("/my-settings/api-credentials")({
	component: ApiCredentialsRoute,
});

function ApiCredentialsRoute() {
	const { identityKey, session } = useApplicationSession();
	const router = useRouter();
	const applicationHeading = useRef<HTMLHeadingElement>(null);
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
	// 列表或应用读取 401 时经壳层重新确认会话；仍有效则解除锁定、重读两份读取（W-03，#3292 N9-3-04）。
	const relogin = useSessionRecheck(() => {
		void credentials.reload();
		void application.refetch();
	});

	return (
		<main className="platform-content management-content">
			<ApiCredentialsScreen
				state={credentials.state}
				subjectName={session.user.displayName}
				onCreateApplicationCredential={() => {
					// 应用凭证需要先注册或打开应用：页内跳到应用分区，不发起写请求。
					const heading = applicationHeading.current;
					heading?.scrollIntoView({ block: "start" });
					heading?.focus({ preventScroll: true });
				}}
				onRetry={() => void credentials.refetch()}
				onRelogin={() => void relogin.recheck()}
				retrying={credentials.isFetching || relogin.checking}
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
				key={identityKey}
				headingRef={applicationHeading}
				state={application.state}
				onRetry={() => void application.refetch()}
				onRelogin={() => void relogin.recheck()}
				retrying={application.isFetching || relogin.checking}
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
