import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button.js";

describe("button variants", () => {
	it("keeps action controls at the 44px touch target", () => {
		for (const size of ["default", "sm", "lg"] as const) {
			expect(buttonVariants({ size })).toContain("min-h-[44px]");
		}
		for (const size of ["icon", "icon-sm", "icon-lg"] as const) {
			expect(buttonVariants({ size })).toContain("size-11");
		}
	});

	it("keeps the 24px icon-only control as the explicit compact exception", () => {
		expect(buttonVariants({ size: "icon-xs" })).toContain("size-6");
	});

	it("uses the shared outline focus treatment without a utility ring", () => {
		expect(buttonVariants()).not.toMatch(/focus-visible:ring/);
	});
});
