import { createRequire } from "node:module";
import { expect, type Page } from "@playwright/test";

// #3035：页面发出的每个 /api/ 请求都必须能匹配生成 Client 的方法与路径模板。
// 模板直接取自生成 Client 的输入（提交到仓库的浏览器 OpenAPI 产物），不另行维护清单。

type OpenApiDocument = {
	readonly paths: Record<string, Record<string, unknown>>;
};

const require = createRequire(import.meta.url);
const documents: readonly OpenApiDocument[] = [
	require("@agent-infra/contracts/openapi/pilot-browser.v1"),
	require("@agent-infra/contracts/openapi/pilot-browser.v2"),
];
const httpMethods = new Set(["get", "put", "post", "delete", "patch"]);
const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
const templates = documents.flatMap((document) =>
	Object.entries(document.paths).flatMap(([path, operations]) =>
		Object.keys(operations)
			.filter((method) => httpMethods.has(method))
			.map((method) => ({
				method: method.toUpperCase(),
				// 路径参数只匹配单个非空路径段。
				pattern: new RegExp(
					`^${path
						.split(/\{[^}]+\}/)
						.map(escapeRegExp)
						.join("[^/]+")}$`,
				),
			})),
	),
);

/** 开始记录页面的 /api/ 请求；返回的 expectGenerated 断言其中没有绕过生成 Client 的请求。 */
export function recordApiRequests(page: Page) {
	const requests: string[] = [];
	page.on("request", (request) => {
		const { pathname } = new URL(request.url());
		if (pathname.startsWith("/api/"))
			requests.push(`${request.method()} ${pathname}`);
	});
	return {
		requests,
		expectGenerated(context: string) {
			const unmatched = requests.filter((entry) => {
				const [method, pathname] = entry.split(" ");
				return !templates.some(
					(template) =>
						template.method === method && template.pattern.test(pathname ?? ""),
				);
			});
			expect(requests.length, `${context} 应当发出 /api/ 请求`).toBeGreaterThan(
				0,
			);
			expect(unmatched, `${context} 不在生成 Client 中的请求`).toEqual([]);
		},
	};
}
