import { describe, expect, it } from "vitest";
import { cjkSpaced } from "./cjk-spacing.js";

describe("cjkSpaced", () => {
	it("adds one space between Han text and a Latin or digit interpolation", () => {
		const name = "Release assistant";
		expect(cjkSpaced`重启${name}？`).toBe("重启 Release assistant？");
		expect(cjkSpaced`${"可用 Agent"}无法读取，请重新登录。`).toBe(
			"可用 Agent 无法读取，请重新登录。",
		);
		expect(cjkSpaced`共${3}项`).toBe("共 3 项");
		expect(cjkSpaced`当前无权读取${"Owner 创建状态"}。`).toBe(
			"当前无权读取 Owner 创建状态。",
		);
	});

	it("keeps Han-to-Han joins and punctuation boundaries untouched", () => {
		expect(cjkSpaced`重启${"发布助理"}？`).toBe("重启发布助理？");
		expect(cjkSpaced`${"最近对话"}暂时无法读取。`).toBe(
			"最近对话暂时无法读取。",
		);
		expect(cjkSpaced`正在加载${"可用 Agent"}…`).toBe("正在加载可用 Agent…");
		expect(cjkSpaced`当前状态：${"Ready"}`).toBe("当前状态：Ready");
		expect(cjkSpaced`“${"Release"}”撤回`).toBe("“Release”撤回");
	});

	it("does not add a second space or touch empty and static parts", () => {
		expect(cjkSpaced`重启 ${"Release"} 吗`).toBe("重启 Release 吗");
		expect(cjkSpaced`重启${""}？`).toBe("重启？");
		expect(cjkSpaced`完成MFA验证`).toBe("完成MFA验证");
		expect(cjkSpaced`${"Agent"}${"助手"}`).toBe("Agent 助手");
	});
});
