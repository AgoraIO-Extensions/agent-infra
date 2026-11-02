import type { QueryClient } from "@tanstack/react-query";
import {
	QueryClient as QueryClientImpl,
	QueryClientProvider,
} from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ToastProvider } from "@/components/ui/toast";

/**
 * 组件单测用：只提供路由上下文（不渲染路由树），让配置页里的路由 Link 生成 href；
 * 页面在根布局的 ToastProvider 内渲染，这里一并提供。
 */
export function ConfigurationTestProviders({
	children,
	queryClient,
}: {
	children: ReactNode;
	queryClient?: QueryClient;
}) {
	const [router] = useState(() =>
		createRouter({
			routeTree: createRootRoute(),
			history: createMemoryHistory({ initialEntries: ["/"] }),
		}),
	);
	const [ownedQueryClient] = useState(
		() =>
			new QueryClientImpl({ defaultOptions: { queries: { retry: false } } }),
	);
	return (
		<RouterContextProvider router={router}>
			<QueryClientProvider client={queryClient ?? ownedQueryClient}>
				<ToastProvider>{children}</ToastProvider>
			</QueryClientProvider>
		</RouterContextProvider>
	);
}
