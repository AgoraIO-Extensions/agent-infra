import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";

import "../index.css";

export const Route = createRootRoute({
	component: RootComponent,
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
		<>
			<HeadContent />
			<Outlet />
		</>
	);
}
