import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
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
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { AgentConfigurationScreen } from "./agent-configuration/agent-configuration-screen.js";
import { AgentDetailScreen } from "./agent-discovery/agent-detail-screen.js";
import { renderWithAgentRouter } from "./agent-discovery/test-router.js";
import {
	DirectoryPicker,
	DirectoryRecords,
	type DirectorySelection,
} from "./directory-fields.js";

function render(element: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	// 配置页的企微卡片与镜像升级会调用 Toast，页面在根布局的 ToastProvider 内渲染。
	const result = renderView(
		<QueryClientProvider client={client}>
			<ToastProvider>{element}</ToastProvider>
		</QueryClientProvider>,
	);
	return {
		...result,
		rerender(element: ReactElement) {
			result.rerender(
				<QueryClientProvider client={client}>
					<ToastProvider>{element}</ToastProvider>
				</QueryClientProvider>,
			);
		},
	};
}

const agent = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	configuration: {
		...pilotFakeScenariosV2.starting.response.body.configuration,
		availability: [
			{ kind: "user", userId: "user-2" },
			{ kind: "organization", organizationId: "org-1" },
		],
	},
});
const session = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: { userId: "user-owner-1", displayName: "Owner", roles: ["employee"] },
});
const items = [
	{
		kind: "user",
		canonicalId: "user-owner-1",
		displayName: "Current Owner",
		email: "owner@example.test",
	},
	{
		kind: "user",
		canonicalId: "user-2",
		displayName: "Directory User",
		email: "user@example.test",
	},
	{
		kind: "user",
		canonicalId: "user-3",
		displayName: "New Owner",
		email: "new@example.test",
	},
	{
		kind: "organization",
		canonicalId: "org-1",
		displayName: "Platform",
		organizationPath: "Engineering / Platform",
	},
];
function directoryFixture() {
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(String(input), "http://localhost");
		if (!url.pathname.endsWith("/directory/search"))
			return Response.json({ status: "not_configured" });
		const ids = url.searchParams.get("ids")?.split(",");
		const query = url.searchParams.get("q")?.toLowerCase() ?? "";
		return Response.json({
			items: items.filter(
				(item) =>
					item.kind === url.searchParams.get("kind") &&
					(!ids || ids.includes(item.canonicalId)) &&
					JSON.stringify(item).toLowerCase().includes(query),
			),
		});
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("Agent detail and Owner configuration directory fields", () => {
	it("resolves detail availability by canonical IDs without displaying them", async () => {
		const fetch = directoryFixture();
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		expect(await screen.findByText("Directory User")).toBeTruthy();
		expect(await screen.findByText("Engineering / Platform")).toBeTruthy();
		expect(screen.getByText("user@example.test")).toBeTruthy();
		expect(document.body.textContent).not.toContain("user-2");
		expect(document.body.textContent).not.toContain("org-1");
		expect(
			fetch.mock.calls.some(([url]) => String(url).includes("ids=user-2")),
		).toBe(true);
		expect(
			fetch.mock.calls.some(([url]) => String(url).includes("ids=org-1")),
		).toBe(true);
	});
	it("shows a non-live placeholder while reading availability names", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => undefined)),
		);
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		expect(await screen.findAllByText("读取中…")).toHaveLength(2);
		expect(
			screen
				.queryAllByRole("status")
				.some((node) => node.textContent?.includes("正在读取目录")),
		).toBe(false);
		for (const node of screen.getAllByText("读取中…"))
			expect(node.closest("[aria-live],[role=status]")).toBeNull();
	});
	it("shows one directory alert with retry and missing records without falling back to IDs", async () => {
		const failing = vi.fn(async () => new Response(null, { status: 503 }));
		vi.stubGlobal("fetch", failing);
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("目录暂时无法读取");
		// 读取失败是 danger notice（带图标），不走对话页的 Alert 兼容层。
		expect(alert.getAttribute("data-tone")).toBe("danger");
		expect(alert.querySelector(":scope > svg")).not.toBeNull();
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(
			screen
				.queryAllByRole("status")
				.some((node) => node.textContent?.includes("正在读取目录")),
		).toBe(false);
		expect(document.body.textContent).not.toContain("user-2");
		directoryFixture();
		fireEvent.click(
			within(alert).getByRole("button", { name: "重新读取目录" }),
		);
		expect(await screen.findByText("Directory User")).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		cleanup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ items: [] })),
		);
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		expect(await screen.findByText("未识别的用户")).toBeTruthy();
		expect(screen.getByText("未识别的组织")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(document.body.textContent).not.toContain("org-1");
		expect(document.body.textContent).not.toContain("目录记录不可用");
	});
	it("prefills configuration chips and saves selected canonical IDs", async () => {
		directoryFixture();
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session }}
				submitting={false}
			/>,
		);
		expect(await screen.findByText("Current Owner")).toBeTruthy();
		expect(await screen.findByText("Directory User")).toBeTruthy();
		expect(await screen.findByText("Platform")).toBeTruthy();
		const input = screen.getByRole("combobox", { name: "共同 Owner 用户" });
		fireEvent.change(input, { target: { value: "New" } });
		fireEvent.click(await screen.findByRole("option", { name: /New Owner/ }));
		fireEvent.click(
			screen.getByRole("button", { name: "移除 Directory User" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				coOwnerIds: ["user-owner-1", "user-3"],
				availability: [{ kind: "organization", organizationId: "org-1" }],
			}),
		);
		expect(screen.queryByLabelText("Owner 用户 ID")).toBeNull();
	});
	it("retains unresolved selections on directory failure and prevents an empty Owner submission", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session }}
				submitting={false}
			/>,
		);
		// Owner 使用 Agent 投影中的显示名；没有已知名称的范围用可区分的占位，不显示 ID。
		await waitFor(() =>
			expect(screen.getAllByText("目录详情暂时无法读取")).toHaveLength(3),
		);
		expect(screen.getByText(/^未识别的用户 \d+$/)).toBeTruthy();
		expect(screen.getByText(/^未识别的组织 \d+$/)).toBeTruthy();
		expect(document.body.textContent).not.toContain("目录记录不可用");
		expect(document.body.textContent).not.toContain("user-2");
		// 没有任何改动时保存不可用（#2560）；先做一次与 Owner、范围无关的真实改动，
		// 再确认目录读取失败时未解析的选择仍随请求原样提交。
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		fireEvent.change(screen.getByLabelText("Secret 名称"), {
			target: { value: "CHANGED_SECRET" },
		});
		fireEvent.change(screen.getByLabelText("新 Secret 值"), {
			target: { value: "changed-secret-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				coOwnerIds: ["user-owner-1"],
				availability: agent.configuration.availability,
			}),
		);
		onSave.mockClear();
		const ownerField = screen
			.getByRole("combobox", { name: "共同 Owner 用户" })
			.closest(".directory-field");
		if (!(ownerField instanceof HTMLElement))
			throw new Error("Missing Owner field");
		fireEvent.click(
			within(ownerField).getByRole("button", { name: "移除 Owner" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText("请选择至少一名有效 Owner。")).toBeTruthy();
	});
});

it("does not reuse readable records when a new scope fails", async () => {
	const fetch = directoryFixture();
	const { rerender } = render(
		<DirectoryRecords targets={[{ kind: "user", userId: "user-2" }]} />,
	);
	expect(await screen.findByText("Directory User")).toBeTruthy();
	fetch.mockImplementation(async () => new Response(null, { status: 403 }));
	rerender(<DirectoryRecords targets={[{ kind: "user", userId: "user-3" }]} />);
	expect(screen.queryByText("Directory User")).toBeNull();
	expect((await screen.findByRole("alert")).textContent).toContain(
		"目录暂时无法读取",
	);
	expect(screen.queryByText("Directory User")).toBeNull();
});

it("resolves all selected records beyond the 50-result search limit", async () => {
	const ids = Array.from({ length: 51 }, (_, index) => `selected-${index}`);
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(String(input), "http://localhost");
		const batch = url.searchParams.get("ids")?.split(",") ?? [];
		expect(batch.length).toBeLessThanOrEqual(50);
		return Response.json({
			items: batch.map((id) => ({
				kind: "user",
				canonicalId: id,
				displayName: `Name ${id}`,
			})),
		});
	});
	vi.stubGlobal("fetch", fetch);
	render(
		<DirectoryRecords
			targets={ids.map((userId) => ({ kind: "user" as const, userId }))}
		/>,
	);
	expect(await screen.findByText("Name selected-50")).toBeTruthy();
	expect(screen.getAllByRole("listitem")).toHaveLength(51);
	expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(["pending", "disabled"])(
	"keeps configuration directory controls disabled while %s",
	async (state) => {
		directoryFixture();
		render(
			<AgentConfigurationScreen
				agent={{
					...agent,
					managementStatus:
						state === "disabled" ? "disabled" : agent.managementStatus,
				}}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session }}
				submitting={state === "pending"}
			/>,
		);
		await screen.findByText("Current Owner");
		for (const input of screen.getAllByRole("combobox"))
			expect(input.hasAttribute("disabled")).toBe(true);
		expect(
			screen
				.getByRole("button", { name: "移除 Current Owner" })
				.hasAttribute("disabled"),
		).toBe(true);
	},
);

it("does not read the directory for non-Owner configuration", () => {
	const fetch = directoryFixture();
	render(
		<AgentConfigurationScreen
			agent={agent}
			onSave={vi.fn()}
			onUpgradeImage={vi.fn()}
			session={{
				kind: "ready",
				session: {
					...session,
					user: { ...session.user, userId: "other-user" },
				},
			}}
			submitting={false}
		/>,
	);
	expect(screen.getByRole("heading", { name: "配置不可用" })).toBeTruthy();
	expect(fetch).not.toHaveBeenCalled();
});

function PickerHarness({
	initial = "",
	fallbackLabels,
	onChange,
}: {
	initial?: string;
	fallbackLabels?: Record<string, string>;
	onChange?: (value: string, selection: readonly DirectorySelection[]) => void;
}) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<DirectoryPicker
				id="picker-owner"
				kind="user"
				label="共同 Owner 用户"
				help="至少保留一名有效 Owner"
				value={value}
				fallbackLabels={fallbackLabels}
				onChange={(next, selection) => {
					setValue(next);
					onChange?.(next, selection);
				}}
			/>
			<input aria-label="下一个字段" />
		</>
	);
}

async function openPicker(query?: string) {
	const input = screen.getByRole("combobox", { name: "共同 Owner 用户" });
	act(() => input.focus());
	if (query !== undefined)
		fireEvent.change(input, { target: { value: query } });
	return input as HTMLInputElement;
}

function pick(option: HTMLElement) {
	// 鼠标按下不应把焦点从输入框移走。
	expect(fireEvent.mouseDown(option)).toBe(false);
	fireEvent.click(option);
}

describe("DirectoryPicker interaction", () => {
	it("stays open for consecutive picks and returns focus to the input", async () => {
		directoryFixture();
		const onChange = vi.fn();
		render(<PickerHarness onChange={onChange} />);
		const input = await openPicker("Owner");
		pick(await screen.findByRole("option", { name: /Current Owner/ }));
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(input.getAttribute("aria-expanded")).toBe("true");
		expect(input.value).toBe("");
		expect(
			await screen.findByRole("option", { name: /Directory User/ }),
		).toBeTruthy();
		expect(screen.queryByRole("option", { name: /Current Owner/ })).toBeNull();
		pick(screen.getByRole("option", { name: /Directory User/ }));
		await waitFor(() =>
			expect(onChange).toHaveBeenLastCalledWith("user-owner-1\nuser-2", [
				{
					id: "user-owner-1",
					name: "Current Owner",
					secondary: "owner@example.test",
					resolved: true,
				},
				{
					id: "user-2",
					name: "Directory User",
					secondary: "user@example.test",
					resolved: true,
				},
			]),
		);
		expect(
			screen.getByRole("button", { name: "移除 Current Owner" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "移除 Directory User" }),
		).toBeTruthy();
		expect(document.activeElement).toBe(input);
	});

	it("adds with Enter, closes with Escape and reopens on click or ArrowDown", async () => {
		directoryFixture();
		render(<PickerHarness initial="user-owner-1" />);
		await screen.findByText("Current Owner");
		const input = await openPicker();
		// 已有选择且查询为空时，聚焦即列出其余候选。
		expect(input.getAttribute("aria-expanded")).toBe("true");
		expect(
			await screen.findByRole("option", { name: /Directory User/ }),
		).toBeTruthy();
		fireEvent.keyDown(input, { key: "Enter" });
		expect(
			await screen.findByRole("button", { name: "移除 Directory User" }),
		).toBeTruthy();
		expect(input.getAttribute("aria-expanded")).toBe("true");
		fireEvent.keyDown(input, { key: "Escape" });
		expect(input.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(input);
		fireEvent.click(input);
		expect(input.getAttribute("aria-expanded")).toBe("true");
		fireEvent.keyDown(input, { key: "Escape" });
		fireEvent.keyDown(input, { key: "ArrowDown" });
		expect(input.getAttribute("aria-expanded")).toBe("true");
	});

	it("keeps the list open and focuses the input after removing a chip", async () => {
		directoryFixture();
		render(<PickerHarness initial={"user-owner-1\nuser-2"} />);
		const remove = await screen.findByRole("button", {
			name: "移除 Directory User",
		});
		const input = screen.getByRole("combobox", { name: "共同 Owner 用户" });
		fireEvent.click(remove);
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(input.getAttribute("aria-expanded")).toBe("true");
		expect(
			screen.queryByRole("button", { name: "移除 Directory User" }),
		).toBeNull();
	});

	it("offers clear search outside the listbox only when a query exists", async () => {
		directoryFixture();
		render(<PickerHarness />);
		const input = await openPicker();
		const listbox = await screen.findByRole("listbox", {
			name: "共同 Owner 用户搜索结果",
		});
		expect(screen.queryByRole("button", { name: "清空搜索" })).toBeNull();
		expect(input.getAttribute("aria-controls")).toBe(listbox.id);
		for (const option of screen.getAllByRole("option"))
			expect(option.tabIndex).toBe(-1);
		fireEvent.change(input, { target: { value: "Owner" } });
		await screen.findByRole("option", { name: /New Owner/ });
		const clearWithResults = screen.getByRole("button", { name: "清空搜索" });
		expect(screen.getByRole("listbox").contains(clearWithResults)).toBe(false);
		fireEvent.change(input, { target: { value: "nobody" } });
		expect(await screen.findByText("没有匹配结果")).toBeTruthy();
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(input.hasAttribute("aria-controls")).toBe(false);
		const clear = screen.getByRole("button", { name: "清空搜索" });
		expect(clear.tabIndex).toBe(-1);
		pick(clear);
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(input.value).toBe("");
		expect(input.getAttribute("aria-expanded")).toBe("true");
		expect(
			await screen.findByRole("option", { name: /Current Owner/ }),
		).toBeTruthy();
	});

	it("closes when focus moves to a control outside the picker", async () => {
		directoryFixture();
		render(<PickerHarness />);
		const input = await openPicker();
		await screen.findByRole("listbox");
		const next = screen.getByRole("textbox", { name: "下一个字段" });
		fireEvent.focusOut(input, { relatedTarget: next });
		expect(input.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("closes after an outside click rather than on pointer down", async () => {
		directoryFixture();
		render(<PickerHarness />);
		const input = await openPicker();
		await screen.findByRole("listbox");
		const next = screen.getByRole("textbox", { name: "下一个字段" });
		// 按下时不收起，避免窄屏文档流中的结果层收起导致下方控件位移、点击落空。
		fireEvent.pointerDown(next);
		fireEvent.focusOut(input, { relatedTarget: next });
		expect(input.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(next);
		expect(input.getAttribute("aria-expanded")).toBe("false");
	});

	it("names unresolved chips from fallback labels or stable distinct placeholders", async () => {
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetch = vi.fn(async (_input: string | URL | Request) => {
			await pending;
			return Response.json({ items: [] });
		});
		vi.stubGlobal("fetch", fetch);
		const onChange = vi.fn();
		render(
			<PickerHarness
				initial={"user-known\nuser-x\nuser-y"}
				fallbackLabels={{ "user-known": "林默" }}
				onChange={onChange}
			/>,
		);
		const removeNames = () =>
			screen
				.getAllByRole("button", { name: /^移除 / })
				.map((button) => button.getAttribute("aria-label") ?? "");
		// 读取完成前只显示中性占位，不下「未识别」的结论。
		expect(screen.getAllByText("正在读取目录详情…")).toHaveLength(3);
		expect(removeNames()[0]).toBe("移除 林默");
		expect(removeNames().slice(1)).toEqual([
			expect.stringMatching(/^移除 用户 \d+$/),
			expect.stringMatching(/^移除 用户 \d+$/),
		]);
		release();
		expect(await screen.findAllByText("目录中暂未找到该记录")).toHaveLength(3);
		const names = removeNames();
		expect(names[0]).toBe("移除 林默");
		expect(names.slice(1)).toEqual([
			expect.stringMatching(/^移除 未识别的用户 \d+$/),
			expect.stringMatching(/^移除 未识别的用户 \d+$/),
		]);
		expect(new Set(names).size).toBe(3);
		expect(document.body.textContent).not.toMatch(
			/目录记录不可用|无法读取目录详情|user-x|user-y|user-known/,
		);
		const [, removed, kept] = names;
		fireEvent.click(screen.getByRole("button", { name: removed }));
		// 移除后其余占位保持原名，selection 与 chip 显示一致；已确认缺失的记录不再重复请求。
		expect(removeNames()).toEqual([names[0], kept]);
		expect(screen.getAllByText("目录中暂未找到该记录")).toHaveLength(2);
		// 移除后展开会发起一次搜索；按 ID 反查只发生过一次。
		expect(
			fetch.mock.calls.filter(([input]) => String(input).includes("ids=")),
		).toHaveLength(1);
		expect(onChange).toHaveBeenLastCalledWith("user-known\nuser-y", [
			{
				id: "user-known",
				name: "林默",
				secondary: "目录中暂未找到该记录",
				resolved: false,
			},
			{
				id: "user-y",
				name: kept?.replace("移除 ", ""),
				secondary: "目录中暂未找到该记录",
				resolved: false,
			},
		]);
	});
});
