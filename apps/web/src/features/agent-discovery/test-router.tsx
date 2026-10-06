import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
	const agentConfigurationRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/agents/$agentId/configuration",
		component: () => null,
	});
	const chatRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/chat/$agentId/{-$conversationId}",
		component: () => null,
	});
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: rootRoute.addChildren([
			contentRoute,
			agentsRoute,
			agentDetailRoute,
			agentConfigurationRoute,
			chatRoute,
		]),
	});
	await router.load();
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false, gcTime: 0 } },
				})
			}
		>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}
