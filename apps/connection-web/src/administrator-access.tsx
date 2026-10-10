import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { connectionApi } from "./api";

export function AdministratorAccess({ children }: { children: ReactNode }) {
	const session = useQuery({
		queryKey: ["session"],
		queryFn: connectionApi.getSession,
	});
	if (session.isPending) return <div role="status">正在确认管理权限...</div>;
	if (session.isError) {
		return (
			<Navigate
				to="/connection/login"
				search={{ returnTo: undefined }}
				replace
			/>
		);
	}
	if (!session.data.isAdministrator) {
		return <Navigate to="/connection/connections" replace />;
	}
	return children;
}
