import {
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
import { WecomAppSetup } from "./wecom-app-setup.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("submits the application setup contract and clears write-only fields", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const bodies: unknown[] = [];
	let reads = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			const path = new URL(input.url).pathname;
			if (path.endsWith("/wecom-app"))
				return Response.json({
					status: reads ? "connected" : "not_configured",
				});
			if (path.endsWith("/wecom-app-setup"))
				return Response.json({
					sessionId: "setup",
					state: "state",
					callbackUrl: "https://callback.test",
					status: "awaiting_input",
				});
			if (path.endsWith("/credentials")) {
				bodies.push(await input.json());
				return Response.json({ sessionId: "setup", status: "verifying" });
			}
			reads++;
			return Response.json({ sessionId: "setup", status: "active" });
		}),
	);
	render(<WecomAppSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	// Owner 配置同页还有授权目标的「应用 ID」，这里的名称带卡片标题「企微应用」（N-12、O-07）。
	expect(screen.getByRole("textbox", { name: "应用 ID：企微应用" }).id).toBe(
		"wecom-app-application-id",
	);
	for (const [label, value] of [
		["企业 ID", "corp"],
		["应用 ID", "123"],
		["应用 Secret", "secret"],
		["回调 Token", "token"],
		["EncodingAESKey", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"],
	] as const)
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "验证并绑定：企微应用" }));
	expect((screen.getByLabelText("应用 Secret") as HTMLInputElement).value).toBe(
		"",
	);
	expect((screen.getByLabelText("回调 Token") as HTMLInputElement).value).toBe(
		"",
	);
	expect(
		(screen.getByLabelText("EncodingAESKey") as HTMLInputElement).value,
	).toBe("");
	await waitFor(() => expect(bodies).toHaveLength(1));
	expect(bodies[0]).toMatchObject({
		corporationId: "corp",
		applicationId: "123",
		secret: "secret",
		token: "token",
		takeoverConfirmed: true,
		state: "state",
	});
	await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
	expect(reads).toBe(1);
	// W-26：设计绑定成功后给 Toast「企微应用已连接」。
	await waitFor(() =>
		expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe(
			"企微应用已连接",
		),
	);
});
it("uses the design copy, placeholders and a short acknowledgement (W-19 / W-21)", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ status: "not_configured" })),
	);
	render(<WecomAppSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	expect(document.querySelector(".wecom-channel-copy")?.textContent).toBe(
		"配置企业 ID、应用 ID 和回调材料。验证期间保留原绑定，Secret 类字段只保存密文状态。",
	);
	for (const [label, placeholder] of [
		["企业 ID", "输入企业 ID"],
		["应用 ID", "输入应用 ID"],
		["应用 Secret", "仅本次提交使用"],
		["回调 Token", "输入回调 Token"],
		["EncodingAESKey", "输入 43 位密钥"],
	] as const)
		expect((screen.getByLabelText(label) as HTMLInputElement).placeholder).toBe(
			placeholder,
		);
	expect(
		screen.getByRole("checkbox", { name: "我已知悉可能影响现有回调" }),
	).toBeTruthy();
});

function fillCredentials() {
	for (const [label, value] of [
		["企业 ID", "corp"],
		["应用 ID", "123"],
		["应用 Secret", "fixture"],
		["回调 Token", "fixture-token"],
		["EncodingAESKey", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"],
	])
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	fireEvent.click(screen.getByRole("checkbox", { name: /我已知悉/ }));
	fireEvent.click(screen.getByRole("button", { name: "验证并绑定：企微应用" }));
}
it.each([429, 503])(
	"retries setup status HTTP %s without resubmitting credentials",
	async (code) => {
		client.setConfig({ baseUrl: "https://platform.test" });
		let reads = 0;
		let submissions = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (request: Request) => {
				const path = new URL(request.url).pathname;
				if (path.endsWith("/wecom-app"))
					return Response.json({
						status: reads >= 2 ? "connected" : "not_configured",
					});
				if (path.endsWith("/wecom-app-setup"))
					return Response.json({
						sessionId: "setup",
						state: "fixture-state",
						callbackUrl: "https://callback.test",
						status: "awaiting_input",
					});
				if (path.endsWith("/credentials")) {
					submissions++;
					throw new TypeError("Unknown result");
				}
				reads++;
				return reads === 1
					? Response.json({}, { status: code })
					: Response.json({ status: "active" });
			}),
		);
		render(<WecomAppSetup agentId="agent" />, { wrapper: ToastProvider });
		await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
		fillCredentials();
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("请勿重复提交"),
		);
		await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy(), {
			timeout: 3500,
		});
		expect(submissions).toBe(1);
	},
);
it("cancels a pending setup without unbinding the existing application", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const unbindChannel = vi.fn(async () => undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (request: Request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/wecom-app"))
				return Response.json({ status: "connected" });
			if (path.endsWith("/wecom-app-setup"))
				return Response.json({
					sessionId: "setup",
					state: "fixture-state",
					callbackUrl: "https://callback.test",
					status: "awaiting_input",
				});
			return Response.json({
				status: path.endsWith("/cancel") ? "cancelled" : "verifying",
			});
		}),
	);
	render(<WecomAppSetup agentId="agent" unbindChannel={unbindChannel} />, {
		wrapper: ToastProvider,
	});
	await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
	fillCredentials();
	await waitFor(() =>
		expect(screen.getByText(/https:\/\/callback.test/)).toBeTruthy(),
	);
	fireEvent.click(screen.getByRole("button", { name: "取消配置：企微应用" }));
	await waitFor(() =>
		expect(
			screen.queryByRole("button", { name: "取消配置：企微应用" }),
		).toBeNull(),
	);
	expect(screen.getByText("已连接")).toBeTruthy();
	expect(unbindChannel).not.toHaveBeenCalled();
});

it("restores a pending session after reload so the Owner can cancel it", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	let cancelled = false;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (request: Request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/wecom-app"))
				return Response.json(
					cancelled
						? { status: "not_configured" }
						: { status: "verifying", sessionId: "pending" },
				);
			if (path.endsWith("/wecom-app-setup/pending/cancel")) {
				cancelled = true;
				return Response.json({ status: "cancelled" });
			}
			if (path.endsWith("/wecom-app-setup/pending"))
				return Response.json({ status: "verifying", sessionId: "pending" });
			return Response.json({ status: "verifying" });
		}),
	);
	render(<WecomAppSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "取消配置：企微应用" }),
		).toBeTruthy(),
	);
	fireEvent.click(screen.getByRole("button", { name: "取消配置：企微应用" }));
	await waitFor(() =>
		expect(
			screen.queryByRole("button", { name: "取消配置：企微应用" }),
		).toBeNull(),
	);
});

it("keeps the application binding visible until the confirmed unbind succeeds", async () => {
	client.setConfig({ baseUrl: "https://platform.test" });
	const state = { status: "connected" };
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				status: state.status,
				...(state.status === "connected"
					? { callbackUrl: "https://callback.test" }
					: {}),
			}),
		),
	);
	const unbind = Promise.withResolvers<void>();
	const unbindChannel = vi.fn(() => unbind.promise);
	render(<WecomAppSetup agentId="agent" unbindChannel={unbindChannel} />, {
		wrapper: ToastProvider,
	});
	const trigger = await screen.findByRole("button", {
		name: "解除绑定：企微应用",
	});
	fireEvent.click(trigger);
	// 标题与对象一致：应用卡只出现「解除企微应用绑定？」（NI-12）。
	const dialog = await screen.findByRole("dialog", {
		name: "解除企微应用绑定？",
	});
	expect(screen.queryByText("解除企微机器人绑定？")).toBeNull();
	// 确认前不发请求，卡片状态与回调 URL 保持原样。
	expect(unbindChannel).not.toHaveBeenCalled();
	expect(screen.getByText("已连接")).toBeTruthy();
	expect(screen.getByText(/callback.test/)).toBeTruthy();
	fireEvent.click(within(dialog).getByRole("button", { name: "确认解除" }));
	expect(unbindChannel).toHaveBeenCalledOnce();
	expect(screen.getByText("已连接")).toBeTruthy();
	state.status = "not_configured";
	unbind.resolve();
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	expect(screen.queryByText(/callback.test/)).toBeNull();
	expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe(
		"企微应用已解除绑定",
	);
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByRole("heading", { name: "企微应用" }),
		),
	);
});

it("blocks implicit submission from every application input", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ status: "not_configured" })),
	);
	render(<WecomAppSetup agentId="agent" />, { wrapper: ToastProvider });
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	for (const label of [
		"企业 ID",
		"应用 ID",
		"应用 Secret",
		"回调 Token",
		"EncodingAESKey",
	])
		expect(
			fireEvent.keyDown(screen.getByLabelText(label), { key: "Enter" }),
		).toBe(false);
	expect(
		screen
			.getByRole("region", { name: "企微应用" })
			.getAttribute("data-status"),
	).toBe("not_configured");
	expect(screen.getByText("应用入口 · 支持回调验证")).toBeTruthy();
	expect(screen.queryByRole("button", { name: /扫码/ })).toBeNull();
});
