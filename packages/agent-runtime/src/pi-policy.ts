import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { workspacePathAllowed } from "./workspace-path.js";

/** Loaded explicitly by the pinned Pi CLI; project and user extension discovery are disabled. */
export default function piWorkspacePolicy(pi: ExtensionAPI) {
	const workspace = process.env.AGENT_INFRA_PI_WORKSPACE;
	if (!workspace) throw new Error("RUNTIME_CONFIGURATION_INVALID");
	const memory = join(workspace, ".memory");
	pi.on("session_start", async (_event, context) => {
		context.ui.setTitle("agent-infra-policy-v1");
	});
	pi.on("tool_call", async (event) => {
		const input = event.input as Record<string, unknown>;
		if (
			!["read", "write", "edit"].includes(event.toolName) ||
			typeof input.path !== "string" ||
			!(await workspacePathAllowed(workspace, memory, input.path))
		)
			return { block: true, reason: "RUNTIME_WORKSPACE_ACCESS_DENIED" };
	});
	pi.on("before_agent_start", async (event) => {
		const file = join(memory, "MEMORY.md");
		if (!(await workspacePathAllowed(workspace, memory, file)))
			throw new Error("RUNTIME_WORKSPACE_ACCESS_DENIED");
		const content = await readFile(file, "utf8").catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT")
					throw new Error("RUNTIME_WORKSPACE_ACCESS_DENIED");
				return "";
			},
		);
		return {
			systemPrompt: `${event.systemPrompt}\nPersonal memory is in .memory/MEMORY.md inside your workspace.\n${content}`,
		};
	});
}
