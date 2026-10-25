// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * 站内跳转必须用路由 Link：原生 <a href="/..."> 会整页重新加载，丢掉查询缓存与会话状态。
 * 原生 <a> 只允许以下非 SPA 目标，href 必须是这里列出的表达式（逐个说明原因）：
 */
const allowedHrefs = new Map<string, string>([
	// 自有交互入口：Agent 自己的外部 https 地址，新窗口打开。
	["features/agent-discovery/agent-detail-screen.tsx#interactionUrl", "外链"],
	// 「我的 Connection」：Connection 是独立部署单元，不是本 SPA 的路由，新窗口打开。
	["features/agent-discovery/connection-notice.tsx#href", "Connection 入口"],
	["features/application-shell.tsx#connectionUrl", "Connection 入口"],
	["features/conversation/conversation-context-bar.tsx#url", "Connection 入口"],
	[
		"features/my-agents/agent-application-form.tsx#props.connectionUrl",
		"Connection 入口",
	],
	// 品牌链接：useLinkProps 生成的路由链接（去掉 aria-current 后展开到 <a>），不是原生跳转。
	["features/application-shell.tsx#{...props}", "路由链接"],
	// 跳到主内容的页内锚点（skip link）。
	['features/application-shell.tsx#"#main-content"', "页内锚点"],
	// 开发测试身份的登录入口由服务端处理并重定向，必须整页导航。
	["features/login-page.tsx#loginUrl", "服务端登录入口"],
	// 回复正文里的外链：只放行 http(s)，新窗口打开。
	["features/conversation/assistant-markdown.tsx#safeHref", "外链"],
]);

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.tsx$/.test(entry.name) ? [path] : [];
	});
}

/** 返回文件里每个原生 <a> 的 href 表达式文本（没有 href 时为 null）。 */
function nativeAnchorHrefs(path: string, source: string) {
	const file = ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	const found: { line: number; href: string | null }[] = [];
	function visit(node: ts.Node) {
		if (
			(ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
			node.tagName.getText(file) === "a"
		) {
			const href = node.attributes.properties.find(
				(item): item is ts.JsxAttribute =>
					ts.isJsxAttribute(item) && item.name.getText(file) === "href",
			);
			const value = href?.initializer;
			// 没有 href、只有展开属性时记下展开的表达式（例如 useLinkProps 的结果）。
			const spread = node.attributes.properties.find(ts.isJsxSpreadAttribute);
			const text = value
				? ts.isJsxExpression(value) && value.expression
					? value.expression.getText(file)
					: value.getText(file)
				: spread
					? `{...${spread.expression.getText(file)}}`
					: null;
			found.push({
				line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
				href: text,
			});
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}

describe("internal link policy", () => {
	it("uses router Link for in-app paths and keeps native <a> to the listed non-SPA targets", () => {
		const violations = sourceFiles(sourceRoot)
			.map((path) => relative(sourceRoot, path).replaceAll("\\", "/"))
			.filter((path) => !/\.(test|spec)\.tsx$/.test(path))
			.flatMap((path) =>
				nativeAnchorHrefs(path, readFileSync(join(sourceRoot, path), "utf8"))
					.filter(({ href }) => !allowedHrefs.has(`${path}#${href}`))
					.map(({ line, href }) => `${path}:${line} href=${href}`),
			);
		expect(violations).toEqual([]);
	});

	it("flags literal, template and computed in-app hrefs", () => {
		// 模板字符串 `/agents/${id}`：拆开拼接，避免在普通字符串里写出插值语法。
		const dynamic = ["`/agents/", "{id}`"].join("$");
		const hrefs = nativeAnchorHrefs(
			"features/example.tsx",
			[
				'const a = <a href="/skills">Skill Hub</a>;',
				`const b = <a href={${dynamic}}>详情</a>;`,
				"const c = <a href={configurationHref}>配置</a>;",
				'const d = <Link to="/skills">Skill Hub</Link>;',
			].join("\n"),
		);
		expect(hrefs.map(({ href }) => href)).toEqual([
			'"/skills"',
			dynamic,
			"configurationHref",
		]);
		for (const { href } of hrefs)
			expect(allowedHrefs.has(`features/example.tsx#${href}`)).toBe(false);
	});
});
