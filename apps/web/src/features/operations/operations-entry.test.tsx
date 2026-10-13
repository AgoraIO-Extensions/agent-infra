import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationsEntry } from "./operations-entry.js";

describe("OperationsEntry", () => {
	afterEach(cleanup);

	it("keeps the real observability state explicit until the query contract exists", () => {
		render(<OperationsEntry isAdministrator />);
		expect(
			screen.getByRole("heading", { name: "先确认平台状态，再定位故障。" }),
		).toBeTruthy();
		expect(screen.getAllByText("待接入")).toHaveLength(4);
		expect(screen.getByText("观测查询尚未接入")).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "刷新运维状态",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("renders query states and per-domain status", () => {
		const onRefresh = vi.fn();
		render(
			<OperationsEntry
				isAdministrator
				onRefresh={onRefresh}
				state={{
					kind: "ready",
					statuses: {
						health: "healthy",
						agents: "degraded",
						delivery: "unavailable",
						alerts: "unknown",
					},
				}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "刷新运维状态" }));
		expect(onRefresh).toHaveBeenCalledOnce();
		expect(screen.getByText("正常")).toBeTruthy();
		expect(screen.getByText("降级")).toBeTruthy();
		expect(screen.getByText("不可用")).toBeTruthy();
	});

	it("shows loading and disables refresh while a query is pending", () => {
		render(
			<OperationsEntry
				isAdministrator
				onRefresh={() => undefined}
				isRefreshing
				state={{ kind: "loading" }}
			/>,
		);
		expect(screen.getByText("正在读取观测状态")).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "刷新运维状态",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("distinguishes retryable failures and service unavailability", () => {
		render(
			<OperationsEntry
				isAdministrator
				state={{ kind: "error", message: "查询失败", retryable: true }}
				onRefresh={() => undefined}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain(
			"查询失败 请刷新后重试。",
		);
		cleanup();
		render(
			<OperationsEntry
				isAdministrator
				state={{ kind: "unavailable", message: "服务不可用" }}
				onRefresh={() => undefined}
			/>,
		);
		expect(screen.getByRole("status").textContent).toContain("服务不可用");
	});

	it("does not expose operational metadata to an unauthorized subject", () => {
		render(<OperationsEntry isAdministrator={false} />);
		expect(screen.getByText("当前登录主体无权访问运维观测入口。")).toBeTruthy();
		expect(screen.queryByText("服务健康与延迟")).toBeNull();
	});
});
