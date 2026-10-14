import { describe, expect, it } from "vitest";
import { configurationVersionTransitionAllowed } from "./plan-writes.ts";

const plan = (changedFields: readonly string[]) =>
	({ result: { changedFields } }) as Parameters<
		typeof configurationVersionTransitionAllowed
	>[0];

describe("configuration version transitions (#2401)", () => {
	it.each([
		[2, 2, true],
		[3, 3, true],
		// V3 基线绝不降级为需要模型凭证的 V2。
		[2, 3, false],
		// V2 基线不能悄悄改写成 V3，必须经由替换默认 Key 的计划。
		[3, 2, false],
	] as const)(
		"configuration V%s over previous V%s allowed=%s",
		(configuration, previous, allowed) => {
			expect(
				configurationVersionTransitionAllowed(
					plan(["environment"]),
					{ schemaVersion: configuration },
					{ schemaVersion: previous },
				),
			).toBe(allowed);
		},
	);

	it("fails closed on every plan that replaces the default Key until its attachment is persisted", () => {
		for (const [configuration, previous] of [
			[3, 3],
			[3, 2],
			[2, 2],
		] as const)
			expect(
				configurationVersionTransitionAllowed(
					plan(["defaultRelayKey", "modelConfiguration"]),
					{ schemaVersion: configuration },
					{ schemaVersion: previous },
				),
			).toBe(false);
	});
});
