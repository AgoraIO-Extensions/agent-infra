import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge, badgeVariants } from "./badge.js";

describe("Badge variants", () => {
	it("uses a soft accent chip for the default variant", () => {
		const classes = badgeVariants({ variant: "default" });

		expect(classes).toContain(
			"border-[color-mix(in_oklch,var(--accent-ink)_28%,transparent)]",
		);
		expect(classes).toContain("bg-secondary");
		expect(classes).toContain("text-[var(--accent-ink)]");
		expect(classes).not.toContain("bg-[var(--accent-ink)]");
	});

	it("uses a muted compact tag for the secondary variant", () => {
		const { rerender } = render(<Badge variant="secondary">Tag</Badge>);
		const tag = screen.getByText("Tag");

		expect(tag.className).toContain("rounded-[7px]");
		expect(tag.className).toContain("bg-transparent");
		expect(tag.className).toContain("text-muted-foreground");
		expect(tag.className).not.toContain("bg-secondary");

		rerender(<Badge>Default</Badge>);
		expect(screen.getByText("Default").className).toContain("bg-secondary");
	});
});
