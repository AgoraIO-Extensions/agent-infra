import { DirectorySearchResponseV1Schema } from "@agent-infra/contracts/pilot";

// 目录搜索的测试夹具（#3035）：单元测试与浏览器用例共用，响应经同一份契约 Schema 构造，
// 不维护另一套手写响应形状。生产代码不得引用本文件。

/** 请求地址：生成 Client 向 fetch 传入 Request，其他调用方可能传入字符串或 URL。 */
export function directoryRequestUrl(input: string | URL | Request) {
	return new URL(
		input instanceof Request ? input.url : String(input),
		"http://localhost",
	);
}

/**
 * 按契约构造目录搜索响应：回显请求的 kind 与去除首尾空白的 q；记录如何筛选由各用例决定。
 * 记录不符合契约时直接抛错，避免夹具与真实接口漂移。
 */
export function directorySearchResponse(url: URL, items: readonly unknown[]) {
	return DirectorySearchResponseV1Schema.parse({
		items,
		query: (url.searchParams.get("q") ?? "").trim(),
		kind: url.searchParams.get("kind"),
	});
}
