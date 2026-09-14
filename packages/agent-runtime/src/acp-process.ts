import {
	type NativeProcessLaunch,
	retireNativeProcess,
	spawnNativeProcess,
} from "./native-process.js";
export const retireAcpProcess = (directory: string) =>
	retireNativeProcess(directory, "AGENT_INFRA_ACP_OWNER");
export const spawnAcpProcess = (
	directory: string,
	cwd: string,
	launch: NativeProcessLaunch,
) => spawnNativeProcess(directory, cwd, launch, "AGENT_INFRA_ACP_OWNER");
