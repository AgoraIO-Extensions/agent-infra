import { writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
	createMcpExtension,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { piBrowserMcpConfiguration } from "./pi-policy.js";
import { SANDBOX_FILE_INSTRUCTIONS_V1 } from "./sandbox-file-instructions.js";

/** This extension is loaded from the image only for an admitted browser execution. */
export default async function piPaseoBrowserPolicy(pi: ExtensionAPI) {
	const workspace = process.env.AGENT_INFRA_PI_WORKSPACE;
	const config = piBrowserMcpConfiguration();
	if (!workspace || !config) throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
	delete process.env.AGENT_INFRA_PI_BROWSER_MCP_URL;
	delete process.env.AGENT_INFRA_PI_BROWSER_MCP_TOKEN;
	await createMcpExtension({
		loadConfig: () => ({
			servers: [
				{
					name: "agent-infra-browser",
					config,
					scope: "extension",
					source: "agent-infra-browser",
				},
			],
			errors: [],
			autoEnableCodemode: false,
		}),
	})(pi);
	const write = createWriteToolDefinition(workspace, {
		operations: {
			async mkdir(directory) {
				if (directory !== workspace)
					throw new Error("RUNTIME_WORKSPACE_ACCESS_DENIED");
			},
			async writeFile(file, content) {
				if (
					dirname(file) !== workspace ||
					!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.txt$/.test(basename(file)) ||
					Buffer.byteLength(content) > 65_536
				)
					throw new Error("RUNTIME_WORKSPACE_ACCESS_DENIED");
				await writeFile(file, content, { flag: "wx", mode: 0o600 });
			},
		},
	});
	pi.registerTool({
		...write,
		name: "write_report",
		label: "Write text report",
		description:
			"Create a new small UTF-8 text report in this workspace. Use a simple unique filename ending in .txt and link it in your final answer using sandbox:filename.txt.",
		promptSnippet: "Create a text report for this conversation.",
		promptGuidelines: [],
	});
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n${SANDBOX_FILE_INSTRUCTIONS_V1}`,
	}));
}
