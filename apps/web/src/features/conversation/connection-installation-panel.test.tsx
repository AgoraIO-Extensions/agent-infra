import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Client } from "../../pilot/generated-v2/client/index.js";

const api = vi.hoisted(() => ({
	beginPlatformConnectionInstallationV1: vi.fn(),
	confirmPlatformConnectionInstallationV1: vi.fn(),
	readPlatformConnectionInstallationV1: vi.fn(),
}));
vi.mock("../../pilot/generated-v2/sdk.gen.js", () => api);

import { ConnectionInstallationPanel } from "./connection-installation-panel.js";

type Status =
	| "awaiting_confirmation"
	| "confirmed"
	| "unknown"
	| "expired"
	| "revoked";
function projection(status: Status = "awaiting_confirmation") {
	return {
		schemaVersion: 1,
		authorizationId: "authorization-1",
		status,
		expiresAt: Date.now() + 60_000,
		...(status === "awaiting_confirmation"
			? { authorizationUrl: "https://connector.test/authorize?state=x" }
			: {}),
	};
}
function response(status: number, data = projection()) {
	return { response: { status }, data };
}
async function begin() {
	fireEvent.click(screen.getByRole("button", { name: "开始安装" }));
	await act(async () => {});
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("open", vi.fn());
	let installationStatus: Status = "awaiting_confirmation";
	api.beginPlatformConnectionInstallationV1.mockResolvedValue(response(202));
	api.readPlatformConnectionInstallationV1.mockImplementation(async () =>
		response(200, projection(installationStatus)),
	);
	api.confirmPlatformConnectionInstallationV1.mockImplementation(async () => {
		installationStatus = "confirmed";
		return response(202, projection(installationStatus));
	});
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("opens a validated authorization URL only on click", async () => {
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	await begin();
	expect(screen.getByText("等待 Connection 确认")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "开始安装" })).toBeNull();
	expect(window.open).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "打开授权页" }));
	expect(window.open).toHaveBeenCalledWith(
		"https://connector.test/authorize?state=x",
		"_blank",
		"noopener,noreferrer",
	);
	expect(api.confirmPlatformConnectionInstallationV1).not.toHaveBeenCalled();
});

it.each([
	{ authorizationUrl: "http://connector.test/authorize" },
	{ token: "secret-material" },
])("rejects invalid or credential-shaped begin responses", async (fields) => {
	api.beginPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 202 },
		data: { ...projection(), ...fields },
	});
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	await begin();
	expect(screen.getByText("Connection 安装暂不可用。")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "打开授权页" })).toBeNull();
	expect(screen.queryByRole("button", { name: "确认安装" })).toBeNull();
	expect(screen.queryByText("secret-material")).toBeNull();
	expect(window.open).not.toHaveBeenCalled();
});

it("waits for the original installation to publish its authorization URL", async () => {
	vi.useFakeTimers();
	const { authorizationUrl: _url, ...pending } = projection();
	api.beginPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 202 },
		data: pending,
	});
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	await begin();
	expect(screen.queryByRole("button", { name: "确认安装" })).toBeNull();
	expect(screen.getByText("正在准备授权入口，请稍后查询状态。")).toBeTruthy();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2_000);
	});
	expect(screen.getByRole("button", { name: "打开授权页" })).toBeTruthy();
	expect(screen.getByRole("button", { name: "确认安装" })).toBeTruthy();
	expect(api.readPlatformConnectionInstallationV1).toHaveBeenCalledWith(
		expect.objectContaining({ path: { authorizationId: "authorization-1" } }),
	);
	expect(api.confirmPlatformConnectionInstallationV1).not.toHaveBeenCalled();
});

it("polls without confirming, then records an explicit confirmation and keeps focus", async () => {
	vi.useFakeTimers();
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	const step = screen.getByRole("button", { name: "开始安装" });
	step.focus();
	await begin();
	expect(document.activeElement).toBe(step);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2_000);
	});
	expect(screen.getByText("等待 Connection 确认")).toBeTruthy();
	expect(api.confirmPlatformConnectionInstallationV1).not.toHaveBeenCalled();
	const confirm = screen.getByRole("button", { name: "确认安装" });
	confirm.focus();
	fireEvent.click(confirm);
	await act(async () => {});
	expect(screen.getByText("已确认")).toBeTruthy();
	expect(
		screen.getByText("已记录你的安装确认，Connection 授权是否可用仍需核实。"),
	).toBeTruthy();
	expect(screen.getByRole("button", { name: "重新开始" })).toBe(step);
	expect(document.activeElement).toBe(step);
	expect(api.confirmPlatformConnectionInstallationV1).toHaveBeenCalledTimes(1);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(4_000);
	});
	expect(api.readPlatformConnectionInstallationV1).toHaveBeenCalledTimes(1);
});

it("does not poll, abort or duplicate an in-flight confirmation", async () => {
	vi.useFakeTimers();
	let resolve: (value: ReturnType<typeof response>) => void = () => {};
	api.confirmPlatformConnectionInstallationV1.mockReturnValue(
		new Promise((done) => {
			resolve = done;
		}),
	);
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	await begin();
	fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
	fireEvent.click(screen.getByRole("button", { name: "确认中" }));
	fireEvent.click(screen.getByRole("button", { name: "查询状态" }));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(4_000);
	});
	expect(api.confirmPlatformConnectionInstallationV1).toHaveBeenCalledTimes(1);
	expect(api.readPlatformConnectionInstallationV1).not.toHaveBeenCalled();
	expect(
		api.confirmPlatformConnectionInstallationV1.mock.calls[0]?.[0].signal
			.aborted,
	).toBe(false);
	await act(async () => {
		resolve(response(202, projection("confirmed")));
	});
	expect(screen.getByText("已确认")).toBeTruthy();
});

it.each(["network", "invalid", "wrong-authorization"])(
	"preserves the original command after an ambiguous %s response",
	async (failure) => {
		vi.useFakeTimers();
		if (failure === "network")
			api.confirmPlatformConnectionInstallationV1.mockRejectedValueOnce(
				new Error("offline"),
			);
		else
			api.confirmPlatformConnectionInstallationV1.mockResolvedValueOnce({
				response: { status: 202 },
				data:
					failure === "invalid"
						? { schemaVersion: 1 }
						: {
								...projection("confirmed"),
								authorizationId: "other-user-authorization",
							},
			});
		render(<ConnectionInstallationPanel executionId="execution-1" />);
		await begin();
		fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
		await act(async () => {});
		expect(
			screen.getByText("确认结果尚未核实，请查询原安装状态。"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "重新开始" })).toBeNull();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4_000);
		});
		expect(api.confirmPlatformConnectionInstallationV1).toHaveBeenCalledTimes(
			1,
		);
		expect(api.readPlatformConnectionInstallationV1).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "查询状态" }));
		await act(async () => {});
		expect(api.readPlatformConnectionInstallationV1).toHaveBeenCalledWith(
			expect.objectContaining({ path: { authorizationId: "authorization-1" } }),
		);
		expect(api.confirmPlatformConnectionInstallationV1).toHaveBeenCalledTimes(
			1,
		);
		fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
		await act(async () => {});
		const first =
			api.confirmPlatformConnectionInstallationV1.mock.calls[0]?.[0];
		const retry =
			api.confirmPlatformConnectionInstallationV1.mock.calls[1]?.[0];
		expect(first.path).toEqual({ authorizationId: "authorization-1" });
		expect(retry.path).toEqual(first.path);
		expect(retry.headers["Idempotency-Key"]).toBe(
			first.headers["Idempotency-Key"],
		);
		expect(first.headers["Idempotency-Key"]).not.toBe(
			api.beginPlatformConnectionInstallationV1.mock.calls[0]?.[0].headers[
				"Idempotency-Key"
			],
		);
		expect(api.beginPlatformConnectionInstallationV1).toHaveBeenCalledTimes(1);
		expect(screen.getByText("已确认")).toBeTruthy();
	},
);

it("keeps a server unknown result read-only without beginning another installation", async () => {
	vi.useFakeTimers();
	api.confirmPlatformConnectionInstallationV1.mockResolvedValue(
		response(202, projection("unknown")),
	);
	api.readPlatformConnectionInstallationV1.mockResolvedValue(
		response(200, projection("unknown")),
	);
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	await begin();
	fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
	await act(async () => {});
	expect(screen.getByText("状态待核实")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "确认安装" })).toBeNull();
	expect(screen.queryByRole("button", { name: "重新开始" })).toBeNull();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(4_000);
	});
	expect(api.readPlatformConnectionInstallationV1).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "查询状态" }));
	await act(async () => {});
	expect(api.readPlatformConnectionInstallationV1).toHaveBeenCalledTimes(1);
	expect(api.confirmPlatformConnectionInstallationV1).toHaveBeenCalledTimes(1);
	expect(api.beginPlatformConnectionInstallationV1).toHaveBeenCalledTimes(1);
});

it.each(["execution", "client"])(
	"discards stale confirmation when the %s changes",
	async (change) => {
		let resolve: (value: ReturnType<typeof response>) => void = () => {};
		api.confirmPlatformConnectionInstallationV1.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const initialClient = {} as Client;
		const nextClient = change === "client" ? ({} as Client) : initialClient;
		const nextExecution =
			change === "execution" ? "execution-2" : "execution-1";
		const view = render(
			<ConnectionInstallationPanel
				executionId="execution-1"
				client={initialClient}
			/>,
		);
		await begin();
		fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
		view.rerender(
			<ConnectionInstallationPanel
				executionId={nextExecution}
				client={nextClient}
			/>,
		);
		expect(
			api.confirmPlatformConnectionInstallationV1.mock.calls[0]?.[0].signal
				.aborted,
		).toBe(true);
		await act(async () => {
			resolve(response(202, projection("confirmed")));
		});
		expect(screen.queryByText("已确认")).toBeNull();
		expect(screen.queryByRole("button", { name: "查询状态" })).toBeNull();
		await begin();
		expect(api.beginPlatformConnectionInstallationV1).toHaveBeenLastCalledWith(
			expect.objectContaining({
				client: nextClient,
				body: { schemaVersion: 1, executionId: nextExecution },
			}),
		);
		expect(
			api.beginPlatformConnectionInstallationV1.mock.calls[0]?.[0].headers[
				"Idempotency-Key"
			],
		).not.toBe(
			api.beginPlatformConnectionInstallationV1.mock.calls[1]?.[0].headers[
				"Idempotency-Key"
			],
		);
	},
);

it("bounds polling after retryable status failures", async () => {
	vi.useFakeTimers();
	api.readPlatformConnectionInstallationV1.mockRejectedValue(
		new Error("offline"),
	);
	render(<ConnectionInstallationPanel executionId="execution-1" />);
	await begin();
	for (let attempt = 0; attempt < 30; attempt++)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
	expect(api.readPlatformConnectionInstallationV1).toHaveBeenCalledTimes(30);
	expect(screen.getByText("轮询已暂停，请稍后重新读取状态。")).toBeTruthy();
	expect(api.confirmPlatformConnectionInstallationV1).not.toHaveBeenCalled();
});

it.each([
	["404", { response: { status: 404 }, error: { retryable: false } }],
	["invalid", { response: { status: 200 }, data: { schemaVersion: 1 } }],
] as const)(
	"stops polling on %s while keeping the original installation",
	async (_name, failure) => {
		vi.useFakeTimers();
		api.readPlatformConnectionInstallationV1
			.mockResolvedValueOnce({ response: { status: 503 }, error: {} })
			.mockResolvedValue(failure);
		render(<ConnectionInstallationPanel executionId="execution-1" />);
		await begin();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(screen.getByText("等待 Connection 确认")).toBeTruthy();
		expect(screen.queryByText("暂时无法读取安装状态。")).toBeNull();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(screen.getByText("Connection 安装暂不可用。")).toBeTruthy();
		expect(screen.getByRole("button", { name: "查询状态" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "开始安装" })).toBeNull();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(api.readPlatformConnectionInstallationV1).toHaveBeenCalledTimes(2);
	},
);

it.each(["confirmed", "revoked", "expired", "unknown"] as const)(
	"renders %s begin results without implicit confirmation",
	async (status) => {
		api.beginPlatformConnectionInstallationV1.mockResolvedValue(
			response(202, projection(status)),
		);
		render(<ConnectionInstallationPanel executionId="execution-1" />);
		await begin();
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
		expect(api.confirmPlatformConnectionInstallationV1).not.toHaveBeenCalled();
	},
);
