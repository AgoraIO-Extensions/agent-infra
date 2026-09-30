import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	replace: vi.fn(),
	revoke: vi.fn(),
}));

vi.mock("../../pilot/generated-v2/sdk.gen.js", () => ({
	getPersonalRelayKeyV2: api.get,
	replacePersonalRelayKeyV2: api.replace,
	revokePersonalRelayKeyV2: api.revoke,
}));

import { PersonalRelayKeyEntry } from "./personal-relay-key-dialog";

const configured = (keyVersion = 2) => ({
	data: { schemaVersion: 1, isSet: true, keyVersion },
	response: { status: 200 },
});
const absent = () => ({
	data: { schemaVersion: 1, isSet: false, keyVersion: null },
	response: { status: 200 },
});
const rejected = (status: number) => ({
	data: undefined,
	response: { status },
	error: { retryable: status === 503 },
});

beforeEach(() => {
	api.get.mockReset().mockResolvedValue(configured());
	api.replace.mockReset().mockResolvedValue(configured(3));
	api.revoke.mockReset().mockResolvedValue(absent());
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function mockGetSequence(...responses: unknown[]) {
	api.get.mockImplementation(async () => responses.shift() ?? configured());
}

function openEntry(userId = "user-owner", onSessionExpired = vi.fn()) {
	render(
		<PersonalRelayKeyEntry
			userId={userId}
			onSessionExpired={onSessionExpired}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "个人 Key 设置" }));
	return { onSessionExpired };
}

describe("PersonalRelayKeyEntry", () => {
	it("keeps the key write-only, sends the current CAS version, and clears success input", async () => {
		openEntry();
		await screen.findByText("已配置 · 版本 2");
		const input = screen.getByLabelText("替换个人 Relay Key");
		expect(input.getAttribute("type")).toBe("password");
		fireEvent.change(input, { target: { value: "synthetic-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "替换 Key" }));

		await screen.findByText("个人 Relay Key 已更新；从下一条任务生效。");
		expect(api.replace).toHaveBeenCalledWith(
			expect.objectContaining({
				body: {
					expectedVersion: 2,
					keyValue: "synthetic-secret",
					schemaVersion: 1,
				},
			}),
		);
		expect((input as HTMLInputElement).value).toBe("");
		expect(screen.queryByText("synthetic-secret")).toBeNull();
	});

	it("sets an absent key with a null CAS and revokes the configured version", async () => {
		api.get.mockResolvedValue(absent());
		openEntry();
		await screen.findByText("未配置");
		const input = screen.getByLabelText("设置个人 Relay Key");
		fireEvent.change(input, { target: { value: "synthetic-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "设置 Key" }));

		await screen.findByText("个人 Relay Key 已更新；从下一条任务生效。");
		expect(api.replace).toHaveBeenCalledWith(
			expect.objectContaining({
				body: {
					expectedVersion: null,
					keyValue: "synthetic-secret",
					schemaVersion: 1,
				},
			}),
		);
		expect((input as HTMLInputElement).value).toBe("");

		fireEvent.click(screen.getByRole("button", { name: "移除 Key" }));
		await screen.findByText("个人 Relay Key 已移除；从下一条任务生效。");
		expect(api.revoke).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { expectedVersion: 3, schemaVersion: 1 },
			}),
		);
		expect(screen.getByTestId("personal-key-status").textContent).toBe(
			"未配置",
		);
	});

	it.each([
		[401, "登录状态已失效，请重新登录后重试。"],
		[403, "当前账号没有设置个人 Relay Key 的权限。"],
	])(
		"surfaces an authorization failure without a default-key fallback",
		async (status, message) => {
			api.get.mockResolvedValue(rejected(status));
			const { onSessionExpired } = openEntry();
			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toBe(message);
			expect(screen.getByTestId("personal-key-status").textContent).toBe(
				"尚未读取",
			);
			if (status === 401) {
				fireEvent.click(screen.getByRole("button", { name: "重新检查登录" }));
				expect(onSessionExpired).toHaveBeenCalledOnce();
			}
		},
	);

	it.each([
		[409, "个人 Key 状态已被其他请求更新，请重新读取后再操作。"],
		[503, "个人 Key 服务暂时不可用，请稍后重试。"],
	])(
		"keeps a failed write recoverable for HTTP %s",
		async (status, message) => {
			api.replace.mockResolvedValueOnce(rejected(status));
			openEntry();
			await screen.findByText("已配置 · 版本 2");
			fireEvent.change(screen.getByLabelText("替换个人 Relay Key"), {
				target: { value: "synthetic-secret" },
			});
			fireEvent.click(screen.getByRole("button", { name: "替换 Key" }));
			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toBe(message);
			const refreshButton = screen.getByRole("button", {
				name: "重新读取状态",
			});
			expect((refreshButton as HTMLButtonElement).disabled).toBe(false);
		},
	);

	it("clears the prior user's projection before reading a new server session", async () => {
		mockGetSequence(configured(7), absent());
		const { rerender } = render(<PersonalRelayKeyEntry userId="user-owner" />);
		fireEvent.click(screen.getByRole("button", { name: "个人 Key 设置" }));
		await screen.findByText("已配置 · 版本 7");

		rerender(<PersonalRelayKeyEntry userId="user-other" />);
		await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
		expect(screen.queryByText("已配置 · 版本 7")).toBeNull();
	});
});
