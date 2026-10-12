import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
	render(<WecomBotSetup agentId="agent" onUnbind={vi.fn()} />);
	fireEvent.change(screen.getByLabelText("Bot ID"), {
		target: { value: "fixture-bot" },
	});
	fireEvent.change(screen.getByLabelText("Secret"), {
		target: { value: "fixture-secret" },
	});
	fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));
	expect(bodies).toHaveLength(0);
	expect(screen.getByRole("alert").textContent).toContain("确认连接影响");
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));
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
	expect(screen.queryByLabelText("智能机器人配置标识")).toBeNull();
});
it("explains unavailable QR without fabricating a successful binding", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ status: "not_configured" })),
	);
	Object.defineProperty(window, "open", {
		configurable: true,
		value: vi.fn(() => null),
	});
	render(<WecomBotSetup agentId="agent" onUnbind={vi.fn()} />);
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "扫码授权" }));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toBe(
			"扫码授权暂不可用，请使用下方手动配置。",
		),
	);
});

it("submits configured QR credentials only after takeover confirmation", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const bodies: unknown[] = [];
	const popup = { close: vi.fn(), location: { href: "about:blank" } };
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
			if (url.pathname.endsWith("/wecom-bot"))
				return Response.json({ status: "not_configured" });
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
			return Response.json({ status: "active" });
		}),
	);
	render(<WecomBotSetup agentId="agent" onUnbind={vi.fn()} />);
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "扫码授权" }));
	await waitFor(() => expect(openPopup).toHaveBeenCalled());
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
		render(<WecomBotSetup agentId="agent" onUnbind={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("Bot ID"), {
			target: { value: "bot" },
		});
		fireEvent.change(screen.getByLabelText("Secret"), {
			target: { value: "fixture" },
		});
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));
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
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const path = new URL(input.url).pathname;
			if (path.endsWith("/wecom-bot"))
				return Response.json({ status: "not_configured" });
			if (path.endsWith("/wecom-setup"))
				return Response.json({
					...session,
					state: "fixture",
					qrAvailable: false,
				});
			if (path.endsWith("/cancel"))
				return Response.json({ error: "unavailable" }, { status: 503 });
			return Response.json(session);
		}),
	);
	render(<WecomBotSetup agentId="agent" onUnbind={vi.fn()} />);
	fireEvent.change(screen.getByLabelText("Bot ID"), {
		target: { value: "bot" },
	});
	fireEvent.change(screen.getByLabelText("Secret"), {
		target: { value: "fixture" },
	});
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "取消配置" })).toBeTruthy(),
	);
	// Wait for submission before testing cancellation.
	await waitFor(() =>
		expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe(
			"",
		),
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	fireEvent.click(screen.getByRole("button", { name: "取消配置" }));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toContain("取消结果未确认"),
	);
	expect(screen.getByRole("button", { name: "取消配置" })).toBeTruthy();
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
	const rendered = render(
		<WecomBotSetup agentId="agent-a" onUnbind={vi.fn()} />,
	);
	fireEvent.change(screen.getByLabelText("Bot ID"), {
		target: { value: "bot" },
	});
	fireEvent.change(screen.getByLabelText("Secret"), {
		target: { value: "fixture" },
	});
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "取消配置" })).toBeTruthy(),
	);
	fireEvent.click(screen.getByRole("button", { name: "取消配置" }));
	await cancelRequest;
	rendered.rerender(<WecomBotSetup agentId="agent-b" onUnbind={vi.fn()} />);
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
	render(<WecomBotSetup agentId="agent" onUnbind={vi.fn()} />);
	await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
	online = false;
	fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
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
		render(<WecomBotSetup agentId="agent" onUnbind={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("Bot ID"), {
			target: { value: "bot" },
		});
		fireEvent.change(screen.getByLabelText("Secret"), {
			target: { value: "fixture" },
		});
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("提交被拒绝"),
		);
		expect(
			(screen.getByRole("button", { name: "验证并绑定" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe(
			"",
		);
		expect(screen.queryByRole("button", { name: "取消配置" })).toBeNull();
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
	render(<WecomBotSetup agentId="agent" onUnbind={vi.fn()} />);
	await waitFor(() => expect(reads).toBe(1));
	fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
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
		const rendered = render(
			<WecomBotSetup agentId="agent" onUnbind={vi.fn()} />,
		);
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
