import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";

import "../index.css";
import { ToastProvider } from "../components/ui/toast";
import { ApplicationShell } from "../features/application-shell";
import { NotFoundScreen } from "../features/not-found-screen";

export const Route = createRootRoute({
	component: RootComponent,
	notFoundComponent: NotFoundScreen,
	head: () => ({
		meta: [
			{
				title: "Agent Infra",
			},
			{
				name: "description",
				content: "企业级 Agent 平台",
			},
		],
	}),
});

function RootComponent() {
	return (
		<ToastProvider>
			<HeadContent />
			<ApplicationShell>
				<Outlet />
			</ApplicationShell>
		</ToastProvider>
	);
}
