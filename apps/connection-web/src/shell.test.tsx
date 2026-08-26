// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(async () => ({
		account: { displayName: "郭贤哲", email: "guoxianzhe@agora.io" },
		isAdministrator: true,
	})),
	logout: vi.fn(async () => undefined),
	navigate: vi.fn(async () => undefined),
}));

vi.mock("./api", () => ({
	connectionApi: { getSession: mocks.getSession, logout: mocks.logout },
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		activeProps: _activeProps,
		children,
		to,
		...props
	}: AnchorHTMLAttributes<HTMLAnchorElement> & {
		activeProps?: unknown;
		children: ReactNode;
		to: string;
	}) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
	Navigate: () => <div>登录已失效</div>,
	useNavigate: () => mocks.navigate,
}));

import { ConsoleShell } from "./shell";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Connection 控制台 Session", () => {
	it("退出按钮调用 API、清空查询并返回登录页", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const clear = vi.spyOn(client, "clear");
		render(
			<QueryClientProvider client={client}>
				<ConsoleShell>内容</ConsoleShell>
			</QueryClientProvider>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
		await waitFor(() => expect(mocks.logout).toHaveBeenCalledOnce());
		expect(clear).toHaveBeenCalledOnce();
		expect(mocks.navigate).toHaveBeenCalledWith({ to: "/connection/login" });
	});
});
