import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./badge.js";

afterEach(cleanup);

function badge(text: string) {
	return screen.getByText(text, { selector: '[data-slot="badge"]' });
}

describe("Badge", () => {
	it("defaults to a gray chip with a status dot and no fill", () => {
		render(<Badge>状态暂时无法确认</Badge>);
		const element = badge("状态暂时无法确认");
		expect(element.dataset.variant).toBe("chip");
		expect(element.dataset.tone).toBe("gray");
		expect(element.className).toContain("rounded-[999px]");
		expect(element.className).toContain("before:size-[6px]");
		expect(element.className).toContain("bg-transparent");
		expect(element.className).toContain("text-muted-foreground");
		expect(element.className).toContain("leading-[1.65]");
		expect(element.className).toContain("font-normal");
		expect(element.className).not.toContain("whitespace-nowrap");
	});

	it.each([
		["blue", "text-(--accent-ink)"],
		["green", "text-(--success-ink)"],
		["amber", "text-(--warning-ink)"],
		["red", "text-(--danger-ink)"],
	] as const)("renders the %s tone with its ink color", (tone, ink) => {
		render(<Badge tone={tone}>{tone}</Badge>);
		const element = badge(tone);
		expect(element.dataset.tone).toBe(tone);
		expect(element.className).toContain(ink);
	});

	it("renders tags without a dot or tone", () => {
		render(<Badge variant="tag">标准模板 · codex</Badge>);
		const element = badge("标准模板 · codex");
		expect(element.dataset.variant).toBe("tag");
		expect(element.dataset.tone).toBeUndefined();
		expect(element.className).toContain("rounded-[7px]");
		expect(element.className).not.toContain("before:size-[6px]");
	});

	it("prefers an explicit tone over a derived status", () => {
		render(
			<Badge tone="gray" data-status="ready">
				显式
			</Badge>,
		);
		expect(badge("显式").dataset.tone).toBe("gray");
	});

	describe("compatibility layer for unmigrated callers", () => {
		it("derives a chip tone from data-status and data-result", () => {
			render(
				<>
					<Badge variant="outline" data-status="ready">
						就绪
					</Badge>
					<Badge variant="secondary" data-status="starting">
						启动中
					</Badge>
					<Badge variant="outline" data-result="failed">
						失败
					</Badge>
				</>,
			);
			expect(badge("就绪").dataset.tone).toBe("green");
			expect(badge("启动中").dataset.variant).toBe("chip");
			expect(badge("启动中").dataset.tone).toBe("amber");
			expect(badge("失败").dataset.tone).toBe("red");
		});

		it("maps legacy variants without solid primary or secondary-foreground fills", () => {
			render(
				<>
					<Badge variant="default">处理中</Badge>
					<Badge variant="secondary">命令</Badge>
					<Badge variant="destructive">失败</Badge>
					<Badge variant="outline">3 项</Badge>
				</>,
			);
			expect(badge("处理中").dataset.tone).toBe("blue");
			expect(badge("命令").dataset.variant).toBe("tag");
			expect(badge("失败").dataset.tone).toBe("red");
			expect(badge("3 项").dataset.tone).toBe("gray");
			for (const text of ["处理中", "命令", "失败", "3 项"]) {
				expect(badge(text).className).not.toMatch(
					/\bbg-primary\b|text-secondary-foreground|text-primary-foreground/,
				);
			}
		});
	});
});
