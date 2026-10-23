import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";

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

import { PersonalRelayKeyScreen } from "./personal-relay-key-screen";

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
	error: {
		schemaVersion: 1,
		code:
			status === 401
				? "AUTHENTICATION_REQUIRED"
				: status === 403
					? "RESOURCE_UNAVAILABLE"
					: status === 409
						? "INVALID_REQUEST"
						: "DEPENDENCY_UNAVAILABLE",
		message: "synthetic server message",
		traceId: "trace-personal-key",
		retryable: status === 503,
	},
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

function screenFor(userId: string, onSessionExpired?: () => unknown) {
	return (
		<ToastProvider>
			<PersonalRelayKeyScreen
				userId={userId}
				onSessionExpired={onSessionExpired}
			/>
		</ToastProvider>
	);
}

function openPage(userId = "user-owner", onSessionExpired = vi.fn()) {
	const view = render(screenFor(userId, onSessionExpired));
	return { onSessionExpired, ...view };
}

/** 等待已设置状态读完：页头 chip 与分区说明都带上版本。 */
async function findConfigured(version: number) {
	await screen.findByText(`当前状态：已设置 · version ${version}`);
}

function keyInput() {
	return screen.getByLabelText("Relay Key") as HTMLInputElement;
}

function toastText() {
	return document.querySelector('[data-slot="toast"]')?.textContent ?? "";
}

function deferred() {
	let resolve!: (value: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("PersonalRelayKeyScreen", () => {
	it("shows the design structure and reflects the set state in both chips", async () => {
		openPage();
		expect(
			screen.getByRole("heading", { level: 1, name: "个人 Relay Key" }),
		).toBeTruthy();
		expect(screen.getByText("我的管理 / 个人凭证")).toBeTruthy();
		expect(
			screen.getByText(
				"用于 Web 对话和企微渠道。凭证值只在提交时使用，页面不会回显。",
			),
		).toBeTruthy();
		// 读取完成前不显示状态 chip。
		expect(screen.queryByTestId("personal-key-status")).toBeNull();
		const notice = screen
			.getByText("费用和权限跟随个人 Key")
			.closest('[data-slot="alert"]') as HTMLElement;
		expect(notice.getAttribute("role")).toBeNull();
		expect(notice.getAttribute("aria-live")).toBeNull();
		expect(
			within(notice).getByText("平台不会改用 Agent 默认 Key 代替个人调用。"),
		).toBeTruthy();
		await findConfigured(2);
		expect(screen.getByTestId("personal-key-status").textContent).toBe(
			"已设置",
		);
		expect(
			screen.getByRole("heading", { level: 2, name: "替换个人 Key" }),
		).toBeTruthy();
		expect(screen.getByText("version 2")).toBeTruthy();
		const input = keyInput();
		expect(input.getAttribute("type")).toBe("password");
		expect(input.getAttribute("placeholder")).toBe("仅本次提交使用");
		expect(input.getAttribute("autocomplete")).toBe("new-password");
		expect(
			[...document.querySelectorAll(".roadmap-card h3")].map(
				(item) => item.textContent,
			),
		).toEqual(["缺少 Key", "Key 失效", "额度不足", "模型无权限"]);
		const actions = [
			...screen
				.getByTestId("personal-relay-key-form")
				.querySelectorAll('[data-slot="button"]'),
		].map((item) => item.textContent);
		expect(actions).toEqual(["替换 Key", "撤销 Key"]);
		expect(document.body.textContent).not.toMatch(/已配置 · 版本|尚未读取/);
	});

	it("keeps the key write-only, sends the current CAS version and confirms with a toast", async () => {
		openPage();
		await findConfigured(2);
		const input = keyInput();
		const secret = "synthetic-secret!";
		fireEvent.change(input, { target: { value: secret } });
		const save = screen.getByRole("button", { name: "替换 Key" });
		fireEvent.click(save);

		await findConfigured(3);
		expect(api.replace).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { expectedVersion: 2, keyValue: secret },
			}),
		);
		expect(input.value).toBe("");
		expect(toastText()).toBe("个人 Relay Key 已保存，页面不会显示值");
		await waitFor(() => expect(document.activeElement).toBe(save));
		expect(document.body.innerHTML).not.toContain("synthetic-secret");
		expect(document.body.textContent).not.toContain("从下一条任务生效");
	});

	it("saves an absent key with a null CAS and revokes the configured version", async () => {
		api.get.mockResolvedValue(absent());
		openPage();
		await screen.findByText("未设置");
		expect(
			screen.getByRole("heading", { level: 2, name: "接入个人 Key" }),
		).toBeTruthy();
		expect(screen.getByText("待设置")).toBeTruthy();
		// 未设置时不渲染撤销按钮，而不是禁用常驻。
		expect(screen.queryAllByRole("button", { name: "撤销 Key" })).toHaveLength(
			0,
		);
		const input = keyInput();
		fireEvent.change(input, { target: { value: "synthetic-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "保存 Key" }));

		await findConfigured(3);
		expect(api.replace).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { expectedVersion: null, keyValue: "synthetic-secret" },
			}),
		);
		expect(input.value).toBe("");

		fireEvent.click(screen.getByRole("button", { name: "撤销 Key" }));
		await screen.findByText("未设置");
		expect(api.revoke).toHaveBeenCalledWith(
			expect.objectContaining({ body: { expectedVersion: 3 } }),
		);
		expect(toastText()).toBe("个人 Relay Key 已撤销");
		expect(
			screen.getByRole("heading", { level: 2, name: "接入个人 Key" }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "撤销 Key" })).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(keyInput()));
		expect(document.body.textContent).not.toMatch(/移除 Key|已移除|正在移除/);
	});

	it.each([
		[401, "登录状态已失效，请重新登录后重试。"],
		[403, "当前账号没有设置个人 Relay Key 的权限。"],
	])(
		"surfaces an authorization failure without a default-key fallback",
		async (status, message) => {
			api.get.mockResolvedValue(rejected(status));
			const { onSessionExpired } = openPage();
			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toContain(message);
			expect(screen.queryByTestId("personal-key-status")).toBeNull();
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
			openPage();
			await findConfigured(2);
			fireEvent.change(keyInput(), { target: { value: "synthetic-secret" } });
			fireEvent.click(screen.getByRole("button", { name: "替换 Key" }));
			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toContain(message);
			// 失败只在分区内就地提示，不发成功 Toast。
			expect(toastText()).toBe("");
			const refreshButton = screen.getByRole("button", {
				name: "重新读取状态",
			});
			expect((refreshButton as HTMLButtonElement).disabled).toBe(false);
		},
	);

	it("clears the prior user's projection before reading a new server session", async () => {
		mockGetSequence(configured(7), absent());
		const { rerender } = render(screenFor("user-owner"));
		await findConfigured(7);
		fireEvent.change(keyInput(), { target: { value: "prior-user-secret" } });

		rerender(screenFor("user-other"));
		await waitFor(() => expect(screen.getByText("未设置")).toBeTruthy());
		expect(screen.queryByText("当前状态：已设置 · version 7")).toBeNull();
		expect(keyInput().value).toBe("");
	});

	it("clears the unsubmitted draft when leaving and reads fresh metadata on return", async () => {
		const first = openPage();
		await findConfigured(2);
		fireEvent.change(keyInput(), { target: { value: "prior-page-secret" } });
		first.unmount();
		api.get.mockResolvedValueOnce(configured(8));
		openPage();
		await findConfigured(8);
		expect(keyInput().value).toBe("");
		expect(api.replace).not.toHaveBeenCalled();
	});

	it.each([
		"K".repeat(15),
		"K".repeat(8193),
		" synthetic-secret!",
		"synthetic-secret! ",
		"synthetic-secret!\u0007",
		"synthetic-secret!中文",
	])("does not dispatch invalid Key input case %#", async (keyValue) => {
		openPage();
		await findConfigured(2);
		const input = keyInput();
		fireEvent.change(input, { target: { value: keyValue } });
		fireEvent.click(screen.getByRole("button", { name: "替换 Key" }));
		expect(api.replace).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toBe(
			"请输入 16–8192 位 ASCII 可见字符，不含空格的个人 Relay Key。",
		);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(input);
	});

	it.each(["replace", "revoke"] as const)(
		"clears the input before %s dispatch and while the request is pending",
		async (operation) => {
			const pending = deferred();
			openPage();
			await findConfigured(2);
			const input = keyInput();
			api[operation].mockImplementationOnce(() => {
				expect(input.value).toBe("");
				return pending.promise;
			});
			fireEvent.change(input, { target: { value: "synthetic-secret!" } });
			fireEvent.click(
				screen.getByRole("button", {
					name: operation === "replace" ? "替换 Key" : "撤销 Key",
				}),
			);
			expect(input.value).toBe("");
			expect(input.disabled).toBe(true);
			expect(
				screen.getByText(
					operation === "replace" ? "正在保存个人 Key…" : "正在撤销个人 Key…",
				),
			).toBeTruthy();
			await act(async () =>
				pending.resolve(operation === "replace" ? configured(3) : absent()),
			);
		},
	);

	it.each([
		["replace", 401],
		["replace", 403],
		["replace", 409],
		["replace", 503],
		["revoke", 401],
		["revoke", 403],
		["revoke", 409],
		["revoke", 503],
	] as const)(
		"invalidates writes after %s returns HTTP %s",
		async (operation, status) => {
			api[operation].mockResolvedValueOnce(rejected(status));
			const { onSessionExpired } = openPage();
			await findConfigured(2);
			fireEvent.change(keyInput(), { target: { value: "synthetic-secret!" } });
			fireEvent.click(
				screen.getByRole("button", {
					name: operation === "replace" ? "替换 Key" : "撤销 Key",
				}),
			);
			await screen.findByRole("alert");
			const write = screen.getByRole("button", {
				name: /^(替换|保存) Key$/,
			}) as HTMLButtonElement;
			// #3242 K7-02：写入失败后表单仍禁用，按钮是可聚焦的禁用（aria-disabled），焦点不落到 body；
			// 下方点击仍不会再次提交。
			expect(write.getAttribute("aria-disabled")).toBe("true");
			expect(write.disabled).toBe(false);
			expect(keyInput().value).toBe("");
			fireEvent.click(write);
			expect(api[operation]).toHaveBeenCalledTimes(1);
			if (status === 401 || status === 403) {
				// 身份或授权失效后清空投影：状态未知，撤销入口不再出现。
				expect(screen.queryByTestId("personal-key-status")).toBeNull();
				expect(screen.queryByRole("button", { name: "撤销 Key" })).toBeNull();
				expect(
					screen.queryByRole("button", { name: "重新读取状态" }),
				).toBeNull();
				if (status === 401) {
					fireEvent.click(screen.getByRole("button", { name: "重新检查登录" }));
					expect(onSessionExpired).toHaveBeenCalledOnce();
				}
				return;
			}
			const revokeButton = screen.getByRole("button", {
				name: "撤销 Key",
			}) as HTMLButtonElement;
			expect(revokeButton.getAttribute("aria-disabled")).toBe("true");
			expect(revokeButton.disabled).toBe(false);
			api.get.mockResolvedValueOnce(configured(9));
			fireEvent.click(screen.getByRole("button", { name: "重新读取状态" }));
			await findConfigured(9);
			if (operation === "replace") {
				fireEvent.change(keyInput(), {
					target: { value: "fresh-synthetic-key" },
				});
			}
			fireEvent.click(
				screen.getByRole("button", {
					name: operation === "replace" ? "替换 Key" : "撤销 Key",
				}),
			);
			await waitFor(() => expect(api[operation]).toHaveBeenCalledTimes(2));
			expect(api[operation]).toHaveBeenLastCalledWith(
				expect.objectContaining({
					body: expect.objectContaining({ expectedVersion: 9 }),
				}),
			);
		},
	);

	const pendingCases = (["read", "replace", "revoke"] as const).flatMap(
		(operation) =>
			(
				["leave-return", "other-user", "new-session", "new-role"] as const
			).flatMap((boundary) =>
				(["success", "error"] as const).map(
					(outcome) => [operation, boundary, outcome] as const,
				),
			),
	);
	it.each(pendingCases)(
		"ignores stale %s %s %s after the boundary reset",
		async (operation, boundary, outcome) => {
			const pending = deferred();
			api.get.mockResolvedValue(configured(11));
			if (operation === "read")
				api.get.mockImplementationOnce(() => pending.promise);
			else {
				api.get.mockResolvedValueOnce(configured(2));
				api[operation].mockImplementationOnce(() => pending.promise);
			}
			const page = (key: string, userId: string) => (
				<ToastProvider>
					<PersonalRelayKeyScreen key={key} userId={userId} />
				</ToastProvider>
			);
			const view = render(page("session-1-member", "user-owner"));
			if (operation !== "read") {
				await findConfigured(2);
				fireEvent.change(keyInput(), {
					target: { value: "old-synthetic-key" },
				});
				fireEvent.click(
					screen.getByRole("button", {
						name: operation === "replace" ? "替换 Key" : "撤销 Key",
					}),
				);
			}
			await waitFor(() =>
				expect(
					operation === "read" ? api.get : api[operation],
				).toHaveBeenCalledTimes(1),
			);
			if (boundary === "leave-return") {
				view.unmount();
				render(page("session-1-member", "user-owner"));
			} else if (boundary === "other-user") {
				view.rerender(page("session-1-member", "user-other"));
			} else {
				view.rerender(
					page(
						boundary === "new-session" ? "session-2-member" : "session-1-admin",
						"user-owner",
					),
				);
			}
			await findConfigured(11);
			const currentInput = keyInput();
			fireEvent.change(currentInput, {
				target: { value: "new-synthetic-key" },
			});
			await act(async () => {
				if (outcome === "success") pending.resolve(configured(77));
				else pending.reject(new Error("old request body must remain private"));
				await pending.promise.catch(() => undefined);
			});
			expect(screen.getByTestId("personal-key-status").textContent).toBe(
				"已设置",
			);
			expect(screen.getByText("当前状态：已设置 · version 11")).toBeTruthy();
			expect(screen.queryByRole("alert")).toBeNull();
			expect(currentInput.value).toBe("new-synthetic-key");
			expect(currentInput.disabled).toBe(false);
			fireEvent.click(screen.getByRole("button", { name: "替换 Key" }));
			await waitFor(() =>
				expect(api.replace).toHaveBeenLastCalledWith(
					expect.objectContaining({
						body: {
							expectedVersion: 11,
							keyValue: "new-synthetic-key",
						},
					}),
				),
			);
		},
	);
});
