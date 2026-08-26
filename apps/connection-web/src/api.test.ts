import { describe, expect, it } from "vitest";

import { connectionApi } from "./api";

describe("Connection Web 表单校验", () => {
	it("在发送请求前使用中文拒绝无效输入", () => {
		expect(() =>
			connectionApi.login({ password: "password", username: "   " }),
		).toThrow("请填写有效的公司账号和密码");
		expect(() => connectionApi.issueToken("   ")).toThrow(
			"令牌名称需为 1 到 100 个字符",
		);
		expect(() => connectionApi.createSharedScope("   ")).toThrow(
			"共享组名称需为 1 到 120 个字符",
		);
	});
});
