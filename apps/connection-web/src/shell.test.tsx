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
	redirect: vi.fn(),
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
	Navigate: (props: unknown) => {
		mocks.redirect(props);
		return <div>登录已失效</div>;
	},
	useNavigate: () => mocks.navigate,
}));

import { ConsoleShell } from "./shell";

afterEach(() => {
	cleanup();
	window.history.replaceState({}, "", "/");
	vi.clearAllMocks();
});

describe("Connection 控制台 Session", () => {
	it("未登录时把受控 Connection 深链带到登录页", async () => {
		mocks.getSession.mockRejectedValueOnce(new Error("unauthorized"));
		window.history.replaceState(
			{},
			"",
			"/connection/connections?provider=confluence&intent=authorize",
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ConsoleShell>内容</ConsoleShell>
			</QueryClientProvider>,
		);

		await screen.findByText("登录已失效");
		expect(mocks.redirect).toHaveBeenCalledWith({
			replace: true,
			search: {
				returnTo:
					"/connection/connections?provider=confluence&intent=authorize",
			},
			to: "/connection/login",
		});
	});

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
		expect(mocks.navigate).toHaveBeenCalledWith({
			search: { returnTo: undefined },
			to: "/connection/login",
		});
	});
});
