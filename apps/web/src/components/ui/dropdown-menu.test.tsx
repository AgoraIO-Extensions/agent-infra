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
});
