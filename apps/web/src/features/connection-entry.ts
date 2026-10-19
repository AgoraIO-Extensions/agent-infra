/** 与服务端 validOrigin 一致：必须是 https，且 URL 规范化后的 origin 与原值完全相同。 */
function validOrigin(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.origin === value;
	} catch {
		return false;
	}
}

/** 与服务端 validPath 一致：单个前导斜杠，不含空白、控制字符、反斜杠、查询、片段与路径穿越。 */
function validPath(value: string) {
	return (
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!/[\s\p{Cc}\\?#]/u.test(value) &&
		!/%(?:2f|2e|5c)/i.test(value) &&
		!value.split("/").some((part) => part === "." || part === "..")
	);
}

/**
 * Platform Web 唯一的 Connection 入口地址：壳层「我的 Connection」与 Agent 详情共用。
 * 输入按 unknown 处理（浏览器会话读取 capability 时不做契约校验）：先分别校验原始
 * publicOrigin 与 mcpPath，再按工程 Spec §13.5.1 字符串拼接，最后断言拼接结果的 origin
 * 仍是 publicOrigin。任一步失败返回 undefined；不使用以 publicOrigin 为 base 的相对解析。
 */
export function connectionEntryUrl(capability: unknown): string | undefined {
	if (!capability || typeof capability !== "object") return undefined;
	const { status, publicOrigin, mcpPath } = capability as Record<
		string,
		unknown
	>;
	if (
		status !== "available" ||
		typeof publicOrigin !== "string" ||
		typeof mcpPath !== "string" ||
		!validOrigin(publicOrigin) ||
		!validPath(mcpPath)
	)
		return undefined;
	const href = publicOrigin + mcpPath;
	try {
		return new URL(href).origin === publicOrigin ? href : undefined;
	} catch {
		return undefined;
	}
}
