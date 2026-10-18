import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button.js";

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
