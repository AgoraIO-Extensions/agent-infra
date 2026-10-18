import { describe, expect, it } from "vitest";
import {
	conversationDisplayTitle,
	untitledConversation,
} from "./conversation-display-title.js";

describe("conversationDisplayTitle", () => {
	it("统一回落为「未命名对话」", () => {
		expect(untitledConversation).toBe("未命名对话");
		for (const title of [null, undefined, "", "   "])
			expect(conversationDisplayTitle(title)).toBe("未命名对话");
	});

	it("保留服务端标题并去掉首尾空白", () => {
		expect(conversationDisplayTitle(" Connection 授权检查 ")).toBe(
			"Connection 授权检查",
		);
	});
});
