import { resolve } from "node:path";
import { workspacePathAllowed } from "./workspace-path.js";

/** Fixed 1.19.0 pending ACP titles, before later human-readable titles replace them. */
export function openCodeToolName(tool: {
	kind?: string | null;
	title?: string | null;
	rawInput?: unknown;
}) {
	const names: Record<string, readonly [string, string]> = {
		glob: ["search", "Glob"],
		grep: ["search", "Grep"],
		webfetch: ["fetch", "WebFetch"],
		websearch: ["other", "WebSearch"],
		todowrite: ["other", "TodoWrite"],
		apply_patch: ["edit", "ApplyPatch"],
	};
	const entry = typeof tool.title !== "string" ? undefined : names[tool.title];
	return entry && entry[0] === tool.kind ? entry[1] : undefined;
}

export async function openCodePatchAllowed(workspace: string, value: unknown) {
	if (
		typeof value !== "string" ||
		value.length > 1_048_576 ||
		value.includes("\0")
	)
		return false;
	const lines = value.replaceAll("\r\n", "\n").split("\n");
	if (
		lines[0] !== "*** Begin Patch" ||
		(lines.at(-1)?.trim() !== "*** End Patch" &&
			lines.at(-2) !== "*** End Patch")
	)
		return false;
	const paths: string[] = [];
	for (const line of lines.slice(1)) {
		const match =
			/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
		if (match?.[1]) paths.push(match[1]);
		else if (
			line.startsWith("*** ") &&
			!["*** End Patch", "*** End of File"].includes(line)
		)
			return false;
	}
	return (
		paths.length > 0 &&
		paths.length <= 100 &&
		(
			await Promise.all(
				paths.map((path) =>
					workspacePathAllowed(workspace, workspace, resolve(workspace, path)),
				),
			)
		).every(Boolean)
	);
}

export function openCodeFetchAllowed(value: unknown) {
	if (
		!value ||
		typeof value !== "object" ||
		!("url" in value) ||
		typeof value.url !== "string"
	)
		return false;
	if (
		Object.keys(value).some(
			(key) => !["url", "format", "timeout"].includes(key),
		)
	)
		return false;
	try {
		const url = new URL(value.url);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}
