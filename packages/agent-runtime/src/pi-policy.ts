import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { workspacePathAllowed } from "./workspace-path.js";

export type PiFileDispatchOperationV1 = "read" | "write" | "access" | "mkdir";

export interface PiFileDispatchV1 {
	readonly operation: PiFileDispatchOperationV1;
	readonly path: string;
}

export interface PiWorkspaceToolOptionsV1 {
	readonly onFileDispatch?: (event: PiFileDispatchV1) => void | Promise<void>;
}

const piConnectionMcpUrlEnvironment = "AGENT_INFRA_PI_CONNECTION_MCP_URL";
const piConnectionMcpTokenEnvironment = "AGENT_INFRA_PI_CONNECTION_MCP_TOKEN";

/** Resolve the Host-owned loopback MCP bridge without accepting a native URL or token input. */
export function piConnectionMcpConfiguration(
	environment: NodeJS.ProcessEnv = process.env,
): McpServerConfig | undefined {
	const url = environment[piConnectionMcpUrlEnvironment];
	const token = environment[piConnectionMcpTokenEnvironment];
	if (url === undefined && token === undefined) return undefined;
	if (
		typeof url !== "string" ||
		typeof token !== "string" ||
		!/^[\x21-\x7e]{16,4096}$/.test(token)
	)
		throw new Error("RUNTIME_CONNECTION_MCP_UNAVAILABLE");
	try {
		const parsed = new URL(url);
		if (
			parsed.protocol !== "http:" ||
			!(
				(parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
				parsed.pathname === "/mcp"
			) ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash
		)
			throw new Error();
	} catch {
		throw new Error("RUNTIME_CONNECTION_MCP_UNAVAILABLE");
	}
	return {
		url,
		headers: { Authorization: `Bearer ${token}` },
		exposure: "direct",
	};
}

/** Keep Pi's own argument parsing, mutation queue and text handling. Enforce the
 * boundary in its supported filesystem operations, after all path transformations. */
export function createPiWorkspaceTools(
	workspace: string,
	options: PiWorkspaceToolOptionsV1 = {},
): {
	read: ReturnType<typeof createReadToolDefinition>;
	write: ReturnType<typeof createWriteToolDefinition>;
	edit: ReturnType<typeof createEditToolDefinition>;
} {
	const memory = join(workspace, ".memory");
	const guard = async (path: string) => {
		if (!(await workspacePathAllowed(workspace, memory, path)))
			throw new Error("RUNTIME_WORKSPACE_ACCESS_DENIED");
	};
	const dispatch = async (operation: PiFileDispatchOperationV1, path: string) =>
		options.onFileDispatch?.({ operation, path });
	const read = async (path: string) => {
		await guard(path);
		await dispatch("read", path);
		return readFile(path);
	};
	const write = async (path: string, content: string) => {
		await guard(path);
		await dispatch("write", path);
		await writeFile(path, content, "utf8");
	};
	const check = async (path: string) => {
		await guard(path);
		await dispatch("access", path);
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
					const marker = join(directory, ".pi-directory-access");
					await guard(marker);
					await dispatch("mkdir", directory);
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
	const connectionMcp = piConnectionMcpConfiguration();
	pi.registerTool(tools.read);
	pi.registerTool(tools.write);
	pi.registerTool(tools.edit);
	if (connectionMcp)
		pi.registerMcpServer("agent-infra-connection", connectionMcp);
	pi.on("session_start", async (_event, context) => {
		context.ui.setTitle("agent-infra-policy-v1");
	});
	pi.on("tool_call", async (event) => {
		const connectionTool = /^mcp__agent[-_]infra[-_]connection__/.test(
			event.toolName,
		);
		if (
			!["read", "write", "edit"].includes(event.toolName) &&
			!(connectionMcp && connectionTool)
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
