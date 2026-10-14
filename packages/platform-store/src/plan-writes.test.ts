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

	it("admits a Key-replacing plan only with its Key attachment and only on V3 over V3 (#2421)", () => {
		const keyPlan = plan(["defaultRelayKey", "modelConfiguration"]);
		const check = (
			configuration: 2 | 3,
			previous: 2 | 3,
			keyAttached: boolean,
		) =>
			configurationVersionTransitionAllowed(
				keyPlan,
				{ schemaVersion: configuration },
				{ schemaVersion: previous },
				keyAttached,
			);
		expect(check(3, 3, true)).toBe(true);
		// 计划声明替换 Key 却没有附件：配置会前进而新 Key 被静默丢弃。
		expect(check(3, 3, false)).toBe(false);
		// V2 基线不能借 Key 替换变成 V3，V3 也不能降级。
		expect(check(3, 2, true)).toBe(false);
		expect(check(2, 3, true)).toBe(false);
		expect(check(2, 2, true)).toBe(false);
	});

	it("rejects a Key attachment on a plan that does not replace the Key", () => {
		for (const [configuration, previous] of [
			[3, 3],
			[2, 2],
		] as const)
			expect(
				configurationVersionTransitionAllowed(
					plan(["environment"]),
					{ schemaVersion: configuration },
					{ schemaVersion: previous },
					true,
				),
			).toBe(false);
	});
});
