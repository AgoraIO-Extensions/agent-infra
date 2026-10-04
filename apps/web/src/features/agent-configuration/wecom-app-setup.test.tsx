import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
	render(<WecomAppSetup agentId="agent" onUnbind={vi.fn()} />);
	await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());
	for (const [label, value] of [
		["企业 ID", "corp"],
		["应用 ID", "123"],
		["应用 Secret", "secret"],
		["回调 Token", "token"],
		["EncodingAESKey", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"],
	] as const)
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));
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
	fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));
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
		render(<WecomAppSetup agentId="agent" onUnbind={vi.fn()} />);
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
	const onUnbind = vi.fn();
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
	render(<WecomAppSetup agentId="agent" onUnbind={onUnbind} />);
	await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
	fillCredentials();
	await waitFor(() =>
		expect(screen.getByText(/https:\/\/callback.test/)).toBeTruthy(),
	);
	fireEvent.click(screen.getByRole("button", { name: "取消配置" }));
	await waitFor(() =>
		expect(screen.queryByRole("button", { name: "取消配置" })).toBeNull(),
	);
	expect(screen.getByText("已连接")).toBeTruthy();
	expect(onUnbind).not.toHaveBeenCalled();
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
	render(<WecomAppSetup agentId="agent" onUnbind={vi.fn()} />);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "取消配置" })).toBeTruthy(),
	);
	fireEvent.click(screen.getByRole("button", { name: "取消配置" }));
	await waitFor(() =>
		expect(screen.queryByRole("button", { name: "取消配置" })).toBeNull(),
	);
});
