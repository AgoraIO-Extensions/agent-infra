import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
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
import { client as generatedClient } from "../../pilot/generated-v2/client.gen.js";
import { commandAgentLifecycle } from "../agent-administration/agent-administration.js";
import {
	directoryRequestUrl,
	directorySearchResponse,
} from "../directory-test-fixtures.js";
import {
	AdminAgentsScreen,
	adminAgentStatuses,
	validateAdminAgentSearch,
} from "./admin-agents-screen.js";

vi.mock("@tanstack/react-router", async () => {
	const { forwardRef } = await import("react");
	return {
		Link: forwardRef<
			HTMLAnchorElement,
			{ to: string; params?: unknown; children: ReactNode }
		>(({ to, params: _params, children, ...props }, ref) => (
			<a ref={ref} href={to} {...props}>
				{children}
			</a>
		)),
	};
});
vi.mock("../agent-administration/agent-administration.js", () => ({
	commandAgentLifecycle: vi.fn(),
}));

// 目录 fixture：可用范围显示名称，不显示内部 ID。
const directoryRecords = [
	{
		kind: "organization",
		canonicalId: "org-platform",
		displayName: "平台工程",
		organizationPath: "研发 / 平台工程",
	},
	{
		kind: "user",
		canonicalId: "user-two",
		displayName: "验收用户二",
		email: "user.two@example.test",
	},
];
const directoryRequests: URL[] = [];
beforeEach(() => {
	// 生成 Client 默认使用相对地址；jsdom 下的 Request 需要绝对地址。
	generatedClient.setConfig({ baseUrl: "https://platform.test" });
	directoryRequests.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = directoryRequestUrl(input);
			directoryRequests.push(url);
			const ids = url.searchParams.get("ids")?.split(",") ?? [];
			return Response.json(
				directorySearchResponse(
					url,
					directoryRecords.filter(
						(item) =>
							item.kind === url.searchParams.get("kind") &&
							ids.includes(item.canonicalId),
					),
				),
			);
		}),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	vi.useRealTimers();
});
function render(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<ToastProvider>{children}</ToastProvider>
		</QueryClientProvider>
	);
	return renderView(ui, { wrapper });
}

const baseline = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const agents = Array.from({ length: 12 }, (_, index) =>
	AgentProjectionV2Schema.parse({
		...baseline,
		agentId: `admin-agent-${index}`,
		name: `Agent ${index}`,
		description: `说明 ${index}`,
		managementStatus: index === 11 ? "disabled" : "available",
		serviceAvailability: index === 11 ? null : "ready",
		source:
			index % 2
				? {
						kind: "custom",
						interactionMode: "platform-adapter",
						imageReference: "registry.example.test/agent:1",
					}
				: baseline.source,
		configuration: {
			...baseline.configuration,
			owners: [
				{
					userId: index === 11 ? "owner-late" : "someone-else",
					displayName: index === 11 ? "较后 Owner" : "其他 Owner",
					roles: ["employee"],
				},
			],
		},
	}),
);
const noop = { onFiltersChange: vi.fn(), onRefresh: vi.fn() };

describe("Administrator inventory presentation", () => {
	it("restores controlled search/status and searches Owner display names across the complete collection", () => {
		const change = vi.fn();
		const view = render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents }}
				filters={{ q: "较后 Owner", status: "disabled", page: 2 }}
				onFiltersChange={change}
				onRefresh={vi.fn()}
			/>,
		);
		expect(screen.getByText("Agent 11")).toBeTruthy();
		expect(screen.queryByText("Agent 0")).toBeNull();
		expect(screen.getByText("第 1 / 1 页")).toBeTruthy();
		const search = screen.getByRole("searchbox", { name: "搜索 Agent" });
		expect((search as HTMLInputElement).value).toBe("较后 Owner");
		expect(search.getAttribute("placeholder")).toBe("搜索 Agent、Owner 或来源");
		// 筛选结果只用 sr-only 的 status 播报，总数在页头 chip，且不随筛选变化。
		expect(screen.getByText("匹配 1 个").getAttribute("role")).toBe("status");
		expect(screen.getByText("12 个 Agent")).toBeTruthy();
		fireEvent.change(search, { target: { value: "说明" } });
		expect(change).toHaveBeenLastCalledWith({
			q: "说明",
			status: "disabled",
			page: undefined,
		});
		view.rerender(
			<AdminAgentsScreen
				state={{ kind: "ready", agents }}
				filters={{ page: 2 }}
				onFiltersChange={change}
				onRefresh={vi.fn()}
			/>,
		);
		expect(screen.getByText("Agent 10")).toBeTruthy();
		expect(screen.queryByText("Agent 0")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "上一页" }));
		expect(change).toHaveBeenLastCalledWith({ page: 1 });
		// Owner 内部标识不参与匹配，也不出现在表格中。
		view.rerender(
			<AdminAgentsScreen
				state={{ kind: "ready", agents }}
				filters={{ q: "owner-late" }}
				onFiltersChange={change}
				onRefresh={vi.fn()}
			/>,
		);
		expect(screen.getByText("未找到匹配的 Agent。")).toBeTruthy();
	});

	it("filters by source, resets the page and keeps the design filter order", () => {
		const change = vi.fn();
		render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents }}
				filters={{ source: "custom", page: 2 }}
				onFiltersChange={change}
				onRefresh={vi.fn()}
			/>,
		);
		const table = screen.getByRole("table", { name: "已创建 Agent" });
		const rows = within(table).getAllByRole("row").slice(1);
		expect(rows).toHaveLength(6);
		// 设计 #admin-agents：自定义来源单元格写「自定义镜像」，不写镜像地址。
		for (const row of rows) {
			const cell = row.querySelector('[data-label="来源"]');
			expect(cell?.textContent).toBe("自定义镜像");
			expect(row.textContent).not.toContain("registry.example.test");
		}
		const filters = document.querySelector(".admin-agent-filters");
		expect(
			[...(filters?.children ?? [])].map(
				(child) =>
					child.querySelector("label")?.textContent ??
					child.getAttribute("data-slot"),
			),
		).toEqual(["搜索 Agent", "运行状态", "来源"]);
		const source = screen.getByLabelText("来源") as HTMLSelectElement;
		expect([...source.options].map((option) => option.text)).toEqual([
			"全部来源",
			"标准模板",
			"自定义镜像",
		]);
		fireEvent.change(source, { target: { value: "standard" } });
		expect(change).toHaveBeenLastCalledWith({
			source: "standard",
			page: undefined,
		});
		fireEvent.change(source, { target: { value: "all" } });
		expect(change).toHaveBeenLastCalledWith({
			source: undefined,
			page: undefined,
		});
	});

	it("writes the template display name in the source cell and falls back to 标准模板", () => {
		const standard = agents.slice(0, 1);
		const view = render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents: standard }}
				filters={{}}
				templateName={() => "Codex"}
				{...noop}
			/>,
		);
		const cell = () =>
			screen
				.getByRole("table", { name: "已创建 Agent" })
				.querySelector('tbody [data-label="来源"]');
		// 设计 #admin-agents：标准模板单元格只写模板显示名，不加「标准模板 · 」前缀。
		expect(cell()?.textContent).toBe("Codex");
		view.rerender(
			<AdminAgentsScreen
				state={{ kind: "ready", agents: standard }}
				filters={{}}
				{...noop}
			/>,
		);
		expect(cell()?.textContent).toBe("标准模板");
	});

	it("renders design columns, one status chip, Owner names and configure/retry row actions", async () => {
		const states = adminAgentStatuses.map((managementStatus) =>
			AgentProjectionV2Schema.parse({
				...baseline,
				agentId: managementStatus,
				name: `Agent ${managementStatus}`,
				managementStatus,
				serviceAvailability:
					managementStatus === "available" ? "starting" : null,
				configuration: {
					...baseline.configuration,
					availability:
						managementStatus === "stopped"
							? []
							: [
									{ kind: "organization", organizationId: "org-platform" },
									{ kind: "user", userId: "user-two" },
								],
				},
			}),
		);
		render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents: states }}
				filters={{}}
				{...noop}
			/>,
		);
		const table = screen.getByRole("table", { name: "已创建 Agent" });
		const headers = within(table)
			.getAllByRole("columnheader")
			.map((cell) => cell.textContent);
		expect(headers).toEqual([
			"Agent",
			"Owner",
			"来源",
			"状态",
			"可用范围",
			"操作",
		]);
		const rows = within(table).getAllByRole("row").slice(1);
		for (const row of rows) {
			const cells = within(row).getAllByRole("cell");
			expect(cells.map((cell) => cell.getAttribute("data-label"))).toEqual([
				...headers.slice(0, 5),
				null,
			]);
			expect(cells.at(-1)?.getAttribute("data-cell")).toBe("actions");
			expect(cells[3]?.querySelectorAll('[data-slot="badge"]')).toHaveLength(1);
		}
		expect(table.textContent).not.toContain("服务：");
		// 可用：服务可用性 starting 显示 amber「启动中」；其余显示管理状态。
		const chip = (status: string) =>
			within(screen.getByRole("row", { name: new RegExp(`Agent ${status}`) }))
				.getAllByRole("cell")[3]
				?.querySelector('[data-slot="badge"]');
		expect(chip("available")?.textContent).toBe("启动中");
		expect(chip("available")?.getAttribute("data-tone")).toBe("amber");
		expect(chip("creation_failed")?.textContent).toBe("创建失败");
		expect(chip("creation_failed")?.getAttribute("data-tone")).toBe("red");
		expect(chip("stopped")?.textContent).toBe("已停止");
		// F-01：Owner 只显示姓名，不出现 userId。
		expect(table.textContent).not.toContain("user-owner-1");
		expect(
			within(rows[0] as HTMLElement).getAllByRole("cell")[1]?.textContent,
		).toBe("Owner");
		// 可用范围显示目录名称，没有额外范围时为「未额外指定」。
		expect(await within(table).findAllByText("平台工程")).toHaveLength(4);
		expect(within(table).getAllByText("验收用户二")).toHaveLength(4);
		expect(within(table).getByText("未额外指定")).toBeTruthy();
		expect(table.textContent).not.toContain("org-platform");
		expect(table.textContent).not.toContain("user-two");
		expect(within(table).queryAllByRole("status")).toHaveLength(0);
		expect(
			directoryRequests.map((url) => url.searchParams.get("kind")).sort(),
		).toEqual(["organization", "user"]);
		// 行操作：非停用行一个 ghost「配置」，只有创建失败行有「重试」。
		const configure = screen.getAllByRole("link", { name: /^配置：/ });
		expect(configure.map((link) => link.getAttribute("aria-label"))).toEqual([
			"配置：Agent creating",
			"配置：Agent available",
			"配置：Agent stopped",
			"配置：Agent creation_failed",
		]);
		for (const link of configure) {
			expect(link.getAttribute("href")).toBe("/agents/$agentId/configuration");
			expect(link.querySelector("svg")).toBeTruthy();
		}
		expect(screen.getAllByRole("button", { name: /^重试/ })).toHaveLength(1);
		expect(
			screen.getByRole("button", { name: "重试：Agent creation_failed" }),
		).toBeTruthy();
		// 管理员停用（#3033）：服务端允许停用的四种状态各一个「停用」，排在行操作最后。
		const disable = screen.getAllByRole("button", { name: /^停用：/ });
		expect(disable.map((button) => button.getAttribute("aria-label"))).toEqual([
			"停用：Agent creating",
			"停用：Agent available",
			"停用：Agent stopped",
			"停用：Agent creation_failed",
		]);
		for (const button of disable) {
			expect(button.closest(".admin-agent-row-actions")?.lastElementChild).toBe(
				button,
			);
			expect(button.querySelector("svg")).toBeTruthy();
		}
		const disabledRow = screen.getByRole("row", { name: /Agent disabled/ });
		expect(within(disabledRow).queryByRole("link")).toBeNull();
		expect(within(disabledRow).queryByRole("button")).toBeNull();
		expect(within(disabledRow).getAllByRole("cell").at(-1)?.textContent).toBe(
			"—",
		);
		expect(screen.queryByText("处理 Owner 交接")).toBeNull();
		expect(screen.queryByLabelText("Owner 交接入口")).toBeNull();
		expect(screen.queryByRole("link", { name: "创建审批" })).toBeNull();
		for (const name of ["停用", "查看详情", "开始对话"])
			expect(screen.queryByRole("button", { name })).toBeNull();
	});

	it("retries a failed creation once, then moves focus to the same row's configure link", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const failed = AgentProjectionV2Schema.parse({
			...baseline,
			agentId: "agent-failed",
			name: "失败的 Agent",
			managementStatus: "creation_failed",
			serviceAvailability: null,
		});
		type Result = Awaited<ReturnType<typeof commandAgentLifecycle>>;
		let settle: (value: Result) => void = () => undefined;
		vi.mocked(commandAgentLifecycle).mockImplementationOnce(
			() =>
				new Promise<Result>((resolve) => {
					settle = resolve;
				}),
		);
		const onRefresh = vi.fn();
		render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents: [failed] }}
				filters={{}}
				onFiltersChange={vi.fn()}
				onRefresh={onRefresh}
			/>,
		);
		const retry = screen.getByRole("button", { name: "重试：失败的 Agent" });
		retry.focus();
		fireEvent.click(retry);
		const pending = screen.getByRole("button", {
			name: "重试中…：失败的 Agent",
		});
		expect(pending.hasAttribute("disabled")).toBe(true);
		fireEvent.click(pending);
		await waitFor(() => expect(commandAgentLifecycle).toHaveBeenCalled());
		expect(commandAgentLifecycle).toHaveBeenCalledExactlyOnceWith(
			"agent-failed",
			"retry_creation",
			expect.any(String),
		);
		await act(async () => {
			settle({ ...failed, managementStatus: "creating" });
		});
		const configure = screen.getByRole("link", { name: "配置：失败的 Agent" });
		await waitFor(() => expect(document.activeElement).toBe(configure));
		expect(screen.queryByRole("button", { name: /^重试/ })).toBeNull();
		expect(onRefresh).toHaveBeenCalledOnce();
		const toast = document.querySelector('[data-slot="toast"]');
		expect(toast?.textContent).toBe("已提交重试，创建状态会在后台更新");
		// 越过 Toast 2.6s 与 .18s 退场后，焦点仍在同行「配置」，不落到 body。
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_900);
		});
		expect(toast?.textContent).toBe("");
		expect(document.activeElement).toBe(configure);
	});

	it("keeps focus on retry and shows one alert when the retry cannot be submitted", async () => {
		const failed = AgentProjectionV2Schema.parse({
			...baseline,
			agentId: "agent-failed",
			name: "失败的 Agent",
			managementStatus: "creation_failed",
			serviceAvailability: null,
		});
		vi.mocked(commandAgentLifecycle)
			.mockRejectedValueOnce(Object.assign(new Error(), { retryable: true }))
			.mockResolvedValueOnce({ ...failed, managementStatus: "creating" });
		render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents: [failed] }}
				filters={{}}
				{...noop}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "重试：失败的 Agent" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("操作未能提交，请稍后重试。");
		const retry = screen.getByRole("button", { name: "重试：失败的 Agent" });
		await waitFor(() => expect(document.activeElement).toBe(retry));
		fireEvent.click(retry);
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(commandAgentLifecycle).toHaveBeenCalledTimes(2);
	});

	it("disables an Agent only after confirmation, then refreshes and moves focus to the heading (#3033)", async () => {
		const available = AgentProjectionV2Schema.parse({
			...baseline,
			agentId: "agent-out-of-scope",
			name: "范围外的 Agent",
			managementStatus: "available",
			serviceAvailability: "ready",
		});
		type Result = Awaited<ReturnType<typeof commandAgentLifecycle>>;
		let settle: (value: Result) => void = () => undefined;
		vi.mocked(commandAgentLifecycle).mockImplementationOnce(
			() =>
				new Promise<Result>((resolve) => {
					settle = resolve;
				}),
		);
		const onRefresh = vi.fn();
		render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents: [available] }}
				filters={{}}
				onFiltersChange={vi.fn()}
				onRefresh={onRefresh}
			/>,
		);
		const trigger = screen.getByRole("button", {
			name: "停用：范围外的 Agent",
		});
		fireEvent.click(trigger);
		let dialog = await screen.findByRole("dialog", { name: "停用 Agent？" });
		expect(dialog.textContent).toContain("范围外的 Agent");
		expect(dialog.textContent).toContain("Owner 不能恢复");
		// 取消不发请求。
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(commandAgentLifecycle).not.toHaveBeenCalled();

		fireEvent.click(trigger);
		dialog = await screen.findByRole("dialog", { name: "停用 Agent？" });
		fireEvent.click(within(dialog).getByRole("button", { name: "确认停用" }));
		await waitFor(() =>
			expect(commandAgentLifecycle).toHaveBeenCalledExactlyOnceWith(
				"agent-out-of-scope",
				"disable",
				expect.any(String),
			),
		);
		const pending = await screen.findByRole("button", {
			name: "停用中…：范围外的 Agent",
		});
		expect(pending.hasAttribute("disabled")).toBe(true);
		expect(onRefresh).not.toHaveBeenCalled();
		await act(async () => {
			settle({
				...available,
				managementStatus: "disabled",
				serviceAvailability: null,
			});
		});
		// 该行重新读取后不再有操作：焦点交给页面标题，不落到 body。
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { level: 1 }),
			),
		);
		expect(screen.queryByRole("button", { name: /^停用/ })).toBeNull();
		expect(onRefresh).toHaveBeenCalledOnce();
		expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe(
			"已提交停用请求",
		);
	});

	it("keeps focus on disable and shows one alert when the disable cannot be submitted", async () => {
		const stopped = AgentProjectionV2Schema.parse({
			...baseline,
			agentId: "agent-stopped",
			name: "已停止的 Agent",
			managementStatus: "stopped",
			serviceAvailability: null,
		});
		vi.mocked(commandAgentLifecycle).mockRejectedValueOnce(
			Object.assign(new Error(), { retryable: false }),
		);
		const onRefresh = vi.fn();
		render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents: [stopped] }}
				filters={{}}
				onFiltersChange={vi.fn()}
				onRefresh={onRefresh}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "停用：已停止的 Agent" }),
		);
		const dialog = await screen.findByRole("dialog", { name: "停用 Agent？" });
		fireEvent.click(within(dialog).getByRole("button", { name: "确认停用" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("权限或 Agent 状态已变化，请刷新页面。");
		const trigger = screen.getByRole("button", {
			name: "停用：已停止的 Agent",
		});
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(trigger.hasAttribute("disabled")).toBe(false);
		expect(onRefresh).not.toHaveBeenCalled();
		expect(
			document.querySelector('[data-slot="toast"]')?.textContent ?? "",
		).toBe("");
	});

	it("shares one lifecycle command per row: a pending retry blocks disable", async () => {
		const failed = AgentProjectionV2Schema.parse({
			...baseline,
			agentId: "agent-failed",
			name: "失败的 Agent",
			managementStatus: "creation_failed",
			serviceAvailability: null,
		});
		vi.mocked(commandAgentLifecycle).mockImplementationOnce(
			() => new Promise(() => undefined),
		);
		render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents: [failed] }}
				filters={{}}
				{...noop}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "重试：失败的 Agent" }));
		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "停用：失败的 Agent" })
					.hasAttribute("disabled"),
			).toBe(true),
		);
		fireEvent.click(screen.getByRole("button", { name: "停用：失败的 Agent" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(commandAgentLifecycle).toHaveBeenCalledExactlyOnceWith(
			"agent-failed",
			"retry_creation",
			expect.any(String),
		);
	});

	it("collapses every section except the heading and one alert when the list fails", () => {
		const props = { filters: {}, onFiltersChange: vi.fn(), onRefresh: vi.fn() };
		const view = render(
			<AdminAgentsScreen {...props} state={{ kind: "ready", agents }} />,
		);
		view.rerender(
			<AdminAgentsScreen
				{...props}
				state={{ kind: "error", retryable: true }}
			/>,
		);
		const section = screen.getByRole("region", {
			name: "查看 Agent 状态",
		});
		expect(within(section).getByRole("alert").textContent).toBe(
			"暂时无法读取 Agent 列表，请稍后重试。重新加载",
		);
		expect(within(section).getAllByRole("button")).toHaveLength(1);
		for (const hidden of ["table", "searchbox", "navigation"])
			expect(within(section).queryByRole(hidden)).toBeNull();
		expect(within(section).queryAllByRole("status")).toHaveLength(0);
		expect(within(section).queryByText("员工访问控制")).toBeNull();
		expect(within(section).queryByText("应用凭证材料授权")).toBeNull();
		expect(within(section).queryByText(/个 Agent$/)).toBeNull();
		fireEvent.click(within(section).getByRole("button", { name: "重新加载" }));
		expect(props.onRefresh).toHaveBeenCalledOnce();
		view.rerender(
			<AdminAgentsScreen
				{...props}
				state={{ kind: "error", retryable: false }}
			/>,
		);
		expect(within(section).getByRole("alert").textContent).toBe(
			"暂时无法访问此列表，请联系管理员。",
		);
		expect(within(section).queryAllByRole("button")).toHaveLength(0);
		view.rerender(<AdminAgentsScreen {...props} state={{ kind: "denied" }} />);
		expect(screen.getByText("当前无权访问 Agent 管理。")).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
		view.rerender(<AdminAgentsScreen {...props} state={{ kind: "loading" }} />);
		// 需求变化（#3235 I6-01）：读取中改为可聚焦的禁用（aria-disabled），不再用原生 disabled，
		// 否则获得焦点的按钮被禁用后焦点落到 body。
		const loadingRefresh = screen.getByRole("button", {
			name: "刷新 Agent 列表",
		});
		expect(loadingRefresh.getAttribute("aria-disabled")).toBe("true");
		expect(loadingRefresh.hasAttribute("disabled")).toBe(false);
		fireEvent.click(loadingRefresh);
		// 读取中的点击被忽略：onRefresh 仍只有上面「重新加载」那一次。
		expect(props.onRefresh).toHaveBeenCalledOnce();
		expect(screen.queryByText(/个 Agent$/)).toBeNull();
		view.rerender(
			<AdminAgentsScreen {...props} state={{ kind: "ready", agents: [] }} />,
		);
		expect(screen.getByText("暂无已创建的 Agent。")).toBeTruthy();
		view.rerender(
			<AdminAgentsScreen
				{...props}
				filters={{ q: "nothing" }}
				state={{ kind: "ready", agents }}
			/>,
		);
		expect(screen.getByText("未找到匹配的 Agent。")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
		expect(props.onFiltersChange).toHaveBeenCalledWith({});
	});

	it("orders the page as heading, filters, table, pagination and then governance", () => {
		render(
			<AdminAgentsScreen
				state={{ kind: "ready", agents }}
				filters={{}}
				{...noop}
			/>,
		);
		const section = screen.getByRole("region", {
			name: "查看 Agent 状态",
		});
		const order = [
			section.querySelector("header.page-heading"),
			section.querySelector(".admin-agent-filters"),
			screen.getByRole("table", { name: "已创建 Agent" }),
			screen.getByRole("navigation", { name: "Agent 列表分页" }),
			screen.getByRole("region", { name: "员工访问控制" }),
			screen.getByRole("region", { name: "应用凭证材料授权" }),
		];
		for (const [index, node] of order.slice(1).entries())
			expect(
				(order[index] as Node).compareDocumentPosition(node as Node) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		expect(section.querySelector(".admin-agent-summary")).toBeNull();
		const refresh = screen.getByRole("button", { name: "刷新 Agent 列表" });
		expect(refresh.closest("header")).toBe(order[0]);
		fireEvent.click(refresh);
		expect(noop.onRefresh).toHaveBeenCalled();
	});

	it("bounds URL values and rejects application statuses, unknown sources and malformed pagination", () => {
		expect(
			validateAdminAgentSearch({
				q: "中文",
				status: "available",
				source: "custom",
				page: "2",
			}),
		).toEqual({ q: "中文", status: "available", source: "custom", page: 2 });
		for (const page of [0, -1, 1.5, 1001, Number.POSITIVE_INFINITY, {}, "oops"])
			expect(
				validateAdminAgentSearch({
					q: "x".repeat(257),
					status: "pending_approval",
					source: "foo",
					page,
				}),
			).toEqual({
				q: undefined,
				status: undefined,
				source: undefined,
				page: undefined,
			});
	});
});
