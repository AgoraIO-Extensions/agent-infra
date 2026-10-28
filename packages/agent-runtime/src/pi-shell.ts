import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

export const piNativeShellToolName = "sandbox_bash";
const launcher = "/opt/agent-infra/native-shell.mjs";
const executeFile = promisify(execFile);
const launcherEnvironment = (workspace: string) => ({
	PATH: "/usr/local/bin:/usr/bin:/bin",
	AGENT_INFRA_NATIVE_SHELL_WORKSPACE: workspace,
});

/** Kernel/installation admission, not a caller-provided enable flag. */
export async function piNativeShellAvailable(
	workspace: string,
): Promise<boolean> {
	if (process.platform !== "linux") return false;
	try {
		await executeFile(launcher, ["-c", "true"], {
			cwd: workspace,
			env: launcherEnvironment(workspace),
			timeout: 6000,
			maxBuffer: 1024,
		});
		return true;
	} catch {
		return false;
	}
}

export async function createPiNativeShellTool(workspace: string) {
	if (!(await piNativeShellAvailable(workspace))) return undefined;
	return {
		...createBashToolDefinition(workspace, {
			shellPath: launcher,
			exposeSessionEnvironment: false,
			spawnHook: ({ command }) => ({
				command,
				cwd: workspace,
				env: launcherEnvironment(workspace),
			}),
		}),
		// A missing extension must not expose Pi's unwrapped builtin bash fallback.
		name: piNativeShellToolName,
	};
}
