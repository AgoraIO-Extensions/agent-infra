import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ConnectionApiError, connectionApi } from "./api";

export function AdministratorAccess({ children }: { children: ReactNode }) {
	const session = useQuery({
		queryKey: ["session"],
		queryFn: connectionApi.getSession,
		staleTime: 0,
		refetchOnMount: "always",
		retry: false,
	});
	if (session.isPending || !session.isFetchedAfterMount) {
		return <div role="status">正在确认管理权限...</div>;
	}
	if (session.isError) {
		if (
			session.error instanceof ConnectionApiError &&
			session.error.detail.code === "AUTHENTICATION_REQUIRED"
		) {
			return (
				<Navigate
					to="/connection/login"
					search={{ returnTo: undefined }}
					replace
				/>
			);
		}
		return (
			<div>
				<p role="alert">暂时无法确认管理权限，请稍后重试。</p>
				<button
					type="button"
					onClick={() => void session.refetch()}
					disabled={session.isFetching}
				>
					{session.isFetching ? "正在重试..." : "重试"}
				</button>
			</div>
		);
	}
	if (!session.data.isAdministrator) {
		return <Navigate to="/connection/connections" replace />;
	}
	return children;
}
