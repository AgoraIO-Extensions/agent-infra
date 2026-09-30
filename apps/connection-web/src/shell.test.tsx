// @vitest-environment jsdom

import type { ApprovalNotificationsResponse } from "@agent-infra/connection-contracts";
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
	listConnectionNotifications: vi.fn(
		async (): Promise<ApprovalNotificationsResponse> => ({
			adminWorkItems: 1,
			openWorkItems: 0,
			reapprovalWorkItems: 0,
			upgradeWorkItems: 0,
			unreadCount: 0,
			items: [
				{
					id: "notice-1",
					businessId: "request-1",
					businessType: "CONNECTION_ACCESS_REQUEST",
					providerId: "jira",
					state: "ROUTING_BLOCKED",
					eventType: "ROUTING_BLOCKED",
					createdAt: "2026-09-25T00:00:00Z",
					readAt: null,
					archivedAt: null,
				},
			],
		}),
	),
	updateApprovalNotification: vi.fn(
		async (_input: {
			notificationId: string;
			body: { action: "READ" | "ARCHIVE" };
		}) => undefined,
	),
	archiveApprovalNotifications: vi.fn(async (_ids: string[]) => undefined),
	navigate: vi.fn(async () => undefined),
	redirect: vi.fn(),
}));

vi.mock("./api", () => ({
	connectionApi: {
		getSession: mocks.getSession,
		logout: mocks.logout,
		listConnectionNotifications: mocks.listConnectionNotifications,
		updateApprovalNotification: mocks.updateApprovalNotification,
		archiveApprovalNotifications: mocks.archiveApprovalNotifications,
	},
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
	it("清除全部通知跨页归档但保留待办", async () => {
		const initial = await mocks.listConnectionNotifications();
		const notice = initial.items[0];
		if (!notice) throw new Error("Notification fixture is missing");
		const firstPage = Array.from({ length: 50 }, (_, index) => ({
			...notice,
			id: `notice-${index}`,
		}));
		const secondPage = [{ ...notice, id: "notice-50" }];
		mocks.listConnectionNotifications
			.mockResolvedValueOnce({ ...initial, items: firstPage, unreadCount: 51 })
			.mockResolvedValueOnce({ ...initial, items: firstPage, unreadCount: 51 })
			.mockResolvedValueOnce({ ...initial, items: secondPage, unreadCount: 1 })
			.mockResolvedValueOnce({ ...initial, items: [], unreadCount: 0 })
			.mockResolvedValueOnce({ ...initial, items: [], unreadCount: 0 });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ConsoleShell>内容</ConsoleShell>
			</QueryClientProvider>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: /通知与待办 52 项/ }),
		);
		fireEvent.click(screen.getByRole("button", { name: "清除全部" }));
		await waitFor(() =>
			expect(mocks.archiveApprovalNotifications).toHaveBeenCalledTimes(2),
		);
		expect(mocks.archiveApprovalNotifications.mock.calls[0]?.[0]).toHaveLength(
			50,
		);
		expect(mocks.archiveApprovalNotifications.mock.calls[1]?.[0]).toEqual([
			"notice-50",
		]);
		expect(await screen.findByText("暂无通知")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /通知与待办 1 项/ }),
		).toBeTruthy();
	});

	it("批量归档失败时刷新状态并展示错误", async () => {
		mocks.archiveApprovalNotifications.mockRejectedValueOnce(
			new Error("归档暂时失败"),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ConsoleShell>内容</ConsoleShell>
			</QueryClientProvider>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: /通知与待办 1 项/ }),
		);
		fireEvent.click(screen.getByRole("button", { name: "清除全部" }));
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"归档暂时失败",
		);
		await waitFor(() =>
			expect(mocks.listConnectionNotifications).toHaveBeenCalledTimes(3),
		);
		expect(screen.getByRole("button", { name: "清除全部" })).toBeTruthy();
	});

	it("归档已读通知不消除未完成待办", async () => {
		const initial = await mocks.listConnectionNotifications();
		mocks.listConnectionNotifications
			.mockResolvedValueOnce({
				...initial,
				items: initial.items.map((item) => ({
					...item,
					readAt: "2026-09-29T12:00:00Z",
				})),
			})
			.mockResolvedValueOnce({
				...initial,
				items: [],
				unreadCount: 0,
			});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ConsoleShell>内容</ConsoleShell>
			</QueryClientProvider>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: /通知与待办 1 项/ }),
		);
		expect(screen.getByText("待办 1 · 未读通知 0")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "归档通知" }));
		await waitFor(() =>
			expect(mocks.updateApprovalNotification.mock.calls[0]?.[0]).toEqual({
				notificationId: "notice-1",
				body: { action: "ARCHIVE" },
			}),
		);
		expect(await screen.findByText("暂无通知")).toBeTruthy();
		expect(screen.getByText("待办 1 · 未读通知 0")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /通知与待办 1 项/ }),
		).toBeTruthy();
	});

	it("归档失败保留通知并提示错误", async () => {
		const initial = await mocks.listConnectionNotifications();
		mocks.listConnectionNotifications.mockResolvedValueOnce({
			...initial,
			items: initial.items.map((item) => ({
				...item,
				readAt: "2026-09-29T12:00:00Z",
			})),
		});
		mocks.updateApprovalNotification.mockRejectedValueOnce(
			new Error("归档失败，请重试"),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ConsoleShell>内容</ConsoleShell>
			</QueryClientProvider>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: /通知与待办 1 项/ }),
		);
		fireEvent.click(screen.getByRole("button", { name: "归档通知" }));
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"归档失败，请重试",
		);
		expect(
			screen.getByRole("link", { name: "jira · 待重新分配" }),
		).toBeTruthy();
	});

	it("打开通知后更新已读样式与未读计数", async () => {
		const initial = await mocks.listConnectionNotifications();
		mocks.listConnectionNotifications
			.mockResolvedValueOnce({ ...initial, adminWorkItems: 0, unreadCount: 1 })
			.mockResolvedValueOnce({
				...initial,
				adminWorkItems: 0,
				unreadCount: 0,
				items: initial.items.map((item) => ({
					...item,
					readAt: "2026-09-29T12:00:00Z",
				})),
			});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ConsoleShell>内容</ConsoleShell>
			</QueryClientProvider>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: /通知与待办 1 项/ }),
		);
		const link = screen.getByRole("link", { name: "jira · 待重新分配" });
		expect(link.closest("li")?.className).toBe("unread");
		fireEvent.click(screen.getByRole("button", { name: "标记已读" }));
		await waitFor(() =>
			expect(mocks.updateApprovalNotification.mock.calls[0]?.[0]).toEqual({
				notificationId: "notice-1",
				body: { action: "READ" },
			}),
		);
		expect(
			await screen.findByRole("button", { name: /通知与待办 0 项/ }),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "jira · 待重新分配" }).closest("li")
				?.className,
		).toBe("");
		expect(screen.getByRole("button", { name: "归档通知" })).toBeTruthy();
	});

	it("把管理员审批异常从铃铛导向现有处理页", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ConsoleShell>内容</ConsoleShell>
			</QueryClientProvider>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: /通知与待办 1 项/ }),
		);
		expect(
			screen.getByRole("link", { name: "审批异常 1" }).getAttribute("href"),
		).toBe("/connection/admin/approval");
		expect(
			screen
				.getByRole("link", { name: "jira · 待重新分配" })
				.getAttribute("href"),
		).toBe("/connection/admin/approval");
	});
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
