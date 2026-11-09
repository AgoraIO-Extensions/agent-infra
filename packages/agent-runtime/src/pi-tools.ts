/** Names shipped by the pinned Pi release; shell is replaced by our launcher. */
export const piWorkspaceToolNames: readonly string[] = Object.freeze([
	"read",
	"write",
	"edit",
	"find",
	"grep",
	"ls",
	"sandbox_bash",
	"powershell",
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

const nativeToolName = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;

/** Preserve native identities while keeping malformed event names unavailable. */
export function piToolId(toolName: unknown) {
	if (typeof toolName !== "string" || !nativeToolName.test(toolName))
		return "unavailable";
	return Object.hasOwn(piToolIds, toolName)
		? (piToolIds[toolName] as string)
		: toolName;
}
