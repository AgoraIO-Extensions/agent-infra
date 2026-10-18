// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
// 对话页的时间调用点由对话页 Issue 迁移；迁移后从这里删除对应文件，不得新增条目。
const pendingConversationMigrations = new Set([
	"features/conversation/browser-audit-view.tsx",
	"features/conversation/conversation-navigation.tsx",
	"features/conversation/recent-conversation-history.tsx",
]);
const allowed = (path: string) =>
	path === "lib/format-time.ts" ||
	path.startsWith("pilot/generated") ||
	/\.(test|spec)\.[jt]sx?$/.test(path) ||
	pendingConversationMigrations.has(path);

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.[jt]sx?$/.test(entry.name) ? [path] : [];
	});
}

it("formats visible times only through formatTimestamp or <Timestamp>", () => {
	const violations = sourceFiles(sourceRoot)
		.map((path) => relative(sourceRoot, path).replaceAll("\\", "/"))
		.filter((path) => !allowed(path))
		.flatMap((path) =>
			readFileSync(join(sourceRoot, path), "utf8")
				.split("\n")
				.flatMap((line, index) =>
					/\.toLocale(?:Date|Time)?String\(|Intl\.DateTimeFormat/.test(line)
						? [`${path}:${index + 1}`]
						: [],
				),
		);
	expect(violations).toEqual([]);
});
