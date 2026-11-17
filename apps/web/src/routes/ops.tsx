import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { useApplicationSession } from "../features/application-shell.js";
import { OperationsEntry } from "../features/operations/operations-entry.js";
import { ResourceDashboard } from "../features/operations/resource-dashboard.js";
import { ResourceHistory } from "../features/operations/resource-history.js";
import {
	fetchOperationsResources,
	OperationsQueryError,
} from "../features/operations/resource-query.js";

export const Route = createFileRoute("/ops")({
	validateSearch: (
		input: Record<string, unknown>,
	): { agentId?: string; sessionId?: string } => ({
		agentId:
			typeof input.agentId === "string" && input.agentId.length <= 256
				? input.agentId
				: "",
		sessionId:
			typeof input.sessionId === "string" && input.sessionId.length <= 256
				? input.sessionId
				: "",
	}),
	component: OperationsRoute,
});

function OperationsRoute() {
	const { session, identityKey } = useApplicationSession();
	const isAdministrator = session.user.roles.includes("system_admin");
	const [forbiddenIdentity, setForbiddenIdentity] = useState<string | null>(
		null,
	);
	const { agentId = "", sessionId = "" } = Route.useSearch();
	const navigate = Route.useNavigate();
	const query = useQuery({
		queryKey: ["ops-resources", identityKey, agentId, sessionId],
		enabled: isAdministrator && forbiddenIdentity !== identityKey,
		queryFn: ({ signal }) =>
			fetchOperationsResources(
				{
					...(agentId ? { agentId } : {}),
					...(sessionId ? { sessionId } : {}),
				},
				signal,
			),
		refetchInterval: (current) =>
			(current.state.data?.refreshSeconds ?? 30) * 1000,
		refetchIntervalInBackground: false,
		retry: false,
		gcTime: 0,
	});
	const denied =
		!isAdministrator ||
		forbiddenIdentity === identityKey ||
		(query.error instanceof OperationsQueryError &&
			query.error.kind === "denied");
	useEffect(() => {
		if (
			query.error instanceof OperationsQueryError &&
			query.error.kind === "denied"
		)
			setForbiddenIdentity(identityKey);
	}, [query.error, identityKey]);
	const data =
		!denied && query.data
			? query.isError
				? {
						...query.data,
						sources: query.data.sources.map((source) =>
							source.state === "available"
								? {
										...source,
										state: "stale" as const,
										reason: "STALE" as const,
									}
								: source,
						),
					}
				: query.data
			: undefined;
	return (
		<main className="platform-content management-content">
			{data ? (
				<>
					<ResourceDashboard
						data={data}
						refreshing={query.isFetching}
						onRefresh={() => {
							void query.refetch();
						}}
						agentId={agentId}
						sessionId={sessionId}
						onSelectAgent={(value) => {
							void navigate({ search: { agentId: value, sessionId: "" } });
						}}
						onSelectSession={(value) => {
							void navigate({ search: { agentId, sessionId: value } });
						}}
						history={
							<ResourceHistory
								identityKey={identityKey}
								onDenied={() => setForbiddenIdentity(identityKey)}
								agentId={agentId}
								sessionId={sessionId}
								links={data.links}
								objects={[...data.nodes, ...data.resources].map((entry) => ({
									uid: entry.uid,
									name: entry.name,
								}))}
							/>
						}
					/>
					{query.isError && (
						<Alert tone="warn" role="alert">
							刷新失败，当前保留上一次数据并标为过期。
						</Alert>
					)}
				</>
			) : (
				<OperationsEntry
					isAdministrator={!denied}
					onRefresh={() => {
						void query.refetch();
					}}
					isRefreshing={query.isFetching}
					state={
						denied
							? { kind: "denied" }
							: query.isPending
								? { kind: "loading" }
								: query.error instanceof OperationsQueryError &&
										query.error.kind === "not-connected"
									? { kind: "not-connected" }
									: {
											kind: "unavailable",
											message:
												"资源观测查询尚未接通或暂不可用，请检查部署配置后重试。",
										}
					}
				/>
			)}
		</main>
	);
}
