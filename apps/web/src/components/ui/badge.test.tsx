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

	it("never derives a tone from data-status or data-result", () => {
		render(
			<>
				<Badge data-status="ready">未传色调</Badge>
				<Badge tone="green" data-result="failed">
					显式色调
				</Badge>
			</>,
		);
		expect(badge("未传色调").dataset.tone).toBe("gray");
		expect(badge("显式色调").dataset.tone).toBe("green");
	});

	it("only accepts the chip and tag variants", () => {
		// @ts-expect-error 兼容层已删除：旧变体名（default / secondary / destructive / outline）不再合法。
		render(<Badge variant="outline">旧变体</Badge>);
		expect(badge("旧变体").className).not.toMatch(
			/\bbg-primary\b|text-secondary-foreground|text-primary-foreground/,
		);
	});
});
