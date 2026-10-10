// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), mount: vi.fn() }));
vi.mock("./api", () => ({ connectionApi: { getSession: mocks.getSession } }));
vi.mock("@tanstack/react-router", () => ({
	Navigate: ({ to }: { to: string }) => <div>跳转 {to}</div>,
}));

import { AdministratorAccess } from "./administrator-access";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
function Content() {
	mocks.mount();
	return <div>注册 Agent</div>;
}
function show() {
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<AdministratorAccess>
				<Content />
			</AdministratorAccess>
		</QueryClientProvider>,
	);
}
it("普通用户不会挂载管理页面或发出其数据请求", async () => {
	mocks.getSession.mockResolvedValue({ isAdministrator: false });
	show();
	await screen.findByText("跳转 /connection/connections");
	expect(mocks.mount).not.toHaveBeenCalled();
	expect(screen.queryByText("注册 Agent")).toBeNull();
});
it("权限确认前不挂载管理页面，管理员确认后可访问", async () => {
	mocks.getSession.mockResolvedValue({ isAdministrator: true });
	show();
	expect(mocks.mount).not.toHaveBeenCalled();
	await screen.findByText("注册 Agent");
});
it("失效会话返回登录页，不挂载管理页面", async () => {
	mocks.getSession.mockRejectedValue(new Error("unauthorized"));
	show();
	await screen.findByText("跳转 /connection/login");
	expect(mocks.mount).not.toHaveBeenCalled();
});
