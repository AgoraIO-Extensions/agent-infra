import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Checkbox } from "./checkbox.js";
import { Field, FieldError, FieldLegend } from "./field.js";
import { Input } from "./input.js";
import { Label } from "./label.js";
import { SearchInput } from "./search-input.js";

afterEach(cleanup);

describe("Field", () => {
	it("keeps field labels and option labels as two fixed variants", () => {
		render(
			<>
				<Field>
					<Label htmlFor="agent-name">Agent 名称</Label>
					<Input id="agent-name" />
				</Field>
				<Label variant="option">
					<Checkbox />
					High
				</Label>
			</>,
		);

		const field = screen.getByText("Agent 名称");
		expect(field.dataset.variant).toBe("field");
		expect(screen.getByRole("textbox", { name: "Agent 名称" })).toBeTruthy();
		expect(field.closest('[data-slot="field"]')).toBeTruthy();
		const option = screen.getByText("High");
		expect(option.dataset.variant).toBe("option");
		// 选项文字是复选框的可访问名称，整行（≥44px）都是命中区。
		expect(screen.getByRole("checkbox", { name: "High" })).toBeTruthy();
	});

	it("names a fieldset group with FieldLegend", () => {
		render(
			<fieldset>
				<FieldLegend>允许的推理档位</FieldLegend>
				<Label variant="option">
					<Checkbox />
					Low
				</Label>
			</fieldset>,
		);

		const group = screen.getByRole("group", { name: "允许的推理档位" });
		expect(
			group.querySelector('[data-slot="field-legend"]')?.tagName.toLowerCase(),
		).toBe("legend");
	});
});

describe("FieldError", () => {
	it("announces a field validation error referenced by the control", () => {
		render(
			<Field>
				<Label htmlFor="reason">驳回原因</Label>
				<Input id="reason" aria-invalid aria-describedby="reason-error" />
				<FieldError id="reason-error">请填写驳回原因。</FieldError>
			</Field>,
		);

		const error = screen.getByRole("alert");
		expect(error.textContent).toBe("请填写驳回原因。");
		expect(error.dataset.slot).toBe("field-error");
		expect(error.className).toContain("text-[12px]");
		expect(error.className).toContain("text-(--danger-ink)");
		expect(
			screen
				.getByRole("textbox", { name: "驳回原因" })
				.getAttribute("aria-describedby"),
		).toBe(error.id);
	});

	// #3268 N8-2-02：已有总提示播报或需要 aria-live 时，调用方去掉 role，样式仍是同一套。
	it("keeps the shared style when a caller announces through a live region instead of an alert", () => {
		render(
			<FieldError announce="polite" id="name-error">
				请输入名称。
			</FieldError>,
		);

		const error = screen.getByText("请输入名称。");
		expect(error.getAttribute("role")).toBeNull();
		expect(error.getAttribute("aria-live")).toBe("polite");
		expect(error.dataset.slot).toBe("field-error");
		expect(error.className).toContain("text-[12px]");
		expect(error.className).toContain("leading-[1.5]");
		expect(error.className).toContain("text-(--danger-ink)");
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("SearchInput", () => {
	it("labels the search box for assistive technology and hides the icon", () => {
		render(
			<SearchInput label="搜索 Agent" id="agent-search" placeholder="搜索" />,
		);

		const input = screen.getByRole("searchbox", { name: "搜索 Agent" });
		expect(input.getAttribute("type")).toBe("search");
		const wrapper = input.closest('[data-slot="search-input"]');
		expect(
			wrapper
				?.querySelector('[data-slot="search-input-icon"]')
				?.getAttribute("aria-hidden"),
		).toBe("true");
		expect(screen.getByText("搜索 Agent").className).toContain("sr-only");
	});
});
