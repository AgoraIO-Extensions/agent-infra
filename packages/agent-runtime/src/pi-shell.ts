import {
	nativeShellAvailable,
	nativeShellLauncher,
	nativeShellLauncherEnvironment,
} from "./native-shell-admission.js";

export const piNativeShellToolName = "sandbox_bash";
export { nativeShellAvailable as piNativeShellAvailable } from "./native-shell-admission.js";

export async function createPiNativeShellTool(workspace: string) {
	if (!(await nativeShellAvailable(workspace))) return undefined;
	const { createBashToolDefinition } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const tool = createBashToolDefinition(workspace, {
		shellPath: nativeShellLauncher,
		exposeSessionEnvironment: false,
		spawnHook: ({ command }) => ({
			command,
			cwd: workspace,
			env: nativeShellLauncherEnvironment(workspace),
		}),
	});
	return {
		...tool,
		async execute(...args: Parameters<typeof tool.execute>) {
			if (!(await nativeShellAvailable(workspace)))
				throw new Error("RUNTIME_NATIVE_SHELL_UNAVAILABLE");
			return tool.execute(...args);
		},
		// A missing extension must not expose Pi's unwrapped builtin bash fallback.
		name: piNativeShellToolName,
	};
}
