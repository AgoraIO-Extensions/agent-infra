import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

export const nativeShellLauncher = "/opt/agent-infra/native-shell.mjs";
const executeFile = promisify(execFile);
export const nativeShellLauncherEnvironment = (workspace: string) => ({
	PATH: "/usr/local/bin:/usr/bin:/bin",
	AGENT_INFRA_NATIVE_SHELL_WORKSPACE: workspace,
});

/** Kernel/installation admission, not a caller-provided enable flag. */
export async function nativeShellAvailable(
	workspace: string,
): Promise<boolean> {
	if (process.platform !== "linux") return false;
	try {
		const metadata = await stat(nativeShellLauncher);
		if (
			(await realpath(nativeShellLauncher)) !== nativeShellLauncher ||
			!metadata.isFile() ||
			(metadata.mode & 0o022) !== 0 ||
			(await access(nativeShellLauncher, constants.W_OK).then(
				() => true,
				() => false,
			))
		)
			return false;
		await executeFile(nativeShellLauncher, ["-c", "true"], {
			cwd: workspace,
			env: nativeShellLauncherEnvironment(workspace),
			timeout: 6000,
			maxBuffer: 1024,
		});
		return true;
	} catch {
		return false;
	}
}
