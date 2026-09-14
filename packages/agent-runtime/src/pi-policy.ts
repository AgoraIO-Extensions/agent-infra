import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { workspacePathAllowed } from "./workspace-path.js";

/** Keep Pi's own argument parsing, mutation queue and text handling. Enforce the
 * boundary in its supported filesystem operations, after all path transformations. */
export function createPiWorkspaceTools(workspace: string): {
	read: ReturnType<typeof createReadToolDefinition>;
	write: ReturnType<typeof createWriteToolDefinition>;
	edit: ReturnType<typeof createEditToolDefinition>;
} {
	const memory = join(workspace, ".memory");
	const guard = async (path: string) => {
		if (!(await workspacePathAllowed(workspace, memory, path)))
			throw new Error("RUNTIME_WORKSPACE_ACCESS_DENIED");
	};
	const read = async (path: string) => {
		await guard(path);
		return readFile(path);
	};
	const write = async (path: string, content: string) => {
		await guard(path);
		await writeFile(path, content, "utf8");
	};
	const check = async (path: string) => {
		await guard(path);
		await access(path, constants.R_OK);
	};
	return {
		read: createReadToolDefinition(workspace, {
			operations: { readFile: read, access: check },
		}),
		write: createWriteToolDefinition(workspace, {
			operations: {
				writeFile: write,
				mkdir: async (directory) => {
					await guard(join(directory, ".pi-directory-access"));
					await mkdir(directory, { recursive: true });
				},
			},
		}),
		edit: createEditToolDefinition(workspace, {
			operations: { readFile: read, writeFile: write, access: check },
		}),
	};
}

/** Loaded explicitly by the pinned Pi CLI; project and user extension discovery are disabled. */
export default function piWorkspacePolicy(pi: ExtensionAPI) {
	const workspace = process.env.AGENT_INFRA_PI_WORKSPACE;
	if (!workspace) throw new Error("RUNTIME_CONFIGURATION_INVALID");
	const memory = join(workspace, ".memory");
	const tools = createPiWorkspaceTools(workspace);
	pi.registerTool(tools.read);
	pi.registerTool(tools.write);
	pi.registerTool(tools.edit);
	pi.on("session_start", async (_event, context) => {
		context.ui.setTitle("agent-infra-policy-v1");
	});
	pi.on("tool_call", async (event) => {
		if (!["read", "write", "edit"].includes(event.toolName))
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
