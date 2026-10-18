import { cleanup, render, screen } from "@testing-library/react";
import { PackageOpen } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "./empty.js";

afterEach(cleanup);

describe("Empty", () => {
	it("uses the design defaults and a non-heading title", () => {
		const { container } = render(
			<Empty>
				<EmptyHeader>
					<EmptyMedia>
						<PackageOpen aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>暂无已发布版本</EmptyTitle>
					<EmptyDescription>发布成功的固定版本会显示在这里。</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<button type="button">清除筛选</button>
				</EmptyContent>
			</Empty>,
		);
		const empty = container.querySelector('[data-slot="empty"]');
		expect(empty?.className).toContain("min-h-[220px]");
		expect(empty?.className).toContain("p-[28px]");
		expect(empty?.className).toContain("border-dashed");
		expect(empty?.className).toContain("place-items-center");
		const title = screen.getByText("暂无已发布版本");
		// strong 不会命中 .management-content h2 的 display 字体规则。
		expect(title.tagName).toBe("STRONG");
		expect(screen.queryByRole("heading")).toBeNull();
		expect(title.className).toContain("text-[15px]");
		expect(
			screen.getByText("发布成功的固定版本会显示在这里。").className,
		).toContain("text-[13px]");
		expect(
			container.querySelector('[data-slot="empty-icon"]')?.className,
		).toContain("[&_svg]:size-[28px]");
	});
});
