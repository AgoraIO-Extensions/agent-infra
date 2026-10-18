import { BrowserSessionProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render as renderView,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import { pendingApplication } from "../my-agents/test-fixtures.js";
import { AdminAgentApplicationsScreen } from "./admin-agent-applications-screen.js";

// 页面按需读取目录显示名：测试与生产一样提供 QueryClient，并以固定目录记录响应。
const directoryRecords = [
	{
		kind: "user",
		canonicalId: "user-1",
		displayName: "负责人一",
		email: "owner.one@example.test",
	},
	{
		kind: "user",
		canonicalId: "user-two",
		displayName: "验收用户二",
		email: "user.two@example.test",
	},
	{
		kind: "organization",
		canonicalId: "org-platform",
		displayName: "平台工程",
		organizationPath: "研发 / 平台工程",
	},
	{
		kind: "organization",
		canonicalId: "org-release",
		displayName: "发布工程",
		organizationPath: "研发 / 发布工程",
	},
];
const directoryRequests: URL[] = [];
beforeEach(() => {
	directoryRequests.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input), "http://localhost");
			directoryRequests.push(url);
			const ids = url.searchParams.get("ids")?.split(",") ?? [];
			return Response.json({
				items: directoryRecords.filter(
					(item) =>
						item.kind === url.searchParams.get("kind") &&
						ids.includes(item.canonicalId),
				),
			});
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function render(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	return renderView(ui, {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				<ToastProvider>{children}</ToastProvider>
			</QueryClientProvider>
		),
	});
}

const administratorSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-admin-1",
		displayName: "Administrator",
		roles: ["employee", "system_admin"],
	},
});
const ordinaryUserSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-employee-1",
		displayName: "Employee",
		roles: ["employee"],
	},
});

afterEach(cleanup);

const reviewName = (name = pendingApplication.name) => `审阅：${name}`;
const toastText = () =>
	document.querySelector('[data-slot="toast"]')?.textContent ?? "";
// 多申请场景：员工与组织范围各有目录记录，第三条为自定义 Agent。
const queue = [
	{
		...pendingApplication,
		applicationId: "application-a",
		name: "申请甲",
		configuration: {
			...pendingApplication.configuration,
			availability: [{ kind: "user" as const, userId: "user-two" }],
		},
	},
	{
		...pendingApplication,
		applicationId: "application-b",
		name: "申请乙",
		description: "需要发布工程协作",
		configuration: {
			...pendingApplication.configuration,
			owners: [
				{
					userId: "user-owner-b",
					displayName: "乙 Owner",
					roles: ["employee" as const],
				},
			],
			availability: [
				{ kind: "organization" as const, organizationId: "org-platform" },
			],
		},
	},
	{
		...pendingApplication,
		applicationId: "application-c",
		name: "申请丙",
		source: {
			kind: "custom" as const,
			interactionMode: "platform-adapter" as const,
			imageReference: "registry.example.test/agent:1",
		},
		configuration: {
			...pendingApplication.configuration,
			availability: [
				{ kind: "user" as const, userId: "user-1" },
				{ kind: "organization" as const, organizationId: "org-release" },
			],
		},
	},
];

describe("AdminAgentApplicationsScreen", () => {
	it("labels every non-action approval cell with its column header for mobile cards", () => {
		render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		const table = screen.getByRole("table", { name: "创建审批" });
		const headers = within(table)
			.getAllByRole("columnheader")
			.map((header) => header.textContent);
		expect(headers).toEqual([
			"申请",
			"来源 / Owner",
			"可用范围",
			"模型",
			"提交时间",
			"操作",
		]);
		const [row] = within(table).getAllByRole("row").slice(1);
		const cells = within(row as HTMLElement).getAllByRole("cell");
		expect(cells.map((cell) => cell.getAttribute("data-label"))).toEqual([
			...headers.slice(0, 5),
			null,
		]);
		expect(cells.at(-1)?.getAttribute("data-cell")).toBe("actions");
		// AP-02：行操作可见文字「审阅」+ eye 图标，名称带申请名。
		const review = within(cells.at(-1) as HTMLElement).getByRole("button", {
			name: reviewName(),
		});
		expect(review.textContent).toBe("审阅");
		expect(review.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		// F-05：首列只有名称，没有说明与状态 Badge。
		expect(cells[0]?.textContent).toBe(pendingApplication.name);
		expect(cells[0]?.querySelector('[data-slot="badge"]')).toBeNull();
		// AP-02：提交时间为 time 元素，dateTime 等于 submittedAt。
		expect(cells[4]?.querySelector("time")?.getAttribute("dateTime")).toBe(
			pendingApplication.submittedAt,
		);
		expect(screen.queryByText("审阅申请")).toBeNull();
		expect(screen.queryByText(/风险/)).toBeNull();
	});

	it("searches visible name, description and Owner display names, filters by source and names every review", async () => {
		render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: queue }}
			/>,
		);
		const search = screen.getByRole("searchbox", { name: "搜索申请" });
		expect(search.getAttribute("placeholder")).toBe("搜索申请名称或 Owner");
		const reviews = screen.getAllByRole("button", { name: /^审阅：/ });
		expect(
			new Set(reviews.map((button) => button.getAttribute("aria-label"))).size,
		).toBe(3);
		const visibleRows = () =>
			within(screen.getByRole("table", { name: "创建审批" }))
				.getAllByRole("row")
				.slice(1)
				.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
		fireEvent.change(search, { target: { value: "乙 Owner" } });
		expect(visibleRows()).toEqual(["申请乙"]);
		fireEvent.change(search, { target: { value: "发布工程协作" } });
		expect(visibleRows()).toEqual(["申请乙"]);
		// Owner 内部 ID 不参与匹配。
		fireEvent.change(search, { target: { value: "user-owner-b" } });
		expect(screen.getByText("没有匹配的申请。")).toBeTruthy();
		fireEvent.change(search, { target: { value: "" } });
		fireEvent.change(screen.getByLabelText("来源"), {
			target: { value: "自定义 Agent" },
		});
		expect(visibleRows()).toEqual(["申请丙"]);
	});

	it("reads directory names once per kind for the whole queue and reuses them in the review", async () => {
		render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: queue }}
			/>,
		);
		const table = screen.getByRole("table", { name: "创建审批" });
		expect(await within(table).findByText("验收用户二")).toBeTruthy();
		expect(within(table).getByText("平台工程")).toBeTruthy();
		expect(table.textContent).not.toContain("user-two");
		expect(table.textContent).not.toContain("org-platform");
		expect(within(table).queryAllByRole("status")).toHaveLength(0);
		const kinds = () =>
			directoryRequests.map((url) => url.searchParams.get("kind")).sort();
		expect(kinds()).toEqual(["organization", "user"]);
		fireEvent.click(screen.getByRole("button", { name: reviewName("申请乙") }));
		const dialog = await screen.findByRole("dialog", { name: "审阅创建申请" });
		expect(within(dialog).getByText("平台工程")).toBeTruthy();
		expect(within(dialog).getByText("研发 / 平台工程")).toBeTruthy();
		expect(dialog.textContent).not.toContain("org-platform");
		expect(kinds()).toEqual(["organization", "user"]);
	});

	it("reviews real projected resource, Owner, model and scope details before approving", async () => {
		const onDecision = vi.fn();
		const application = {
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				availability: [
					{ kind: "organization" as const, organizationId: "org-release" },
				],
				modelOptions: [
					{
						optionId: "model-primary",
						modelId: "release-model",
						displayName: "Release model",
						reasoningLevels: ["high"],
					},
				],
				defaultModelOptionId: "model-primary",
				defaultReasoningLevel: "high",
			},
		};
		render(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [application] }}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "把资源审批做得更快，也更可核对。" }),
		).toBeTruthy();
		// AP-04：先 amber 计数 chip，再 tag「系统管理员 · 只读审计」。
		const heading = screen
			.getByRole("heading", { level: 1 })
			.closest("header") as HTMLElement;
		const badges = [...heading.querySelectorAll('[data-slot="badge"]')];
		expect(badges.map((badge) => badge.textContent)).toEqual([
			"1 项待处理",
			"系统管理员 · 只读审计",
		]);
		expect(badges.map((badge) => badge.getAttribute("data-variant"))).toEqual([
			"chip",
			"tag",
		]);
		expect(badges[0]?.getAttribute("data-tone")).toBe("amber");
		expect(
			screen.getByText(
				"审批只决定平台资源与准入，Connection 授权仍由使用者独立完成。",
			).className,
		).toBe("page-note");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: "批准申请" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		const dialog = await screen.findByRole("dialog", { name: "审阅创建申请" });
		// AP-03：facts 首两行为「申请」「说明」，并保留预设规格与预计资源占用。
		const terms = [...dialog.querySelectorAll("dt")].map(
			(dt) => dt.textContent,
		);
		expect(terms.slice(0, 2)).toEqual(["申请", "说明"]);
		expect(terms).toContain("预设规格");
		expect(terms).toContain("预计资源占用");
		expect(dialog.querySelector("dl")?.className).toBe("review-facts");
		expect(within(dialog).getByText("Small（只读）")).toBeTruthy();
		expect(
			within(dialog).getByText("250m CPU / 512 MiB 内存 / 1 GiB 存储"),
		).toBeTruthy();
		expect(within(dialog).getByText("Applicant")).toBeTruthy();
		// 使用范围显示目录名称，不再显示组织 ID。
		expect(await within(dialog).findByText("发布工程")).toBeTruthy();
		expect(dialog.textContent).not.toContain("org-release");
		// F-02：模型为显示名 + 等宽次要 modelId；默认模型显示选项名；推理强度为中文档位。
		expect(dialog.textContent).not.toContain("Release model（release-model）");
		const model = within(dialog).getByText("release-model");
		expect(model.className).toContain("font-mono");
		expect(model.closest("li")?.textContent).toBe("Release modelrelease-model");
		expect(within(dialog).queryByText("model-primary")).toBeNull();
		expect(dialog.textContent).not.toContain("model-primary");
		expect(within(dialog).getByText("高")).toBeTruthy();
		// AP-03：facts 之后为静态 warn notice「审批判断」，不设 role。
		const notice = within(dialog)
			.getByText("审批判断")
			.closest('[data-slot="alert"]') as HTMLElement;
		expect(notice.getAttribute("data-tone")).toBe("warn");
		expect(notice.getAttribute("role")).toBeNull();
		// footer 依次为「驳回并说明」「批准申请」，没有「取消」「批准并创建」。
		const footer = dialog.querySelector('[data-slot="dialog-footer"]');
		expect(
			[...(footer?.querySelectorAll("button") ?? [])].map(
				(button) => button.textContent,
			),
		).toEqual(["驳回并说明", "批准申请"]);
		for (const name of ["取消", "批准并创建", "驳回"])
			expect(within(dialog).queryByRole("button", { name })).toBeNull();
		expect(within(dialog).queryByRole("textbox")).toBeNull();
		expect(onDecision).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "批准申请" }));
		expect(onDecision).toHaveBeenCalledExactlyOnceWith(
			application.applicationId,
			{ decision: "approve" },
		);
	});

	it("opens the review with focus on the dialog container, never on a decision button", async () => {
		const onDecision = vi.fn();
		render(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		const dialog = await screen.findByRole("dialog", { name: "审阅创建申请" });
		await waitFor(() => expect(document.activeElement).toBe(dialog));
		expect(document.activeElement?.tagName).not.toBe("BUTTON");
		const approve = within(dialog).getByRole("button", { name: "批准申请" });
		expect(approve.hasAttribute("autofocus")).toBe(false);
		fireEvent.keyDown(dialog, { key: "Enter" });
		fireEvent.keyDown(dialog, { key: " " });
		expect(onDecision).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("requires and focuses a meaningful rejection reason, then submits its trimmed value", async () => {
		const onDecision = vi.fn();
		render(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "驳回并说明" }));
		// G-05：切到「填写驳回原因」，焦点在弹窗容器。
		expect(
			within(dialog).getByRole("heading", { name: "填写驳回原因" }),
		).toBeTruthy();
		await waitFor(() => expect(document.activeElement).toBe(dialog));
		const reason = within(dialog).getByLabelText("驳回原因");
		expect(reason.getAttribute("placeholder")).toBe(
			"说明需要修改的范围、模型或渠道",
		);
		const footer = dialog.querySelector('[data-slot="dialog-footer"]');
		expect(
			[...(footer?.querySelectorAll("button") ?? [])].map(
				(button) => button.textContent,
			),
		).toEqual(["取消", "确认驳回"]);
		fireEvent.change(reason, { target: { value: "   " } });
		fireEvent.click(within(dialog).getByRole("button", { name: "确认驳回" }));
		expect(onDecision).not.toHaveBeenCalled();
		const error = within(dialog).getByRole("alert");
		expect(error.textContent).toBe("请填写驳回原因。");
		expect(error.getAttribute("data-slot")).toBe("field-error");
		expect(reason.getAttribute("aria-invalid")).toBe("true");
		expect(reason.getAttribute("aria-describedby")).toBe(error.id);
		expect(document.activeElement).toBe(reason);
		expect(screen.queryByText("请输入驳回原因。")).toBeNull();
		fireEvent.change(reason, { target: { value: "  请补充使用范围。  " } });
		fireEvent.click(within(dialog).getByRole("button", { name: "确认驳回" }));
		expect(onDecision).toHaveBeenCalledExactlyOnceWith(
			pendingApplication.applicationId,
			{ decision: "reject", reason: "请补充使用范围。" },
		);
	});

	it("cancels the rejection without a request and returns focus to the row's review button", async () => {
		const onDecision = vi.fn();
		render(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		const review = screen.getByRole("button", { name: reviewName() });
		fireEvent.click(review);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "驳回并说明" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(review));
		expect(onDecision).not.toHaveBeenCalled();
	});

	it("blocks repeat decisions while pending and focuses the page heading after the last application is decided", async () => {
		const onDecision = vi.fn();
		const props = {
			onDecision,
			session: { kind: "ready" as const, session: administratorSession },
			state: { kind: "ready" as const, applications: [pendingApplication] },
		};
		const { rerender } = render(<AdminAgentApplicationsScreen {...props} />);
		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "批准申请" }));
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				pendingDecision={{
					applicationId: pendingApplication.applicationId,
					decision: { decision: "approve" },
				}}
			/>,
		);
		const approve = screen.getByRole("button", { name: "批准中…" });
		expect(approve.getAttribute("disabled")).not.toBeNull();
		expect(
			screen
				.getByRole("button", { name: "驳回并说明" })
				.getAttribute("disabled"),
		).not.toBeNull();
		expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
		fireEvent.click(approve);
		expect(onDecision).toHaveBeenCalledTimes(1);
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				decisionResult={{
					...pendingApplication,
					agentId: "agent-pilot-1",
					status: "creating",
				}}
			/>,
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// 队列只剩这一条时，焦点落到页面 h1，而不是 Toast 或 body。
		const heading = screen.getByRole("heading", { level: 1 });
		await waitFor(() => expect(document.activeElement).toBe(heading));
		expect(toastText()).toBe("申请已批准，创建任务已进入后台");
	});

	it("moves focus to the next review after a decided application leaves the queue and keeps it past the toast", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const onDecision = vi.fn();
		const props = {
			onDecision,
			session: { kind: "ready" as const, session: administratorSession },
		};
		const { rerender } = render(
			<AdminAgentApplicationsScreen
				{...props}
				state={{ kind: "ready", applications: queue }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: reviewName("申请甲") }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "批准申请" }));
		const pending = {
			applicationId: "application-a",
			decision: { decision: "approve" as const },
		};
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				pendingDecision={pending}
				state={{ kind: "ready", applications: queue }}
			/>,
		);
		// 决定的 onSuccess 先重取队列：该行在结果返回前已被移除。
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				pendingDecision={pending}
				state={{ kind: "ready", applications: queue.slice(1) }}
			/>,
		);
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				decisionResult={{ ...queue[0], agentId: "agent-a", status: "creating" }}
				state={{ kind: "ready", applications: queue.slice(1) }}
			/>,
		);
		const next = screen.getByRole("button", { name: reviewName("申请乙") });
		await waitFor(() => expect(document.activeElement).toBe(next));
		expect(toastText()).toBe("申请已批准，创建任务已进入后台");
		// 越过 Toast 2.6s 与 .18s 退场后再断言：焦点仍在下一条「审阅」，Toast 已清空。
		for (const step of [1_200, 1_800]) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(step);
			});
			expect(document.activeElement).toBe(next);
		}
		expect(toastText()).toBe("");
		expect(
			document
				.querySelector('[data-slot="toast"]')
				?.querySelector("[tabindex]"),
		).toBeNull();
		expect(screen.queryByText(/已提交 .* 的审批结果/)).toBeNull();
	});

	it("latches a decision before the parent rerenders and releases on error", async () => {
		const onDecision = vi.fn();
		const props = {
			onDecision,
			session: { kind: "ready" as const, session: administratorSession },
			state: { kind: "ready" as const, applications: [pendingApplication] },
		};
		const { rerender } = render(<AdminAgentApplicationsScreen {...props} />);
		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		await screen.findByRole("dialog");
		const approve = screen.getByRole("button", { name: "批准申请" });
		fireEvent.click(approve);
		fireEvent.click(approve);
		expect(onDecision).toHaveBeenCalledTimes(1);

		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				decisionError={Object.assign(new Error(), { retryable: true })}
			/>,
		);
		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "批准申请" })
					.getAttribute("disabled"),
			).toBeNull(),
		);
		fireEvent.click(screen.getByRole("button", { name: "批准申请" }));
		expect(onDecision).toHaveBeenCalledTimes(2);
	});

	it("removes an open review if the session loses administrator access", async () => {
		const onDecision = vi.fn();
		const { rerender } = render(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		await screen.findByRole("dialog");
		rerender(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: ordinaryUserSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: "批准申请" })).toBeNull();
		expect(onDecision).not.toHaveBeenCalled();
	});

	it("does not render application data or controls for an ordinary-user projection", () => {
		render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				session={{ kind: "ready", session: ordinaryUserSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);

		// 无权访问是首屏静态边界，不再用 role="alert" 打断读屏。
		expect(screen.getByText("当前无法访问审批。")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText("Release assistant request")).toBeNull();
		expect(screen.queryByRole("button", { name: "批准申请" })).toBeNull();
	});

	it("announces processing on the row and terminal decisions once through the toast", () => {
		const approvedApplication = {
			...pendingApplication,
			agentId: "agent-pilot-1",
			status: "creating" as const,
			decision: {
				decidedAt: "2026-09-04T08:00:00Z",
				reason: null,
			},
		};
		const { rerender } = render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				pendingDecision={{
					applicationId: pendingApplication.applicationId,
					decision: { decision: "approve" },
				}}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: `审批提交中…：${pendingApplication.name}`,
			}),
		).toBeTruthy();

		rerender(
			<AdminAgentApplicationsScreen
				decisionResult={approvedApplication}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [] }}
			/>,
		);
		expect(toastText()).toBe("申请已批准，创建任务已进入后台");
		expect(screen.getByText("暂无待审批申请。")).toBeTruthy();
		// 空队列仍显示 page-note。
		expect(
			screen.getByText(
				"审批只决定平台资源与准入，Connection 授权仍由使用者独立完成。",
			),
		).toBeTruthy();

		rerender(
			<AdminAgentApplicationsScreen
				decisionResult={approvedApplication}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "unavailable", retryable: true }}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"审批列表暂时无法读取，请稍后重试。",
		);
		// 读取失败时不显示 page-note、计数 chip 与 tag。
		expect(screen.queryByText(/Connection 授权仍由使用者独立完成/)).toBeNull();
		expect(screen.queryByText(/项待处理/)).toBeNull();
		expect(screen.queryByText("系统管理员 · 只读审计")).toBeNull();

		rerender(
			<AdminAgentApplicationsScreen
				decisionResult={{ ...pendingApplication, status: "rejected" }}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [] }}
			/>,
		);
		expect(toastText()).toBe("已驳回，申请人会看到修改原因");
	});

	it("shows neither the page note nor heading tags while loading", () => {
		render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "loading" }}
			/>,
		);
		expect(screen.getByText("正在读取审批申请…")).toBeTruthy();
		expect(screen.queryByText(/Connection 授权仍由使用者独立完成/)).toBeNull();
		expect(screen.queryByText(/项待处理/)).toBeNull();
	});

	it("distinguishes retryable and permission-lost decision failures", () => {
		const { rerender } = render(
			<AdminAgentApplicationsScreen
				decisionError={Object.assign(new Error(), { retryable: false })}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [] }}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe(
			"权限或申请状态已变化，请刷新页面。",
		);

		rerender(
			<AdminAgentApplicationsScreen
				decisionError={Object.assign(new Error(), { retryable: true })}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [] }}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"审批未能提交，请稍后重试。",
		);
	});

	it("offers a keyboard reachable retry while the pending queue is unavailable", () => {
		const onRetry = vi.fn();
		const { rerender } = render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				onRetry={onRetry}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "unavailable", retryable: true }}
			/>,
		);

		const retry = screen.getByRole("button", { name: "重新加载审批" });
		expect(retry.getAttribute("type")).toBe("button");
		fireEvent.click(retry);
		expect(onRetry).toHaveBeenCalledTimes(1);

		rerender(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				onRetry={onRetry}
				retrying
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "unavailable", retryable: true }}
			/>,
		);
		const pendingRetry = screen.getByRole("button", { name: "正在重试…" });
		expect(pendingRetry.getAttribute("disabled")).not.toBeNull();
	});

	it("renders a decision error only once while a review dialog is open", async () => {
		render(
			<AdminAgentApplicationsScreen
				decisionError={Object.assign(new Error(), { retryable: true })}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
	});

	it("restores page-level decision feedback after a programmatic close", async () => {
		const props = {
			decisionError: Object.assign(new Error(), { retryable: true }),
			onDecision: vi.fn(),
			session: { kind: "ready" as const, session: administratorSession },
			state: { kind: "ready" as const, applications: [pendingApplication] },
		};
		const { rerender } = render(<AdminAgentApplicationsScreen {...props} />);

		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		const dialog = await screen.findByRole("dialog");
		// 审阅视图按设计没有「取消」，用标题行的关闭钮关闭。
		fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(screen.getAllByRole("alert")).toHaveLength(1);
		});

		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		await screen.findByRole("dialog");
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				decisionResult={{
					...pendingApplication,
					agentId: "agent-pilot-1",
					status: "creating",
				}}
			/>,
		);
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(screen.getAllByRole("alert")).toHaveLength(1);
		});
	});

	it("clears dialog ownership when the open application is unmounted", async () => {
		const props = {
			decisionError: Object.assign(new Error(), { retryable: true }),
			onDecision: vi.fn(),
			session: { kind: "ready" as const, session: administratorSession },
			state: { kind: "ready" as const, applications: [pendingApplication] },
		};
		const { rerender } = render(<AdminAgentApplicationsScreen {...props} />);

		fireEvent.click(screen.getByRole("button", { name: reviewName() }));
		await screen.findByRole("dialog");
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				session={{ kind: "ready", session: ordinaryUserSession }}
				state={{ kind: "ready", applications: [] }}
			/>,
		);
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				state={{ kind: "ready", applications: [] }}
			/>,
		);

		await waitFor(() => {
			expect(screen.getAllByRole("alert")).toHaveLength(1);
			expect(screen.getByRole("alert").textContent).toBe(
				"审批未能提交，请稍后重试。",
			);
		});
	});
});
