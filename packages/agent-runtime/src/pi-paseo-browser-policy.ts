import {
	createMcpExtension,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { piBrowserMcpConfiguration } from "./pi-policy.js";
import { SANDBOX_FILE_INSTRUCTIONS_V1 } from "./sandbox-file-instructions.js";

/** This extension is loaded from the image only for an admitted browser execution. */
export default async function piPaseoBrowserPolicy(pi: ExtensionAPI) {
	const config = piBrowserMcpConfiguration();
	if (!config) throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
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
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n${SANDBOX_FILE_INSTRUCTIONS_V1}`,
	}));
}
