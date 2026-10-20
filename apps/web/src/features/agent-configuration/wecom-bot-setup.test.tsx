import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { client } from "../../pilot/generated/client.gen.js";
import { WecomBotSetup } from "./wecom-bot-setup.js";

const nativeWindowOpen = window.open;

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	Object.defineProperty(window, "open", {
		configurable: true,
		value: nativeWindowOpen,
	});
});
it("requires takeover acknowledgement and clears the Secret before submitting through the HTTP contract", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const bodies: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const url = new URL(input.url);
			if (url.pathname.endsWith("/wecom-bot"))
				return Response.json({ status: "connected" });
			const session = {
				sessionId: "setup",
				agentId: "agent",
				configurationRevision: 1,
				expiresAt: new Date(Date.now() + 300000).toISOString(),
				status: "awaiting_input",
			};
			if (url.pathname.endsWith("/wecom-setup"))
				return Response.json({
					...session,
					state: "fixture-state",
					qrAvailable: false,
					qrUnavailableReason: "authorization_correlation_unverified",
				});
			if (url.pathname.endsWith("/credentials")) {
				bodies.push(await input.json());
				return Response.json({ ...session, status: "verifying" });
			}
			return Response.json({ ...session, status: "active" });
		}),
	);
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	fireEvent.change(screen.getByLabelText("Bot ID"), {
		target: { value: "fixture-bot" },
	});
	fireEvent.change(screen.getByLabelText("Secret"), {
		target: { value: "fixture-secret" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "验证并绑定：企微机器人" }),
	);
	expect(bodies).toHaveLength(0);
	expect(screen.getByRole("alert").textContent).toContain("确认连接影响");
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(
		screen.getByRole("button", { name: "验证并绑定：企微机器人" }),
	);
	expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe("");
	await waitFor(() =>
		expect(bodies).toEqual([
			{
				state: "fixture-state",
				botId: "fixture-bot",
				secret: "fixture-secret",
				takeoverConfirmed: true,
			},
		]),
	);
	await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
	expect(screen.queryByLabelText(/配置标识/)).toBeNull();
	// W-26：设计手动绑定成功后给 Toast「企微机器人已连接」。
	await waitFor(() =>
		expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe(
			"企微机器人已连接",
		),
	);
});
it("uses the design copy, placeholders and a short acknowledgement (W-19 / W-21)", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ status: "not_configured" })),
	);
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	expect(document.querySelector(".wecom-channel-copy")?.textContent).toBe(
		"支持单聊与群聊，群消息和回复对群成员可见；不同发送者的会话上下文独立。Secret 只提交一次，页面不回显。",
	);
	expect(
		(screen.getByLabelText("Bot ID") as HTMLInputElement).placeholder,
	).toBe("输入 Bot ID");
	expect(
		(screen.getByLabelText("Secret") as HTMLInputElement).placeholder,
	).toBe("仅本次提交使用");
	expect(
		screen.getByRole("checkbox", { name: "我已知悉可能断开其他连接" }),
	).toBeTruthy();
});
it("gates unavailable QR on the status V2 and shows the manual fallback without creating a setup session (#2911)", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const path = new URL(input.url).pathname;
			requests.push(`${input.method} ${path}`);
			if (path.endsWith("/wecom-bot"))
				return Response.json({
					status: "not_configured",
					qrAvailable: false,
					qrUnavailableReason: "authorization_correlation_unverified",
				});
			return Response.json({ error: "unexpected" }, { status: 500 });
		}),
	);
	const open = vi.fn(() => null);
	Object.defineProperty(window, "open", { configurable: true, value: open });
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	// 状态与扫码能力只读 V2 入口。
	expect(requests).toEqual(["GET /api/v2/agents/agent/wecom-bot"]);
	// CK-09：扫码入口不要求先勾选「我已知悉」。
	const trigger = screen.getByRole("button", { name: "扫码授权" });
	fireEvent.click(trigger);
	// 能力已知不可用：点击后同步显示面板，不经过读取中的状态。
	expect(screen.getByText("扫码授权暂不可用")).toBeTruthy();
	// Toast 宿主也是 role="status"，这里只取扫码面板内的状态区域。
	const status = screen.getByText("请使用手动配置").closest('[role="status"]');
	expect(status?.getAttribute("aria-live")).toBe("polite");
	expect(status?.textContent).toContain("当前平台尚未完成授权关联校验。");
	expect(screen.getByText("扫码授权暂不可用")).toBeTruthy();
	expect(document.body.textContent).not.toContain(
		"authorization_correlation_unverified",
	);
	expect(document.body.textContent).not.toContain("请先确认连接影响");
	expect(screen.queryByRole("alert")).toBeNull();
	expect(open).not.toHaveBeenCalled();
	expect(trigger.getAttribute("aria-expanded")).toBe("true");

	// 「改用手动配置」关闭面板并聚焦 Bot ID。
	fireEvent.click(screen.getByRole("button", { name: "改用手动配置" }));
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByLabelText("Bot ID")),
	);
	expect(screen.queryByText("扫码授权暂不可用")).toBeNull();

	// 再次打开同样不请求；「关闭」把焦点交回扫码按钮。
	fireEvent.click(trigger);
	expect(await screen.findByText("扫码授权暂不可用")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "关闭" }));
	await waitFor(() => expect(document.activeElement).toBe(trigger));
	await new Promise((resolve) => setTimeout(resolve, 20));
	// AC-1：全程没有建立或取消 setup session。
	expect(requests).toEqual(["GET /api/v2/agents/agent/wecom-bot"]);
	expect(open).not.toHaveBeenCalled();
});

it("re-reads the status V2 when QR availability is unknown and never begins a setup session without it (#2911)", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const requests: string[] = [];
	const replies: Array<() => Response> = [
		// 首屏读取失败，扫码能力未知。
		() => Response.json({ error: "unavailable" }, { status: 503 }),
		// 点击后重读仍拿不到明确结论（缺少扫码能力字段）。
		() => Response.json({ status: "not_configured" }),
		// 再次点击时服务端给出不可用。
		() =>
			Response.json({
				status: "not_configured",
				qrAvailable: false,
				qrUnavailableReason: "authorization_correlation_unverified",
			}),
	];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const path = new URL(input.url).pathname;
			requests.push(`${input.method} ${path}`);
			if (path.endsWith("/wecom-bot"))
				return (replies.shift() ?? replies[0])?.() ?? Response.json({});
			return Response.json({ error: "unexpected" }, { status: 500 });
		}),
	);
	const open = vi.fn(() => null);
	Object.defineProperty(window, "open", { configurable: true, value: open });
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() =>
		expect(screen.getByText("连接状态暂不可用")).toBeTruthy(),
	);
	const trigger = screen.getByRole("button", { name: "扫码授权" });
	fireEvent.click(trigger);
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toBe(
			"扫码授权未完成，请重试或使用下方手动配置。",
		),
	);
	expect(screen.queryByText("扫码授权暂不可用")).toBeNull();
	fireEvent.click(trigger);
	expect(await screen.findByText("扫码授权暂不可用")).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();
	expect(requests).toEqual([
		"GET /api/v2/agents/agent/wecom-bot",
		"GET /api/v2/agents/agent/wecom-bot",
		"GET /api/v2/agents/agent/wecom-bot",
	]);
	expect(open).not.toHaveBeenCalled();
});

it("releases the setup session when its response disagrees with an available status V2", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const path = new URL(input.url).pathname;
			requests.push(`${input.method} ${path}`);
			if (path.endsWith("/wecom-bot"))
				return Response.json({ status: "not_configured", qrAvailable: true });
			if (path.endsWith("/cancel"))
				return Response.json({ status: "cancelled" });
			return Response.json({
				sessionId: "setup-unavailable",
				agentId: "agent",
				configurationRevision: 1,
				expiresAt: new Date(Date.now() + 300000).toISOString(),
				status: "awaiting_input",
				state: "fixture-state",
				qrAvailable: false,
				qrUnavailableReason: "authorization_correlation_unverified",
			});
		}),
	);
	const open = vi.fn(() => null);
	Object.defineProperty(window, "open", { configurable: true, value: open });
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	const trigger = screen.getByRole("button", { name: "扫码授权" });
	fireEvent.click(trigger);
	expect(await screen.findByText("扫码授权暂不可用")).toBeTruthy();
	await waitFor(() =>
		expect(requests.filter((request) => request.startsWith("POST"))).toEqual([
			"POST /api/v1/agents/agent/wecom-setup",
			"POST /api/v1/agents/agent/wecom-setup/setup-unavailable/cancel",
		]),
	);
	// 以会话响应为准记住不可用，再次打开不再建立 setup session。
	fireEvent.click(screen.getByRole("button", { name: "关闭" }));
	await waitFor(() => expect(document.activeElement).toBe(trigger));
	fireEvent.click(trigger);
	expect(screen.getByText("扫码授权暂不可用")).toBeTruthy();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(
		2,
	);
	expect(open).not.toHaveBeenCalled();
});

function qrAvailableFixture() {
	client.setConfig({ baseUrl: "https://platform.test" });
	const bodies: unknown[] = [];
	const requests: string[] = [];
	const popup = { close: vi.fn(), closed: false };
	const openPopup = vi.fn(() => popup);
	const expiresAt = new Date(Date.now() + 60_000).toISOString();
	Object.defineProperty(window, "open", {
		configurable: true,
		value: openPopup,
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const url = new URL(input.url);
			requests.push(`${input.method} ${url.pathname}`);
			// 状态 V2 先确认扫码可用，之后才建立 setup session（#2911）。
			if (url.pathname.endsWith("/wecom-bot"))
				return Response.json({ status: "not_configured", qrAvailable: true });
			if (url.pathname.endsWith("/wecom-setup") && input.method === "POST")
				return Response.json({
					sessionId: "setup-qr",
					agentId: "agent",
					configurationRevision: 1,
					expiresAt,
					status: "awaiting_input",
					state: "qr-state",
					qrAvailable: true,
					qr: {
						authorizationUrl: "https://auth.example.test/authorize",
						authOrigin: "https://auth.example.test",
						source: "agent-infra",
						state: "qr-state",
					},
				});
			if (url.pathname.endsWith("/credentials")) {
				bodies.push(await input.json());
				return Response.json({ status: "verifying" });
			}
			if (url.pathname.endsWith("/cancel"))
				return Response.json({ status: "cancelled" });
			return Response.json({ status: "active" });
		}),
	);
	const scan = () =>
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: "https://auth.example.test",
				source: popup as unknown as MessageEventSource,
				data: {
					source: "agent-infra",
					state: "qr-state",
					botId: "qr-bot",
					secret: "qr-secret",
				},
			}),
		);
	return { bodies, requests, openPopup, scan };
}

it("opens the QR window without the manual acknowledgement and submits once only after confirming in the panel (CK-09)", async () => {
	const { bodies, openPopup, scan } = qrAvailableFixture();
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	fireEvent.click(screen.getByRole("button", { name: "扫码授权" }));
	const openWindow = await screen.findByRole("button", {
		name: "打开扫码窗口",
	});
	expect(openPopup).not.toHaveBeenCalled();
	// 扫码前不需要勾选上方「我已知悉」：按钮可用，也没有要求先勾选的提示。
	expect(
		(screen.getByRole("checkbox") as HTMLButtonElement).getAttribute(
			"aria-checked",
		),
	).toBe("false");
	expect(openWindow.hasAttribute("disabled")).toBe(false);
	expect(document.body.textContent).not.toContain("请先勾选");
	fireEvent.click(openWindow);
	expect(openPopup).toHaveBeenCalledExactlyOnceWith(
		"https://auth.example.test/authorize",
		"wecom-qr",
	);
	scan();
	// 扫码完成后在面板内就地确认影响；确认前不提交凭证，Secret 不进入页面。
	const confirm = await screen.findByRole("button", { name: "确认并绑定" });
	await waitFor(() => expect(document.activeElement).toBe(confirm));
	expect(
		document
			.getElementById(confirm.getAttribute("aria-describedby") ?? "")
			?.textContent?.startsWith(
				"连接此机器人可能断开它在其他服务中的现有连接。",
			),
	).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(bodies).toEqual([]);
	expect(document.body.innerHTML).not.toContain("qr-secret");
	expect(
		screen
			.getByRole("button", { name: "验证并绑定：企微机器人" })
			.hasAttribute("disabled"),
	).toBe(true);
	fireEvent.click(confirm);
	fireEvent.click(confirm);
	await waitFor(() =>
		expect(bodies).toEqual([
			{
				state: "qr-state",
				botId: "qr-bot",
				secret: "qr-secret",
				takeoverConfirmed: true,
			},
		]),
	);
	expect(screen.queryByRole("button", { name: "确认并绑定" })).toBeNull();
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByRole("heading", { name: "企微机器人" }),
		),
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(bodies).toHaveLength(1);
	// W-26：扫码确认后的绑定成功同样给 Toast，焦点仍留在卡片标题。
	await waitFor(() =>
		expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe(
			"企微机器人已连接",
		),
	);
	expect(document.activeElement).toBe(
		screen.getByRole("heading", { name: "企微机器人" }),
	);
});

it("discards a scanned QR result without submitting when the Owner cancels the confirmation (CK-09)", async () => {
	const { bodies, requests, scan } = qrAvailableFixture();
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	const trigger = screen.getByRole("button", { name: "扫码授权" });
	fireEvent.click(trigger);
	fireEvent.click(await screen.findByRole("button", { name: "打开扫码窗口" }));
	scan();
	await screen.findByRole("button", { name: "确认并绑定" });
	expect((screen.getByLabelText("Bot ID") as HTMLInputElement).value).toBe(
		"qr-bot",
	);
	fireEvent.click(screen.getByRole("button", { name: "取消" }));
	await waitFor(() => expect(document.activeElement).toBe(trigger));
	expect(screen.queryByRole("button", { name: "确认并绑定" })).toBeNull();
	expect((screen.getByLabelText("Bot ID") as HTMLInputElement).value).toBe("");
	await waitFor(() =>
		expect(requests).toContain(
			"POST /api/v1/agents/agent/wecom-setup/setup-qr/cancel",
		),
	);
	expect(bodies).toEqual([]);
	expect(
		requests.filter((request) => request.endsWith("/credentials")),
	).toEqual([]);
});

it.each([0, 408, 429, 500, 503])(
	"reconciles an ambiguous submission response %s without claiming authentication failure",
	async (status) => {
		client.setConfig({ baseUrl: "https://platform.test" });
		const session = {
			sessionId: "setup",
			agentId: "agent",
			configurationRevision: 1,
			expiresAt: new Date(Date.now() + 300000).toISOString(),
		};
		let reads = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Request) => {
				const path = new URL(input.url).pathname;
				if (path.endsWith("/wecom-bot"))
					return Response.json({ status: "connected" });
				if (path.endsWith("/wecom-setup"))
					return Response.json({
						...session,
						state: "fixture",
						status: "awaiting_input",
						qrAvailable: false,
					});
				if (path.endsWith("/credentials")) {
					if (status)
						return Response.json({ error: "upstream unavailable" }, { status });
					throw new TypeError("Network lost after commit");
				}
				reads++;
				return Response.json({ ...session, status: "active" });
			}),
		);
		render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
		fireEvent.change(screen.getByLabelText("Bot ID"), {
			target: { value: "bot" },
		});
		fireEvent.change(screen.getByLabelText("Secret"), {
			target: { value: "fixture" },
		});
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(
			screen.getByRole("button", { name: "验证并绑定：企微机器人" }),
		);
		await waitFor(() => expect(reads).toBe(1));
		await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
		expect(screen.queryByRole("alert")).toBeNull();
	},
);
it("keeps the pending configuration when cancellation is unconfirmed", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const session = {
		sessionId: "setup",
		agentId: "agent",
		configurationRevision: 1,
		expiresAt: new Date(Date.now() + 300000).toISOString(),
		status: "verifying",
	};
	let setupReads = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const path = new URL(input.url).pathname;
			if (path.endsWith("/wecom-bot"))
				return Response.json({ status: "not_configured" });
			if (
				path.includes("/wecom-setup") &&
				!path.endsWith("/cancel") &&
				!path.endsWith("/credentials")
			) {
				setupReads++;
				return Response.json({
					...session,
					state: "fixture",
					qrAvailable: false,
				});
			}
			if (path.endsWith("/cancel"))
				return Response.json({ error: "unavailable" }, { status: 503 });
			return Response.json(session);
		}),
	);
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	fireEvent.change(screen.getByLabelText("Bot ID"), {
		target: { value: "bot" },
	});
	fireEvent.change(screen.getByLabelText("Secret"), {
		target: { value: "fixture" },
	});
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(
		screen.getByRole("button", { name: "验证并绑定：企微机器人" }),
	);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "取消配置：企微机器人" }),
		).toBeTruthy(),
	);
	// 忙碌态的可访问名称随可见文字变化，且仍带对象名（N-12）。
	expect(
		screen.getByRole("button", { name: "验证中…：企微机器人" }),
	).toBeTruthy();
	// Wait for submission before testing cancellation.
	await waitFor(() =>
		expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe(
			"",
		),
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	fireEvent.click(screen.getByRole("button", { name: "取消配置：企微机器人" }));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toContain("取消结果未确认"),
	);
	await waitFor(() => expect(setupReads).toBeGreaterThan(2));
	expect(
		screen.getByRole("button", { name: "取消配置：企微机器人" }),
	).toBeTruthy();
});
it("ignores a late cancellation response after switching Agents", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const cancellation = Promise.withResolvers<Response>();
	let cancelStarted!: () => void;
	const cancelRequest = new Promise<void>((resolve) => {
		cancelStarted = resolve;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const path = new URL(input.url).pathname;
			if (path.endsWith("/wecom-bot"))
				return Response.json({ status: "connected" });
			if (path.endsWith("/wecom-setup"))
				return Response.json({
					sessionId: "setup",
					agentId: "agent-a",
					configurationRevision: 1,
					expiresAt: new Date(Date.now() + 300000).toISOString(),
					status: "awaiting_input",
					state: "fixture",
					qrAvailable: false,
				});
			if (path.endsWith("/credentials"))
				return Response.json({ sessionId: "setup", status: "verifying" });
			if (path.endsWith("/cancel")) {
				cancelStarted();
				return cancellation.promise;
			}
			return Response.json({ status: "verifying" });
		}),
	);
	const rendered = render(<WecomBotSetup agentId="agent-a" />, {
		wrapper: ToastProvider,
	});
	fireEvent.change(screen.getByLabelText("Bot ID"), {
		target: { value: "bot" },
	});
	fireEvent.change(screen.getByLabelText("Secret"), {
		target: { value: "fixture" },
	});
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(
		screen.getByRole("button", { name: "验证并绑定：企微机器人" }),
	);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "取消配置：企微机器人" }),
		).toBeTruthy(),
	);
	fireEvent.click(screen.getByRole("button", { name: "取消配置：企微机器人" }));
	await cancelRequest;
	rendered.rerender(<WecomBotSetup agentId="agent-b" />);
	cancellation.resolve(Response.json({ status: "cancelled" }));
	await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
	expect(screen.queryByRole("alert")).toBeNull();
});
it("clears a previously connected status when refresh fails", async () => {
	let online = true;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			if (!online) throw new TypeError("unavailable");
			return Response.json({ status: "connected" });
		}),
	);
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
	online = false;
	fireEvent.click(screen.getByRole("button", { name: "刷新状态：企微机器人" }));
	await waitFor(() =>
		expect(screen.getByText("连接状态暂不可用")).toBeTruthy(),
	);
});

it.each([400, 403, 409])(
	"releases the form after a confirmed HTTP %s credential rejection",
	async (status) => {
		client.setConfig({ baseUrl: "https://platform.test" });
		let reads = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Request) => {
				const path = new URL(input.url).pathname;
				if (path.endsWith("/wecom-bot"))
					return Response.json({ status: "not_configured" });
				if (path.endsWith("/wecom-setup"))
					return Response.json({
						sessionId: "setup",
						state: "fixture",
						status: "awaiting_input",
					});
				if (path.endsWith("/credentials"))
					return Response.json({ error: "rejected" }, { status });
				reads++;
				return Response.json({ status: "awaiting_input" });
			}),
		);
		render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
		fireEvent.change(screen.getByLabelText("Bot ID"), {
			target: { value: "bot" },
		});
		fireEvent.change(screen.getByLabelText("Secret"), {
			target: { value: "fixture" },
		});
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(
			screen.getByRole("button", { name: "验证并绑定：企微机器人" }),
		);
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("提交被拒绝"),
		);
		expect(
			(
				screen.getByRole("button", {
					name: "验证并绑定：企微机器人",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
		expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe(
			"",
		);
		expect(
			screen.queryByRole("button", { name: "取消配置：企微机器人" }),
		).toBeNull();
		expect(reads).toBe(0);
	},
);

it("ignores an older connection status response after a newer refresh", async () => {
	const initial = Promise.withResolvers<Response>();
	let reads = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			++reads === 1 ? initial.promise : Response.json({ status: "connected" }),
		),
	);
	render(<WecomBotSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() => expect(reads).toBe(1));
	fireEvent.click(screen.getByRole("button", { name: "刷新状态：企微机器人" }));
	await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
	initial.resolve(Response.json({ status: "not_configured" }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(screen.getByText("已连接")).toBeTruthy();
	expect(screen.queryByText("未配置")).toBeNull();
});

it("refreshes transitional connection status until authentication settles", async () => {
	vi.useFakeTimers();
	client.setConfig({ baseUrl: "https://platform.test" });
	let reads = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				status: ["disconnected", "verifying", "connected"][
					Math.min(reads++, 2)
				],
			}),
		),
	);
	try {
		const rendered = render(<WecomBotSetup agentId="agent" />, {
			wrapper: ToastProvider,
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.getByText("已断开")).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(screen.getByText("验证中")).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(screen.getByText("已连接")).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});
		expect(reads).toBe(3);
		rendered.unmount();
	} finally {
		vi.useRealTimers();
	}
});

function connectedBotFetch(requests: string[] = []) {
	const state = { status: "connected" };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			requests.push(`${input.method} ${new URL(input.url).pathname}`);
			return Response.json({ status: state.status });
		}),
	);
	return { requests, state };
}

it("confirms the bot unbind in a modal before sending its own request", async () => {
	const { requests, state } = connectedBotFetch();
	const unbind = Promise.withResolvers<void>();
	const unbindChannel = vi.fn(() => unbind.promise);
	render(<WecomBotSetup agentId="agent" unbindChannel={unbindChannel} />, {
		wrapper: ToastProvider,
	});
	const trigger = await screen.findByRole("button", {
		name: "解除绑定：企微机器人",
	});
	expect(trigger.textContent).toBe("解除绑定");
	fireEvent.click(trigger);
	const dialog = await screen.findByRole("dialog", {
		name: "解除企微机器人绑定？",
	});
	expect(dialog.getAttribute("aria-modal")).toBe("true");
	expect(dialog.textContent).toContain(
		"解除后平台停止向该入口投递新消息；已有会话和历史保留。",
	);
	expect(
		within(dialog)
			.getAllByRole("button")
			.slice(-2)
			.map((button) => button.textContent),
	).toEqual(["取消", "确认解除"]);
	fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	await waitFor(() => expect(document.activeElement).toBe(trigger));
	expect(unbindChannel).not.toHaveBeenCalled();

	fireEvent.click(trigger);
	fireEvent.click(
		within(
			await screen.findByRole("dialog", { name: "解除企微机器人绑定？" }),
		).getByRole("button", { name: "确认解除" }),
	);
	expect(unbindChannel).toHaveBeenCalledOnce();
	expect(
		screen.getByRole("button", { name: "正在解除…：企微机器人" }),
	).toBeTruthy();
	expect(
		screen
			.getByRole("button", { name: "刷新状态：企微机器人" })
			.hasAttribute("disabled"),
	).toBe(true);
	const before = requests.length;
	state.status = "not_configured";
	unbind.resolve();
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	expect(screen.queryByRole("button", { name: /^解除绑定/ })).toBeNull();
	// 触发按钮消失后焦点落在卡片标题；只回读连接状态，不发其他写请求。
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByRole("heading", { name: "企微机器人" }),
		),
	);
	expect(
		requests.slice(before).every((request) => request.startsWith("GET")),
	).toBe(true);
	expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe(
		"企微机器人已解除绑定",
	);
});

it("keeps the bot status and explains a failed unbind inside the card", async () => {
	connectedBotFetch();
	const unbindChannel = vi.fn(() => Promise.reject(new Error("503")));
	render(<WecomBotSetup agentId="agent" unbindChannel={unbindChannel} />, {
		wrapper: ToastProvider,
	});
	fireEvent.click(
		await screen.findByRole("button", { name: "解除绑定：企微机器人" }),
	);
	fireEvent.click(
		within(
			await screen.findByRole("dialog", { name: "解除企微机器人绑定？" }),
		).getByRole("button", { name: "确认解除" }),
	);
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toBe(
			"解除绑定未完成，请重试。",
		),
	);
	expect(screen.getByText("已连接")).toBeTruthy();
	expect(
		screen.getByRole("button", { name: "解除绑定：企微机器人" }),
	).toBeTruthy();
	expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe("");
});

it("shows the bot card status as a design chip and blocks implicit submission from its inputs", async () => {
	connectedBotFetch();
	const onSubmit = vi.fn((event: Event) => event.preventDefault());
	render(
		<form onSubmit={(event) => onSubmit(event.nativeEvent)}>
			<WecomBotSetup agentId="agent" />
		</form>,
		{ wrapper: ToastProvider },
	);
	const chip = await screen.findByText("已连接");
	expect(chip.getAttribute("data-slot")).toBe("badge");
	expect(chip.getAttribute("data-variant")).toBe("chip");
	expect(chip.getAttribute("data-tone")).toBe("green");
	expect(
		screen
			.getByRole("region", { name: "企微机器人" })
			.getAttribute("data-status"),
	).toBe("connected");
	expect(screen.getByText("智能机器人 · 长连接")).toBeTruthy();
	for (const label of ["Bot ID", "Secret"]) {
		const input = screen.getByLabelText(label);
		// 输入框以 <label> 文本为名称（NI-107），按 Enter 时取消默认的隐式提交（O-09）。
		expect(input.getAttribute("aria-label")).toBeNull();
		expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
	}
	expect(onSubmit).not.toHaveBeenCalled();
	// 区分同名按钮的可访问名称以可见文字开头（NI-107）。
	for (const visible of ["验证并绑定", "刷新状态"])
		expect(
			screen.getByRole("button", { name: `${visible}：企微机器人` })
				.textContent,
		).toBe(visible);
});
