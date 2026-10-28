import { execFile } from "node:child_process";
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
