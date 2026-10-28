/** #3217：始终可用的文件工具；隔离 Bash 由 #3218 的实际内核/安装准入另行选择。 */
export const piWorkspaceToolNames: readonly string[] = Object.freeze([
	"read",
	"write",
	"edit",
	"find",
	"grep",
	"ls",
]);

const piToolIds: Readonly<Record<string, string>> = Object.freeze({
	read: "Read",
	write: "Edit",
	edit: "Edit",
	find: "Find",
	grep: "Grep",
	ls: "List",
	sandbox_bash: "Bash",
});

/** 工具事实与事件使用的稳定工具标识；未开放的工具记为 unavailable。 */
export function piToolId(toolName: unknown) {
	return typeof toolName === "string" && Object.hasOwn(piToolIds, toolName)
		? (piToolIds[toolName] as string)
		: "unavailable";
}
