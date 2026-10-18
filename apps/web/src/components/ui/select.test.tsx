import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./select.js";

describe("Select", () => {
	it("opens its menu below the trigger by default", () => {
		render(
			<Select defaultOpen>
				<SelectTrigger aria-label="选择模型">
					<SelectValue placeholder="选择模型" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="model">模型</SelectItem>
				</SelectContent>
			</Select>,
		);

		const popup = document.querySelector('[data-slot="select-content"]');
		expect(popup?.getAttribute("data-align-trigger")).toBe("false");
	});
});
