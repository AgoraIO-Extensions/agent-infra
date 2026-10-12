import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
	CallToolResult,
	ListToolsResult,
	Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	type CodexBrowserToolDescriptorV1,
	createCodexBrowserToolDescriptorsV1,
} from "./codex-browser-tools.js";
import type {
	RuntimeBrowserExecutionContextV1,
	RuntimeBrowserToolExecutionResultV1,
} from "./driver.js";

const maximumBodyBytes = 1_048_576;

export interface BrowserMcpGatewayInputV1 {
	readonly capability: BrowserCapabilityAvailableV1;
	readonly context: RuntimeBrowserExecutionContextV1;
	readonly executionId: string;
}

export interface BrowserMcpGatewayV1 {
	readonly server: {
		readonly type: "http";
		readonly name: string;
		readonly url: string;
		readonly headers: [{ name: "Authorization"; value: string }];
	};
	close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authorized(request: IncomingMessage, token: string) {
	const value = request.headers.authorization;
	if (!value?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(value.slice("Bearer ".length), "utf8");
	const expected = Buffer.from(token, "utf8");
	return (
		supplied.length === expected.length && timingSafeEqual(supplied, expected)
	);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > maximumBodyBytes)
			throw new Error("BROWSER_MCP_REQUEST_TOO_LARGE");
		chunks.push(bytes);
	}
	if (!chunks.length) return undefined;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function mcpTool(descriptor: CodexBrowserToolDescriptorV1): Tool {
	return {
		name: descriptor.name,
		description: descriptor.description,
		inputSchema: descriptor.inputSchema as Tool["inputSchema"],
	};
}

function content(result: RuntimeBrowserToolExecutionResultV1): CallToolResult {
	return {
		content: result.contentItems.map((item) => ({
			type: "text",
			text: item.text,
		})),
		isError: result.phase !== "completed" || !result.success,
	};
}

function invalidResult(): CallToolResult {
	return {
		content: [{ type: "text", text: "BROWSER_EXECUTION_UNKNOWN" }],
		isError: true,
	};
}

/**
 * Serve the verified Browser descriptors over the only MCP transport supported
 * by the pinned OpenCode ACP peer. The listener is request-local and owns no
 * durable operation, scheduler or acknowledgement state.
 */
export async function createBrowserMcpGatewayV1(
	input: BrowserMcpGatewayInputV1,
): Promise<BrowserMcpGatewayV1> {
	if (
		input.capability.status !== "available" ||
		typeof input.context.executeTool !== "function" ||
		!input.executionId
	)
		throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
	const executeTool = input.context.executeTool;
	if (!executeTool) throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
	const descriptors = createCodexBrowserToolDescriptorsV1(input.capability);
	if (!descriptors.length) throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
	const descriptorMap = new Map(
		descriptors.map((descriptor) => [descriptor.name, descriptor]),
	);
	const token = randomBytes(32).toString("base64url");
	const mcp = new Server(
		{ name: "agent-infra-browser", version: "1" },
		{ capabilities: { tools: {} } },
	);
	mcp.setRequestHandler(
		ListToolsRequestSchema,
		() =>
			({
				tools: descriptors.map(mcpTool),
			}) satisfies ListToolsResult,
	);
	mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const name = request.params.name;
		const descriptor = descriptorMap.get(
			name as CodexBrowserToolDescriptorV1["name"],
		);
		const args = request.params.arguments;
		if (!descriptor || !isRecord(args)) return invalidResult();
		const pageRevision =
			typeof args.pageRevision === "number" &&
			Number.isSafeInteger(args.pageRevision) &&
			args.pageRevision > 0
				? args.pageRevision
				: 1;
		try {
			const toolRequest = {
				tool: name,
				arguments: args,
				actionId: randomUUID(),
				operationRef: randomUUID(),
				attemptRef: randomUUID(),
				binding: {
					...input.context.binding,
					executionId: input.executionId,
					capabilityVersion: input.context.capabilityVersion,
					pageRevision,
				},
			};
			const result = await executeTool(toolRequest, extra.signal);
			const bindingMatches = Object.entries(toolRequest.binding).every(
				([key, value]) => Reflect.get(result.binding, key) === value,
			);
			return result.actionId === toolRequest.actionId &&
				result.operationRef === toolRequest.operationRef &&
				result.attemptRef === toolRequest.attemptRef &&
				bindingMatches
				? content(result)
				: invalidResult();
		} catch {
			return invalidResult();
		}
	});
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
	});
	await mcp.connect(transport);
	const server = createServer(async (request, response) => {
		if (request.url !== "/mcp") {
			response.writeHead(404).end();
			return;
		}
		if (!authorized(request, token)) {
			response.writeHead(401).end();
			return;
		}
		if (request.method === "POST") {
			try {
				const body = await readJsonBody(request);
				await transport.handleRequest(request, response, body);
			} catch {
				if (!response.headersSent) response.writeHead(400).end();
			}
			return;
		}
		await transport.handleRequest(request, response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await transport.close().catch(() => {});
		await mcp.close().catch(() => {});
		server.close();
		throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
	}
	let closed = false;
	return {
		server: {
			type: "http",
			name: "agent-infra-browser",
			url: `http://127.0.0.1:${address.port}/mcp`,
			headers: [{ name: "Authorization", value: `Bearer ${token}` }],
		},
		async close() {
			if (closed) return;
			closed = true;
			await transport.close().catch(() => {});
			await mcp.close().catch(() => {});
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
