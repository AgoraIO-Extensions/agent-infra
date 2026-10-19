import {
	act,
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
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
	await screen.findByText("等待 Connection 确认");
	expect(screen.queryByRole("button", { name: "开始安装" })).toBeNull();
	expect(screen.getByRole("button", { name: "打开授权页" })).toBeTruthy();
	expect(window.open).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "打开授权页" }));
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
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
	await waitFor(() =>
		expect(
			screen.getByText("暂时无法开始 Connection 安装，请稍后重试。"),
		).toBeTruthy(),
	);
	expect(window.open).not.toHaveBeenCalled();
});

it("fails closed when the authorization URL is absent", async () => {
	api.beginPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 202 },
		data: {
			schemaVersion: 1,
			authorizationId: "authorization-1",
			status: "awaiting_confirmation",
			expiresAt: Date.now() + 60_000,
		},
	});
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
	await waitFor(() =>
		expect(
			screen.getByText("授权入口不可用，平台已拒绝继续安装。"),
		).toBeTruthy(),
	);
	expect(screen.queryByRole("button", { name: "查询状态" })).toBeNull();
	expect(window.open).not.toHaveBeenCalled();
});

it("polls awaiting confirmation into a terminal confirmed state", async () => {
	vi.useFakeTimers();
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
	api.readPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 200 },
		data: {
			schemaVersion: 1,
			authorizationId: "authorization-1",
			status: "confirmed",
			expiresAt: Date.now() + 60_000,
		},
	});
	try {
		render(<ConnectionInstallationPanel executionId="execution-1" />);
		fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
		await act(async () => {
			await Promise.resolve();
		});
		expect(screen.getByText("等待 Connection 确认")).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(screen.getByText("已确认")).toBeTruthy();
		expect(api.readPlatformConnectionInstallationV1).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

it("bounds polling attempts after status failures", async () => {
	vi.useFakeTimers();
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
	api.readPlatformConnectionInstallationV1.mockRejectedValue(
		new Error("offline"),
	);
	try {
		render(<ConnectionInstallationPanel executionId="execution-1" />);
		fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
		await act(async () => {
			await Promise.resolve();
		});
		expect(screen.getByText("等待 Connection 确认")).toBeTruthy();
		for (let attempt = 0; attempt < 30; attempt++)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2_000);
				await Promise.resolve();
			});
		expect(api.readPlatformConnectionInstallationV1).toHaveBeenCalledTimes(30);
		expect(screen.getByText("轮询已暂停，请稍后重新读取状态。")).toBeTruthy();
	} finally {
		vi.useRealTimers();
	}
});

it.each(["confirmed", "revoked", "expired", "unknown"] as const)(
	"renders terminal installation state %s",
	async (status) => {
		api.beginPlatformConnectionInstallationV1.mockResolvedValue({
			response: { status: 202 },
			data: {
				schemaVersion: 1,
				authorizationId: "authorization-1",
				status,
				expiresAt: Date.now() + 60_000,
			},
		});
		render(<ConnectionInstallationPanel executionId="execution-1" />);
		fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
		await waitFor(() =>
			expect(
				screen.getByText(
					status === "confirmed"
						? "已确认"
						: status === "revoked"
							? "已撤销"
							: status === "expired"
								? "已过期"
								: "状态待核实",
				),
			).toBeTruthy(),
		);
	},
);

it("does not render credential-shaped response fields", async () => {
	api.beginPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 202 },
		data: {
			schemaVersion: 1,
			authorizationId: "authorization-1",
			status: "confirmed",
			expiresAt: Date.now() + 60_000,
			token: "secret-material",
		},
	});
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
	await waitFor(() =>
		expect(
			screen.getByText("暂时无法开始 Connection 安装，请稍后重试。"),
		).toBeTruthy(),
	);
	expect(screen.queryByText("secret-material")).toBeNull();
});
