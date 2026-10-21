import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Label } from "./label.js";
import { RadioGroup, RadioGroupItem } from "./radio-group.js";

afterEach(cleanup);

function Scope() {
	const [value, setValue] = useState("private");
	return (
		<RadioGroup
			aria-label="发布范围"
			value={value}
			onValueChange={(next) => setValue(next as string)}
		>
			{[
				["private", "仅自己"],
				["member", "全体成员"],
				["organization", "组织共享"],
			].map(([item, text]) => (
				<Label key={item} variant="option">
					<RadioGroupItem
						value={item}
						disabled={item === "organization"}
						aria-labelledby={`scope-${item}`}
					/>
					<span id={`scope-${item}`}>{text}</span>
				</Label>
			))}
		</RadioGroup>
	);
}

describe("RadioGroup", () => {
	it("names the group and each option, and selects from the radio or its label card", () => {
		render(<Scope />);
		const group = screen.getByRole("radiogroup", { name: "发布范围" });
		expect(group.dataset.slot).toBe("radio-group");
		const own = screen.getByRole("radio", { name: "仅自己" });
		const member = screen.getByRole("radio", { name: "全体成员" });
		expect(own.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(member);
		expect(member.getAttribute("aria-checked")).toBe("true");
		expect(own.getAttribute("aria-checked")).toBe("false");
		// 选项文字所在的整张卡（Label）都是命中区。
		fireEvent.click(screen.getByText("仅自己"));
		expect(own.getAttribute("aria-checked")).toBe("true");
		// 禁用项不可选。
		const organization = screen.getByRole("radio", { name: "组织共享" });
		expect(organization.hasAttribute("data-disabled")).toBe(true);
		fireEvent.click(organization);
		expect(organization.getAttribute("aria-checked")).toBe("false");
	});
});
