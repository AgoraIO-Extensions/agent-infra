import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
} from "@tanstack/react-router";

import "../index.css";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
	{
		component: RootComponent,
		head: () => ({
			meta: [
				{ title: "Connection" },
				{ name: "description", content: "外部账号与客户端授权管理" },
			],
		}),
	},
);

function RootComponent() {
	return (
		<>
			<HeadContent />
			<Outlet />
		</>
	);
}
