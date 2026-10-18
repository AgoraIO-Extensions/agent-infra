import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FormSection } from "./form-section.js";

afterEach(cleanup);

describe("FormSection", () => {
	it("renders a named section whose heading sits above its content", () => {
		render(
			<>
				<FormSection title="基本信息" description="名称会显示在目录。">
					<p>内容</p>
				</FormSection>
				<FormSection
					title="环境变量"
					headingLevel={3}
					description="可选"
					descriptionId="env-help"
				>
					<p>变量</p>
				</FormSection>
			</>,
		);

		const basic = screen.getByRole("region", { name: "基本信息" });
		expect(basic.tagName.toLowerCase()).toBe("section");
		const heading = screen.getByRole("heading", { level: 2, name: "基本信息" });
		expect(basic.getAttribute("aria-labelledby")).toBe(heading.id);
		// 分区标题不是 legend，不会压在分隔线上。
		expect(basic.querySelector("legend")).toBeNull();
		expect(basic.firstElementChild).toBe(heading);
		expect(heading.nextElementSibling?.textContent).toBe("名称会显示在目录。");

		expect(
			screen.getByRole("heading", { level: 3, name: "环境变量" }),
		).toBeTruthy();
		expect(document.getElementById("env-help")?.textContent).toBe("可选");
	});
});
