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

/**
 * #3217：列举与搜索类工具的路径参数。可以是任一根目录本身或其下的目录、普通文件；
 * 根目录必须已规范化，路径上任何一段都不能是符号链接。
 */
export async function workspaceDirectoryAllowed(
	roots: readonly string[],
	directory: string,
) {
	if (directory.includes("\0") || !isAbsolute(directory)) return false;
	const path = resolve(directory);
	for (const root of roots) {
		const within = relative(root, path);
		if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
			continue;
		try {
			if ((await realpath(root)) !== root) return false;
			let candidate = path;
			while (candidate !== root) {
				try {
					const stat = await lstat(candidate);
					// 搜索目标本身可以是目录或普通文件，上级只能是目录。
					if (
						stat.isSymbolicLink() ||
						(candidate === path
							? !stat.isDirectory() && !stat.isFile()
							: !stat.isDirectory())
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
	return false;
}

/** #3217：Glob 模式只能相对于已校验的目录，不能是绝对路径，也不能含 `..` 段。 */
export function workspaceGlobAllowed(pattern: string) {
	return (
		pattern.length > 0 &&
		!pattern.includes("\0") &&
		!isAbsolute(pattern) &&
		!pattern.startsWith("~") &&
		!pattern.split(/[\\/]+/).includes("..")
	);
}
