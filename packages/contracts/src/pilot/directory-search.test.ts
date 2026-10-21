import { describe, expect, it } from "vitest";
import {
	DirectorySearchQueryV1Schema,
	DirectorySearchResponseV1Schema,
	directorySearchMaxIdsV1,
	directorySearchOpenApiPathsV1,
} from "./directory-search.ts";

const operation = directorySearchOpenApiPathsV1["/api/v2/directory/search"].get;

describe("directory search V2 contract (#3035)", () => {
	it("defaults the existing query parameters and trims the keyword", () => {
		expect(DirectorySearchQueryV1Schema.parse({ kind: "user" })).toEqual({
			kind: "user",
			q: "",
			limit: 20,
		});
		expect(
			DirectorySearchQueryV1Schema.parse({
				kind: "organization",
				q: "  平台  ",
				limit: "50",
				ids: "org-a,org-b",
			}),
		).toEqual({
			kind: "organization",
			q: "平台",
			limit: 50,
			ids: "org-a,org-b",
		});
		const ids = Array.from(
			{ length: directorySearchMaxIdsV1 },
			(_, index) => `user-${index}`,
		).join(",");
		expect(
			DirectorySearchQueryV1Schema.safeParse({ kind: "user", ids }).success,
		).toBe(true);
	});

	it.each([
		["a missing kind", {}],
		["an unknown kind", { kind: "group" }],
		["a keyword over 120 characters", { kind: "user", q: "x".repeat(121) }],
		["a zero limit", { kind: "user", limit: "0" }],
		["a limit over 50", { kind: "user", limit: "51" }],
		["a fractional limit", { kind: "user", limit: "1.5" }],
		["a non-numeric limit", { kind: "user", limit: "many" }],
		[
			"more than 50 IDs",
			{
				kind: "user",
				ids: Array.from(
					{ length: directorySearchMaxIdsV1 + 1 },
					(_, index) => `user-${index}`,
				).join(","),
			},
		],
		// 身份与组织只由服务端按当前会话解析，调用方不能提交范围字段。
		["a caller-supplied organization", { kind: "user", organizationId: "o" }],
		["a caller-supplied user", { kind: "user", userId: "user-1" }],
	])("rejects %s", (_name, query) => {
		expect(DirectorySearchQueryV1Schema.safeParse(query).success).toBe(false);
	});

	it("keeps the existing response shape strict", () => {
		const response = {
			items: [
				{
					kind: "user",
					canonicalId: "user-1",
					displayName: "林默",
					email: "lin@example.test",
					organizationPath: "研发 / 平台工程",
				},
				{ kind: "organization", canonicalId: "org-1", displayName: "平台工程" },
			],
			query: "林",
			kind: "user",
		};
		expect(DirectorySearchResponseV1Schema.parse(response)).toEqual(response);
		for (const invalid of [
			{ items: response.items },
			{ ...response, schemaVersion: 1 },
			{ ...response, kind: "group" },
			{ ...response, items: [{ ...response.items[0], canonicalId: "" }] },
			{ ...response, items: [{ ...response.items[0], email: null }] },
			{ ...response, items: [{ ...response.items[0], displayName: 1 }] },
			// 目录记录不带凭证、电话等未声明字段。
			{ ...response, items: [{ ...response.items[0], phone: "123" }] },
		])
			expect(DirectorySearchResponseV1Schema.safeParse(invalid).success).toBe(
				false,
			);
	});

	it("declares only platform-session access and stable error responses", () => {
		expect(operation.operationId).toBe("searchDirectoryV2");
		expect(operation.security).toEqual([{ PlatformSession: [] }]);
		// 依赖异常只返回契约内的 503，不声明 500。
		expect(Object.keys(operation.responses)).toEqual([
			"200",
			"400",
			"401",
			"403",
			"503",
		]);
	});
});
