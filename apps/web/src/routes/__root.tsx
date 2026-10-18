import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";

import "../index.css";
import { ApplicationShell } from "../features/application-shell";
import { NotFoundScreen } from "../features/not-found-screen";

export const Route = createRootRoute({
	component: RootComponent,
	notFoundComponent: NotFoundScreen,
	head: () => ({
		meta: [
			{
				name: "description",
				content: "企业级 Agent 平台",
			},
		],
	}),
});

function RootComponent() {
	return (
		<>
			<HeadContent />
			<ApplicationShell>
				<Outlet />
			</ApplicationShell>
		</>
	);
}
