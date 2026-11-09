import { resolve } from "node:path";
import {
	workspaceDirectoryAllowed,
	workspacePathAllowed,
} from "./workspace-path.js";

const nativeToolTitle = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;

/** Map pinned titles while retaining a stable identity for new native titles. */
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
	if (typeof tool.title !== "string") return undefined;
	const entry = names[tool.title];
	if (entry) return entry[0] === tool.kind ? entry[1] : undefined;
	return nativeToolTitle.test(tool.title) ? tool.title : undefined;
}

/**
 * Unknown native tools still run inside the pinned ACP process. Guard common
 * path-bearing fields without inventing a second tool-specific allowlist.
 */
export async function openCodeNativeToolInputAllowed(
	workspace: string,
	input: unknown,
) {
	if (input === undefined) return true;
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const record = input as Record<string, unknown>;
	if ("url" in record) return openCodeFetchAllowed(record);
	for (const key of [
		"filePath",
		"file_path",
		"notebookPath",
		"notebook_path",
		"path",
		"cwd",
		"directory",
		"workdir",
		"workingDirectory",
	] as const) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.includes("\0")) return false;
		const roots = [workspace, `${workspace}/.memory`];
		const allowed = [
			"path",
			"cwd",
			"directory",
			"workdir",
			"workingDirectory",
		].includes(key)
			? await workspaceDirectoryAllowed(roots, resolve(workspace, value))
			: await workspacePathAllowed(workspace, `${workspace}/.memory`, value);
		if (!allowed) return false;
	}
	return true;
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
