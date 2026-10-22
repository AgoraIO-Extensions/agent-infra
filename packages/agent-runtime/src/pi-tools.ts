/** #3217：Pi 标准模板开放的原生工具；shell 待 OS 级边界就绪后开放（#3218）。 */
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
});

/** 工具事实与事件使用的稳定工具标识；未开放的工具记为 unavailable。 */
export function piToolId(toolName: unknown) {
	return typeof toolName === "string" && Object.hasOwn(piToolIds, toolName)
		? (piToolIds[toolName] as string)
		: "unavailable";
}
