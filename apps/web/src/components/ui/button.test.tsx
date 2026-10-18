import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button, buttonVariants } from "./button.js";

afterEach(cleanup);

describe("buttonVariants", () => {
	it("paints the primary action with the accent ink token", () => {
		const classes = buttonVariants().split(" ");
		expect(classes).toEqual(
			expect.arrayContaining([
				"border-accent-ink",
				"bg-accent-ink",
				"text-primary-foreground",
				"hover:bg-[color-mix(in_oklch,var(--accent-ink)_84%,var(--foreground))]",
			]),
		);
		expect(classes).not.toContain("bg-primary");
	});

	it("paints destructive actions with the danger ink token", () => {
		const classes = buttonVariants({ variant: "destructive" }).split(" ");
		expect(classes).toEqual(
			expect.arrayContaining(["border-danger-ink", "bg-danger-ink"]),
		);
		expect(classes).not.toContain("bg-destructive");
	});

	it("keeps secondary text on the secondary foreground token", () => {
		expect(buttonVariants({ variant: "secondary" }).split(" ")).toContain(
			"text-secondary-foreground",
		);
	});
});

describe("Button", () => {
	it("does not run onClick while disabled", () => {
		const onClick = vi.fn();
		render(
			<Button disabled onClick={onClick}>
				保存
			</Button>,
		);

		const button = screen.getByRole("button", { name: "保存" });
		fireEvent.click(button);
		expect(onClick).not.toHaveBeenCalled();
		// 禁用态保留指针事件，才能显示 not-allowed 光标。
		expect(button.className).not.toContain("disabled:pointer-events-none");
		expect(button.className).toContain("disabled:cursor-not-allowed");
	});

	it("gives links and buttons of the same size the same size classes", () => {
		render(
			<>
				<Button size="sm">展开高级配置</Button>
				<a className={buttonVariants({ size: "sm" })} href="/back">
					返回
				</a>
			</>,
		);

		const button = screen.getByRole("button", { name: "展开高级配置" });
		const link = screen.getByRole("link", { name: "返回" });
		expect(link.className).toBe(button.className);
		// sm 的最小高度在设计定版前保持 44px（DESIGN.md 操作 ≥44px）。
		expect(button.className).toContain("min-h-[44px]");
		expect(button.className).toContain("text-[12px]");
	});
});
