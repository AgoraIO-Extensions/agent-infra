import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	beginPlatformConnectionInstallationV1: vi.fn(),
	readPlatformConnectionInstallationV1: vi.fn(),
}));
vi.mock("../../pilot/generated-v2/sdk.gen.js", () => api);

import { ConnectionInstallationPanel } from "./connection-installation-panel.js";

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("open", vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("opens a validated authorization URL and shows awaiting status", async () => {
	api.beginPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 202 },
		data: {
			schemaVersion: 1,
			authorizationId: "authorization-1",
			status: "awaiting_confirmation",
			expiresAt: Date.now() + 60_000,
			authorizationUrl: "https://connector.test/authorize?state=x",
		},
	});
	render(
		<ConnectionInstallationPanel
			conversationId="conversation-1"
			executionId="execution-1"
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
	await screen.findByText("等待 Connection 确认");
	expect(screen.queryByRole("button", { name: "开始安装" })).toBeNull();
	expect(screen.getByRole("button", { name: "查询状态" })).toBeTruthy();
	expect(window.open).toHaveBeenCalledWith(
		"https://connector.test/authorize?state=x",
		"_blank",
		"noopener,noreferrer",
	);
});

it("does not open an invalid authorization URL", async () => {
	api.beginPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 202 },
		data: {
			schemaVersion: 1,
			authorizationId: "authorization-1",
			status: "awaiting_confirmation",
			expiresAt: Date.now() + 60_000,
			authorizationUrl: "http://connector.test/authorize",
		},
	});
	render(
		<ConnectionInstallationPanel
			conversationId="conversation-1"
			executionId="execution-1"
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
	await waitFor(() =>
		expect(
			screen.getByText("暂时无法开始 Connection 安装，请稍后重试。"),
		).toBeTruthy(),
	);
	expect(window.open).not.toHaveBeenCalled();
});
