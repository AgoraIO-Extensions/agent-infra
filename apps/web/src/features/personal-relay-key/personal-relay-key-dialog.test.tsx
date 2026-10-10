import {
	act,
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

function deferred() {
	let resolve!: (value: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("PersonalRelayKeyEntry", () => {
	it("keeps the key write-only, sends the current CAS version, and clears success input", async () => {
		openEntry();
		await screen.findByText("已配置 · 版本 2");
		const input = screen.getByLabelText("替换个人 Relay Key");
		expect(input.getAttribute("type")).toBe("password");
		const secret = "synthetic-secret!";
		fireEvent.change(input, { target: { value: secret } });
		fireEvent.click(screen.getByRole("button", { name: "替换 Key" }));

		await screen.findByText("个人 Relay Key 已更新；从下一条任务生效。");
		expect(api.replace).toHaveBeenCalledWith(
			expect.objectContaining({
				body: {
					expectedVersion: 2,
					keyValue: secret,
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
				},
			}),
		);
		expect((input as HTMLInputElement).value).toBe("");

		fireEvent.click(screen.getByRole("button", { name: "移除 Key" }));
		await screen.findByText("个人 Relay Key 已移除；从下一条任务生效。");
		expect(api.revoke).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { expectedVersion: 3 },
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
		fireEvent.change(screen.getByLabelText("替换个人 Relay Key"), {
			target: { value: "prior-user-secret" },
		});

		rerender(<PersonalRelayKeyEntry userId="user-other" />);
		await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
		expect(screen.queryByText("已配置 · 版本 7")).toBeNull();
		expect(
			(screen.getByLabelText("设置个人 Relay Key") as HTMLInputElement).value,
		).toBe("");
	});

	it("clears unsubmitted draft on close and reads fresh metadata on reopen", async () => {
		openEntry();
		await screen.findByText("已配置 · 版本 2");
		fireEvent.change(screen.getByLabelText("替换个人 Relay Key"), {
			target: { value: "prior-dialog-secret" },
		});
		fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		api.get.mockResolvedValueOnce(configured(8));
		fireEvent.click(screen.getByRole("button", { name: "个人 Key 设置" }));
		await screen.findByText("已配置 · 版本 8");
		expect(
			(screen.getByLabelText("替换个人 Relay Key") as HTMLInputElement).value,
		).toBe("");
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
		openEntry();
		await screen.findByText("已配置 · 版本 2");
		const input = screen.getByLabelText("替换个人 Relay Key");
		fireEvent.change(input, { target: { value: keyValue } });
		fireEvent.click(screen.getByRole("button", { name: "替换 Key" }));
		expect(api.replace).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toBe(
			"请输入 16–8192 位 ASCII 可见字符，不含空格的个人 Relay Key。",
		);
		expect(document.activeElement).toBe(input);
	});

	it.each(["replace", "revoke"] as const)(
		"clears the input before %s dispatch and while the request is pending",
		async (operation) => {
			const pending = deferred();
			openEntry();
			await screen.findByText("已配置 · 版本 2");
			const input = screen.getByLabelText(
				"替换个人 Relay Key",
			) as HTMLInputElement;
			api[operation].mockImplementationOnce(() => {
				expect(input.value).toBe("");
				return pending.promise;
			});
			fireEvent.change(input, { target: { value: "synthetic-secret!" } });
			fireEvent.click(
				screen.getByRole("button", {
					name: operation === "replace" ? "替换 Key" : "移除 Key",
				}),
			);
			expect(input.value).toBe("");
			expect(input.disabled).toBe(true);
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
			const { onSessionExpired } = openEntry();
			await screen.findByText("已配置 · 版本 2");
			fireEvent.change(screen.getByLabelText("替换个人 Relay Key"), {
				target: { value: "synthetic-secret!" },
			});
			fireEvent.click(
				screen.getByRole("button", {
					name: operation === "replace" ? "替换 Key" : "移除 Key",
				}),
			);
			await screen.findByRole("alert");
			expect(
				(screen.getByRole("button", { name: "移除 Key" }) as HTMLButtonElement)
					.disabled,
			).toBe(true);
			const write = screen.getByRole("button", {
				name: /^(替换|设置) Key$/,
			}) as HTMLButtonElement;
			expect(write.disabled).toBe(true);
			expect(
				(
					screen.getByLabelText(
						/^(替换|设置)个人 Relay Key$/,
					) as HTMLInputElement
				).value,
			).toBe("");
			fireEvent.click(write);
			expect(api[operation]).toHaveBeenCalledTimes(1);
			if (status === 401 || status === 403) {
				expect(screen.getByTestId("personal-key-status").textContent).toBe(
					"尚未读取",
				);
				expect(
					screen.queryByRole("button", { name: "重新读取状态" }),
				).toBeNull();
				if (status === 401) {
					fireEvent.click(screen.getByRole("button", { name: "重新检查登录" }));
					expect(onSessionExpired).toHaveBeenCalledOnce();
				}
				return;
			}
			api.get.mockResolvedValueOnce(configured(9));
			fireEvent.click(screen.getByRole("button", { name: "重新读取状态" }));
			await screen.findByText("已配置 · 版本 9");
			if (operation === "replace") {
				fireEvent.change(screen.getByLabelText("替换个人 Relay Key"), {
					target: { value: "fresh-synthetic-key" },
				});
			}
			fireEvent.click(
				screen.getByRole("button", {
					name: operation === "replace" ? "替换 Key" : "移除 Key",
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
				["close-reopen", "other-user", "new-session", "new-role"] as const
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
			const { rerender } = render(
				<PersonalRelayKeyEntry key="session-1-member" userId="user-owner" />,
			);
			fireEvent.click(screen.getByRole("button", { name: "个人 Key 设置" }));
			if (operation !== "read") {
				await screen.findByText("已配置 · 版本 2");
				fireEvent.change(screen.getByLabelText("替换个人 Relay Key"), {
					target: { value: "old-synthetic-key" },
				});
				fireEvent.click(
					screen.getByRole("button", {
						name: operation === "replace" ? "替换 Key" : "移除 Key",
					}),
				);
			}
			await waitFor(() =>
				expect(
					operation === "read" ? api.get : api[operation],
				).toHaveBeenCalledTimes(1),
			);
			if (boundary === "close-reopen") {
				fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
				await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
				fireEvent.click(screen.getByRole("button", { name: "个人 Key 设置" }));
			} else if (boundary === "other-user") {
				rerender(
					<PersonalRelayKeyEntry key="session-1-member" userId="user-other" />,
				);
			} else {
				rerender(
					<PersonalRelayKeyEntry
						key={
							boundary === "new-session"
								? "session-2-member"
								: "session-1-admin"
						}
						userId="user-owner"
					/>,
				);
				fireEvent.click(screen.getByRole("button", { name: "个人 Key 设置" }));
			}
			await screen.findByText("已配置 · 版本 11");
			const currentInput = screen.getByLabelText(
				"替换个人 Relay Key",
			) as HTMLInputElement;
			fireEvent.change(currentInput, {
				target: { value: "new-synthetic-key" },
			});
			await act(async () => {
				if (outcome === "success") pending.resolve(configured(77));
				else pending.reject(new Error("old request body must remain private"));
				await pending.promise.catch(() => undefined);
			});
			expect(screen.getByTestId("personal-key-status").textContent).toBe(
				"已配置 · 版本 11",
			);
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
