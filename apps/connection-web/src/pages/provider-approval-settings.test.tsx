// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderApprovalSettings } from "./provider-approval-settings";

afterEach(cleanup);

it("collapses 60 providers and combines search, filtering, pagination and refreshed server state", () => {
	const settings = Array.from({ length: 60 }, (_, i) => ({
		providerId: `service-${String(i).padStart(2, "0")}`,
		approvalRequired: i % 2 === 0,
		revision: String(i + 1),
	}));
	const onChange = vi.fn();
	const props = {
		settings,
		loading: false,
		failed: false,
		busy: false,
		onChange,
	};
	const { container, rerender } = render(
		<ProviderApprovalSettings {...props} />,
	);
	expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
	expect(screen.getByRole("status").textContent).toBe("30 / 60 已开启审批");
	fireEvent.click(container.querySelector("summary") as HTMLElement);
	expect(screen.getAllByRole("switch", { hidden: true })).toHaveLength(15);
	fireEvent.click(
		screen.getByRole("button", { name: "下一页连接器", hidden: true }),
	);
	expect(screen.getByText("service-15")).toBeTruthy();
	fireEvent.change(
		screen.getByRole("textbox", { name: "搜索连接器", hidden: true }),
		{ target: { value: "service-0" } },
	);
	expect(screen.getAllByRole("switch", { hidden: true })).toHaveLength(10);
	fireEvent.click(
		screen.getByRole("button", { name: "需要审批", hidden: true }),
	);
	expect(screen.getAllByRole("switch", { hidden: true })).toHaveLength(5);
	fireEvent.click(
		screen.getByRole("switch", { name: "service-00需要审批", hidden: true }),
	);
	expect(onChange).toHaveBeenCalledWith(settings[0]);
	rerender(
		<ProviderApprovalSettings
			{...props}
			settings={settings.map((item, i) =>
				i === 0 ? { ...item, approvalRequired: false, revision: "61" } : item,
			)}
		/>,
	);
	expect(screen.getAllByRole("switch", { hidden: true })).toHaveLength(4);
	expect(screen.getByRole("status").textContent).toBe("29 / 60 已开启审批");
	fireEvent.change(
		screen.getByRole("textbox", { name: "搜索连接器", hidden: true }),
		{ target: { value: "missing" } },
	);
	expect(screen.queryAllByRole("switch", { hidden: true })).toHaveLength(0);
	expect(
		screen.getByText("没有匹配的连接器，请修改搜索或筛选条件。"),
	).toBeTruthy();
});

it("clamps pages after settings shrink and disables edits while saving or unavailable", () => {
	const settings = Array.from({ length: 16 }, (_, i) => ({
		providerId: `provider-${i}`,
		approvalRequired: false,
		revision: "1",
	}));
	const props = {
		settings,
		loading: false,
		failed: false,
		busy: false,
		onChange: vi.fn(),
	};
	const { rerender } = render(<ProviderApprovalSettings {...props} />);
	fireEvent.click(
		screen.getByRole("button", { name: "下一页连接器", hidden: true }),
	);
	expect(screen.getAllByRole("switch", { hidden: true })).toHaveLength(1);
	rerender(
		<ProviderApprovalSettings
			{...props}
			settings={settings.slice(0, 2)}
			busy
		/>,
	);
	expect(screen.getAllByRole("switch", { hidden: true })).toHaveLength(2);
	for (const input of screen.getAllByRole("switch", { hidden: true }))
		expect((input as HTMLInputElement).disabled).toBe(true);
	expect(
		(
			screen.getByRole("button", {
				name: "上一页连接器",
				hidden: true,
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
	rerender(<ProviderApprovalSettings {...props} failed />);
	expect(screen.getByRole("status").textContent).toBe("设置加载失败");
	for (const input of screen.getAllByRole("switch", { hidden: true }))
		expect((input as HTMLInputElement).disabled).toBe(true);
});
