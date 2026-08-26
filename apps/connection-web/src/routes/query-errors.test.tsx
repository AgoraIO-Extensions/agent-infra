// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const failedQuery = vi.hoisted(() =>
	vi.fn(async () => {
		throw new Error("unavailable");
	}),
);

vi.mock("../api", () => ({
	connectionApi: new Proxy(
		{
			getSharedConnections: failedQuery,
			listAdministrators: failedQuery,
			listTokens: failedQuery,
		},
		{ get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
	),
}));

vi.mock("../shell", () => ({
	ConsoleShell: ({ children }: { children: ReactNode }) => <>{children}</>,
	PageError: () => <div role="alert">请求失败</div>,
}));

import { AdministratorsPage } from "../pages/administrators-page";
import { SharedConnectionsPage } from "../pages/shared-connections-page";
import { TokensPage } from "../pages/tokens-page";

afterEach(() => {
	cleanup();
	failedQuery.mockClear();
});

function renderPage(page: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>{page}</QueryClientProvider>,
	);
}

describe("Connection 查询失败状态", () => {
	it.each([
		["Token", <TokensPage />, "还没有访问令牌"],
		["管理员", <AdministratorsPage />, "没有可管理的员工"],
		["共享 Connection", <SharedConnectionsPage />, "还没有共享组"],
	])("%s 页面只显示错误，不同时显示空数据", async (_name, page, emptyText) => {
		renderPage(page);
		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(screen.queryByText(emptyText)).toBeNull();
	});
});
