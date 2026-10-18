import { expect, it } from "vitest";
import { reasoningLevelLabel } from "./reasoning-level-label";

it("maps every reasoning level to Chinese and hides unknown values", () => {
	expect(
		["low", "medium", "high", "xhigh", "max"].map(reasoningLevelLabel),
	).toEqual(["低", "均衡", "高", "极高", "最高"]);
	for (const unknown of ["turbo", "", "constructor", "toString"]) {
		expect(reasoningLevelLabel(unknown)).toBe("其他");
		expect(reasoningLevelLabel(unknown)).not.toContain(unknown || "∅");
	}
});
