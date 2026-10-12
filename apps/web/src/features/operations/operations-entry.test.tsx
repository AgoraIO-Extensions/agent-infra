import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OperationsEntry } from "./operations-entry.js";

describe("OperationsEntry", () => {
	afterEach(cleanup);

	it("keeps the real observability state explicit until the query contract exists", () => {
		render(<OperationsEntry isAdministrator onRefresh={() => undefined} />);
		expect(
			screen.getByRole("heading", { name: "先确认平台状态，再定位故障。" }),
		).toBeTruthy();
		expect(screen.getAllByText("待接入")).toHaveLength(4);
		expect(screen.getByText("观测查询尚未接入")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "刷新运维状态" }));
	});

	it("does not expose operational metadata to an unauthorized subject", () => {
		render(<OperationsEntry isAdministrator={false} />);
		expect(screen.getByText("当前登录主体无权访问运维观测入口。")).toBeTruthy();
		expect(screen.queryByText("服务健康与延迟")).toBeNull();
	});
});
