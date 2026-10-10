import { afterEach, expect, it, vi } from "vitest";
import { connectionApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
it.each([
	[401, "登录已失效"],
	[403, "仅 Connection 管理员"],
	[400, "请检查 Consumer ID"],
	[409, "请刷新后重试"],
	[500, "暂时不可用"],
])("Agent 接入 HTTP %i 使用可行动的安全提示", async (status, message) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("sensitive backend detail", { status })),
	);
	await expect(connectionApi.listPatConsumers()).rejects.toThrow(message);
});
