import { describe, expect, it } from "vitest";

import { ConnectionApiError, connectionApi } from "./api";

describe("Connection Web 表单校验", () => {
	it("distinguishes upgrade approval guidance from inaccessible resources", () => {
		const detail = { code: "FORBIDDEN", retryable: false, traceId: "test" };
		expect(
			new ConnectionApiError({
				...detail,
				messageKey: "connection.error.provider_upgrade_approval_required",
			}).message,
		).toContain("请申请新版能力");
		expect(
			new ConnectionApiError({
				...detail,
				messageKey: "connection.error.resource_not_found",
			}).message,
		).toBe("无法访问该资源");
	});
	it("在发送请求前使用中文拒绝无效输入", () => {
		expect(() =>
			connectionApi.login({ password: "password", username: "   " }),
		).toThrow("请填写有效的公司账号和密码");
		expect(() => connectionApi.issueToken({ name: "   " })).toThrow(
			"令牌名称需为 1 到 100 个字符",
		);
		expect(() => connectionApi.createSharedScope("   ")).toThrow(
			"共享组名称需为 1 到 120 个字符",
		);
		expect(() =>
			connectionApi.startGithubOAuth("shared-1", "request-1"),
		).toThrow("共享组信息无效，请刷新后重试");
	});
});
