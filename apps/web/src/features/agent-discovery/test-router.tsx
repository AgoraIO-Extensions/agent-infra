import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export async function renderWithAgentRouter(content: ReactNode) {
	const rootRoute = createRootRoute();
	const contentRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => content,
	});
	const agentsRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/agents",
		component: () => null,
	});
	const agentDetailRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/agents/$agentId",
		component: () => null,
	});
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: rootRoute.addChildren([
			contentRoute,
			agentsRoute,
			agentDetailRoute,
		]),
	});
	await router.load();
	return renderToStaticMarkup(<RouterProvider router={router} />);
}
