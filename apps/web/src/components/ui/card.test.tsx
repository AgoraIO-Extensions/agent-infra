import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "./card.js";

afterEach(cleanup);

describe("Card", () => {
	it("renders an article with the design hover border and shadow", () => {
		const { container } = render(<Card>内容</Card>);
		const card = container.querySelector('[data-slot="card"]');
		expect(card?.tagName).toBe("ARTICLE");
		expect(card?.className).toContain("p-[18px]");
		expect(card?.className).toContain("rounded-[14px]");
		expect(card?.className).toContain(
			"hover:border-[color-mix(in_oklch,var(--accent)_30%,var(--border))]",
		);
		expect(card?.className).toContain("duration-[180ms]");
	});

	it("can render as a list item", () => {
		const { container } = render(
			<ul>
				<Card render={<li />}>内容</Card>
			</ul>,
		);
		expect(container.querySelector('li[data-slot="card"]')).not.toBeNull();
	});
});
