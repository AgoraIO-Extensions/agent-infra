import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	nativeShellAvailable,
	nativeShellLauncher,
	nativeShellLauncherEnvironment,
} from "./native-shell-admission.js";

export const piNativeShellToolName = "sandbox_bash";
export { nativeShellAvailable as piNativeShellAvailable } from "./native-shell-admission.js";

export async function createPiNativeShellTool(workspace: string) {
	if (!(await nativeShellAvailable(workspace))) return undefined;
	return {
		...createBashToolDefinition(workspace, {
			shellPath: nativeShellLauncher,
			exposeSessionEnvironment: false,
			spawnHook: ({ command }) => ({
				command,
				cwd: workspace,
				env: nativeShellLauncherEnvironment(workspace),
			}),
		}),
		// A missing extension must not expose Pi's unwrapped builtin bash fallback.
		name: piNativeShellToolName,
	};
}
