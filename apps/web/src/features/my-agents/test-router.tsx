import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach } from "vitest";

afterEach(cleanup);

export async function renderWithMyAgentsRouter(content: ReactNode) {
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
	const myAgentsRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/my-agents",
		component: () => null,
	});
	const applicationDetailRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/my-agents/$applicationId",
		component: () => null,
	});
	const applicationEditRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/my-agents/$applicationId/edit",
		component: () => null,
	});
	const applicationCreateRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/my-agents/new",
		component: () => null,
	});
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: rootRoute.addChildren([
			contentRoute,
			agentsRoute,
			agentDetailRoute,
			myAgentsRoute,
			applicationDetailRoute,
			applicationEditRoute,
			applicationCreateRoute,
		]),
	});
	await router.load();
	return render(<RouterProvider router={router} />);
}
