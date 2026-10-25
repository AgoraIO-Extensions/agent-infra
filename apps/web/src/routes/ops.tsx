import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useApplicationSession } from "../features/application-shell.js";
import {
	OperationsEntry,
	type OperationsEntryState,
} from "../features/operations/operations-entry.js";
import { fetchOperationsStatus } from "../features/operations/operations-query.js";

export const Route = createFileRoute("/ops")({
	component: OperationsRoute,
});

function OperationsRoute() {
	const { session } = useApplicationSession();
	const isAdministrator = session.user.roles.includes("system_admin");
	// 非系统管理员不发出观测查询，直接显示无权限卡（F-12 AC-3）。
	const [state, setState] = useState<OperationsEntryState>(() =>
		isAdministrator ? { kind: "loading" } : { kind: "denied" },
	);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const refresh = useCallback(async () => {
		if (!isAdministrator) return;
		setState({ kind: "loading" });
		setIsRefreshing(true);
		try {
			setState(await fetchOperationsStatus());
		} finally {
			setIsRefreshing(false);
		}
	}, [isAdministrator]);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	return (
		<main className="platform-content management-content">
			<OperationsEntry
				isAdministrator={isAdministrator}
				state={state}
				onRefresh={() => refresh()}
				isRefreshing={isRefreshing}
			/>
		</main>
	);
}
