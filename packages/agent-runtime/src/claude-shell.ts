import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { nativeShellLauncher } from "./native-shell-admission.js";

export const claudeShellLauncher = "/opt/agent-infra/native-bash.mjs";
export const claudeShellEnvironment = (workspace: string) => ({
	CLAUDE_CODE_SHELL: claudeShellLauncher,
	AGENT_INFRA_NATIVE_SHELL_WORKSPACE: workspace,
	TMPDIR: workspace,
});

/** Reject the upstream ordinary-shell fallback before exposing Bash. */
export async function claudeShellAvailable(
	workspace: string,
): Promise<boolean> {
	if (process.platform !== "linux") return false;
	try {
		for (const path of [claudeShellLauncher, nativeShellLauncher]) {
			const metadata = await stat(path);
			if (
				(await realpath(path)) !== path ||
				!metadata.isFile() ||
				(metadata.mode & 0o022) !== 0 ||
				(await access(path, constants.W_OK).then(
					() => true,
					() => false,
				))
			)
				return false;
		}
		if (
			!(await readFile(claudeShellLauncher)).equals(
				await readFile(nativeShellLauncher),
			)
		)
			return false;
		await promisify(execFile)(claudeShellLauncher, ["-c", "-l", "true"], {
			cwd: workspace,
			env: {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				...claudeShellEnvironment(workspace),
			},
			timeout: 6000,
			maxBuffer: 1024,
		});
		return true;
	} catch {
		return false;
	}
}
