import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./dropdown-menu.js";

afterEach(cleanup);

function Example({
	onValueChange,
}: {
	onValueChange: (value: string) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger aria-label="选择模型">模型 A</DropdownMenuTrigger>
			<DropdownMenuContent aria-label="模型与思考设置">
				<DropdownMenuGroup>
					<DropdownMenuLabel>模型</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value="a"
						onValueChange={(value: string) => onValueChange(value)}
					>
						<DropdownMenuRadioItem value="a">模型 A</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="b">模型 B</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

describe("DropdownMenu", () => {
	it("renders a menu of radio items without entry animation classes", async () => {
		const onValueChange = vi.fn();
		render(<Example onValueChange={onValueChange} />);
		const trigger = screen.getByRole("button", { name: "选择模型" });
		expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
		fireEvent.click(trigger);
		const menu = await screen.findByRole("menu", { name: "模型与思考设置" });
		expect(menu.className).not.toMatch(/animate-in|zoom-in|fade-in/);
		expect(screen.getByText("模型")).toBeTruthy();
		const checked = screen.getByRole("menuitemradio", { name: "模型 A" });
		expect(checked.getAttribute("aria-checked")).toBe("true");
		expect(checked.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		const other = screen.getByRole("menuitemradio", { name: "模型 B" });
		expect(other.getAttribute("aria-checked")).toBe("false");
		fireEvent.pointerDown(other, { pointerType: "mouse" });
		fireEvent.click(other, { detail: 1 });
		expect(onValueChange).toHaveBeenCalledWith("b");
	});

	it("shows the pointer on options and keeps a disabled option unselectable (G4-07)", async () => {
		const onValueChange = vi.fn();
		render(
			<DropdownMenu>
				<DropdownMenuTrigger aria-label="选择思考强度">
					均衡
				</DropdownMenuTrigger>
				<DropdownMenuContent aria-label="思考强度">
					<DropdownMenuRadioGroup
						value="medium"
						onValueChange={(value: string) => onValueChange(value)}
					>
						<DropdownMenuRadioItem value="medium">均衡</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="high" disabled>
							高
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>,
		);
		fireEvent.click(screen.getByRole("button", { name: "选择思考强度" }));
		await screen.findByRole("menu", { name: "思考强度" });
		const enabled = screen.getByRole("menuitemradio", { name: "均衡" });
		expect(enabled.className).toContain("cursor-pointer");
		const disabled = screen.getByRole("menuitemradio", { name: "高" });
		expect(disabled.getAttribute("aria-disabled")).toBe("true");
		// 禁用项能接收指针命中以显示 not-allowed，但点击不会选中。
		expect(disabled.className).toContain("data-disabled:cursor-not-allowed");
		expect(disabled.className).not.toContain("pointer-events-none");
		fireEvent.pointerDown(disabled, { pointerType: "mouse" });
		fireEvent.click(disabled, { detail: 1 });
		expect(onValueChange).not.toHaveBeenCalled();
		expect(disabled.getAttribute("aria-checked")).toBe("false");
	});
});
