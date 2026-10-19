import { describe, expect, it } from "vitest";
import { distinctObjectNames, withObjectName } from "./accessible-name.js";

describe("withObjectName", () => {
	it("用全角冒号连接可见文字与对象名", () => {
		expect(withObjectName("刷新状态", "智能机器人")).toBe(
			"刷新状态：智能机器人",
		);
		expect(withObjectName("处理 Owner 交接", "Release assistant")).toBe(
			"处理 Owner 交接：Release assistant",
		);
	});

	it.each([undefined, null, "", "   "])(
		"对象名为空（%j）时只返回可见文字",
		(object) => {
			expect(withObjectName("查看详情", object)).toBe("查看详情");
		},
	);

	it("去除首尾空白并保留内部空白", () => {
		expect(withObjectName("  撤销 ", "\n credential-1\t")).toBe(
			"撤销：credential-1",
		);
		expect(withObjectName("详情", " 访问获准 · 2026/9/28 10:00:00 ")).toBe(
			"详情：访问获准 · 2026/9/28 10:00:00",
		);
	});

	it("忙碌态文案进入名称且仍以完整可见文字开头", () => {
		const name = withObjectName("验证中…", "智能机器人");
		expect(name).toBe("验证中…：智能机器人");
		expect(name.startsWith("验证中…")).toBe(true);
	});
});

describe("distinctObjectNames（N-12）", () => {
	it("重复的名称按出现顺序编号，不重复的原样返回", () => {
		const names = distinctObjectNames(["继续", "检查发布说明", "继续", "继续"]);
		expect(names).toEqual([
			"继续（第 1 次）",
			"检查发布说明",
			"继续（第 2 次）",
			"继续（第 3 次）",
		]);
		const labels = names.map((name) => withObjectName("查看执行详情", name));
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("没有重复时不改动", () => {
		expect(distinctObjectNames(["Private question", "Other"])).toEqual([
			"Private question",
			"Other",
		]);
		expect(distinctObjectNames([])).toEqual([]);
	});
});
