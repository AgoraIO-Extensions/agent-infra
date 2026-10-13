import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useApplicationSession } from "../features/application-shell.js";
import { OperationsEntry } from "../features/operations/operations-entry.js";
import { fetchOperationsStatus } from "../features/operations/operations-query.js";

export const Route = createFileRoute("/ops")({
	component: OperationsRoute,
});

function OperationsRoute() {
	const { session } = useApplicationSession();
	const isAdministrator = session.user.roles.includes("system_admin");
	const [state, setState] = useState<
		import("../features/operations/operations-entry.js").OperationsEntryState
	>({ kind: "unknown" });
	const [isRefreshing, setIsRefreshing] = useState(false);
	const refresh = useCallback(async () => {
		if (!isAdministrator) return;
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
				onRefresh={() => void refresh()}
				isRefreshing={isRefreshing}
			/>
		</main>
	);
}
