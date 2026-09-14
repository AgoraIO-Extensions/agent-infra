import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export async function workspacePathAllowed(
	workspace: string,
	memory: string,
	filePath: string,
) {
	if (filePath.includes("\0")) return false;
	const path = resolve(workspace, filePath);
	const root = [workspace, memory].find((root) => {
		const within = relative(root, path);
		return (
			within &&
			within !== ".." &&
			!within.startsWith(`..${sep}`) &&
			!isAbsolute(within)
		);
	});
	if (!root) return false;
	try {
		if ((await realpath(root)) !== root) return false;
		let candidate = path;
		while (candidate !== root) {
			try {
				const stat = await lstat(candidate);
				if (
					stat.isSymbolicLink() ||
					(candidate === path && !stat.isFile()) ||
					(candidate !== path && !stat.isDirectory())
				)
					return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			}
			candidate = dirname(candidate);
		}
		return true;
	} catch {
		return false;
	}
}
