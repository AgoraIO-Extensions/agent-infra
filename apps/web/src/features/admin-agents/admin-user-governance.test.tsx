import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client as generatedClient } from "../../pilot/generated-v2/client.gen.js";
import {
	directoryRequestUrl,
	directorySearchResponse,
} from "../directory-test-fixtures.js";
import { AdminUserGovernance } from "./admin-user-governance.js";

// 禁用确认弹窗用目录记录显示员工姓名与邮箱，需要 QueryClient。
function renderGovernance() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<AdminUserGovernance />
		</QueryClientProvider>,
	);
}

const { getPlatformUserDisabledV2, setPlatformUserDisabledV2 } = vi.hoisted(
	() => ({
		getPlatformUserDisabledV2: vi.fn(),
		setPlatformUserDisabledV2: vi.fn(),
	}),
);
// 只替换禁用状态的两个调用；目录选择器仍经真实生成的 searchDirectoryV2 读取下面的 fetch 夹具。
vi.mock("../../pilot/generated-v2/sdk.gen.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../pilot/generated-v2/sdk.gen.js")
	>()),
	getPlatformUserDisabledV2,
	setPlatformUserDisabledV2,
}));

beforeEach(() => {
	// 生成 Client 默认使用相对地址；jsdom 下的 Request 需要绝对地址。
	generatedClient.setConfig({ baseUrl: "https://platform.test" });
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function setupDirectory() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) =>
			Response.json(
				directorySearchResponse(directoryRequestUrl(input), [
					{
						kind: "user",
						canonicalId: "11111111-1111-4111-8111-111111111111",
						displayName: "Alice",
						email: "alice@example.test",
					},
				]),
			),
		),
	);
}

describe("Administrator employee access control", () => {
	it("selects a directory user and sends a server-authorized disable command", async () => {
		setupDirectory();
		getPlatformUserDisabledV2.mockResolvedValue({
			response: { status: 200 },
			data: {
				schemaVersion: 1,
				userId: "11111111-1111-4111-8111-111111111111",
				disabled: false,
			},
		});
		setPlatformUserDisabledV2.mockResolvedValue({
			response: { status: 200 },
			data: {
				schemaVersion: 1,
				userId: "11111111-1111-4111-8111-111111111111",
				disabled: true,
				changed: true,
				auditOutcome: "recorded",
			},
		});
		renderGovernance();
		fireEvent.focus(screen.getByRole("combobox", { name: "员工" }));
		await screen.findByRole("option", { name: /Alice/ });
		fireEvent.click(screen.getByRole("option", { name: /Alice/ }));
		// 单选场景选中后收起结果层，避免盖住状态与操作按钮。
		expect(
			screen
				.getByRole("combobox", { name: "员工" })
				.getAttribute("aria-expanded"),
		).toBe("false");
		expect(screen.queryByRole("listbox")).toBeNull();
		await screen.findByText("当前状态：未禁用");
		// 触发按钮的可访问名称带上所选员工（F-11：「禁用员工：{姓名}」）。
		const trigger = screen.getByRole("button", { name: "禁用员工：Alice" });
		expect(trigger.textContent).toBe("禁用员工");
		// 禁用先确认对象与后果：打开与取消都不发请求。
		fireEvent.click(trigger);
		let dialog = await screen.findByRole("dialog", { name: "禁用这名员工？" });
		expect(await within(dialog).findByText("Alice")).toBeTruthy();
		expect(within(dialog).getByText("alice@example.test")).toBeTruthy();
		expect(within(dialog).getByText(/立即不能登录平台/)).toBeTruthy();
		expect(setPlatformUserDisabledV2).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(setPlatformUserDisabledV2).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "禁用员工：Alice" }));
		dialog = await screen.findByRole("dialog", { name: "禁用这名员工？" });
		fireEvent.click(within(dialog).getByRole("button", { name: "禁用员工" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "禁用员工" }));
		await waitFor(() =>
			expect(setPlatformUserDisabledV2).toHaveBeenCalledWith({
				path: { userId: "11111111-1111-4111-8111-111111111111" },
				body: { schemaVersion: 1, disabled: true },
				responseStyle: "fields",
				throwOnError: false,
			}),
		);
		expect(setPlatformUserDisabledV2).toHaveBeenCalledTimes(1);
		expect(await screen.findByText(/禁用已确认/)).toBeTruthy();
		expect(await screen.findByText(/审计结果：已记录/)).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain("禁用已确认");
	});

	it("keeps both actions explicit and reports an unconfirmed response without details", async () => {
		setupDirectory();
		getPlatformUserDisabledV2.mockResolvedValue({
			response: { status: 200 },
			data: {
				schemaVersion: 1,
				userId: "11111111-1111-4111-8111-111111111111",
				disabled: true,
			},
		});
		setPlatformUserDisabledV2.mockResolvedValue({ response: { status: 503 } });
		renderGovernance();
		fireEvent.focus(screen.getByRole("combobox", { name: "员工" }));
		await screen.findByRole("option", { name: /Alice/ });
		fireEvent.click(screen.getByRole("option", { name: /Alice/ }));
		await screen.findByText("当前状态：已禁用");
		// 解除禁用不需要确认，直接提交；失败用 role="alert" 播报。
		fireEvent.click(screen.getByRole("button", { name: "解除禁用" }));
		await screen.findByText(/操作未确认/);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByRole("alert").textContent).toContain("操作未确认");
		expect(
			screen.getByRole("button", { name: "禁用员工：Alice" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "解除禁用" })).toBeTruthy();
	});
});
