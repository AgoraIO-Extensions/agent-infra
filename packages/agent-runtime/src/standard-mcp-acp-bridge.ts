import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
} from "./driver.js";
import type { RuntimeOriginalExecutionRef } from "./runtime-authorization.js";
import type {
	StandardMcpClient,
	StandardMcpOperation,
	StandardMcpResult,
} from "./standard-mcp-client.js";

const maximumBodyBytes = 1_048_576;
const maximumReplayKeys = 128;

export interface StandardMcpAcpBridge {
	readonly server: {
		readonly type: "http";
		readonly name: string;
		readonly url: string;
		readonly headers: [{ name: "Authorization"; value: string }];
	};
	close(): Promise<void>;
}

export interface StandardMcpAcpBridgeOptions {
	readonly client: StandardMcpClient;
	readonly execution: RuntimeOriginalExecutionRef;
	readonly nativeSessionRef?: () => string;
	readonly recordOperationFact?: (
		fact: RuntimeOperationFactV2,
	) => Promise<void>;
	readonly authorizeToolAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
	readonly onBlocked?: () => void | Promise<void>;
}

function unavailable(): never {
	throw new Error("CONNECTION_STANDARD_CLIENT_UNAVAILABLE");
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
		if (size > maximumBodyBytes) throw new Error("MCP_REQUEST_TOO_LARGE");
		chunks.push(bytes);
	}
	return chunks.length
		? JSON.parse(Buffer.concat(chunks).toString("utf8"))
		: undefined;
}

function tools(client: StandardMcpClient): Tool[] {
	const namespace = client.toolDefinitions.find(
		(entry) => entry.name === "connection",
	);
	if (!namespace) unavailable();
	return namespace.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema as Tool["inputSchema"],
	}));
}

function result(value: StandardMcpResult): CallToolResult {
	return {
		content: value.contentItems.map((item) => ({
			type: "text",
			text: item.text,
		})),
		isError: value.phase !== "completed" || !value.success,
	};
}

/**
 * Exposes a Host-owned StandardMcpClient through the ACP HTTP shape. The
 * native peer receives only the short-lived loopback bearer; Connection
 * credentials never enter the ACP payload.
 */
export async function createStandardMcpAcpBridge(
	options: StandardMcpAcpBridgeOptions,
): Promise<StandardMcpAcpBridge> {
	const token = randomBytes(32).toString("base64url");
	const descriptorMap = new Map(
		tools(options.client).map((tool) => [tool.name, tool]),
	);
	const replayKeys = new Set<string>();
	let closed = false;
	let active = false;
	const mcp = new Server(
		{ name: "agent-infra-connection", version: "1" },
		{ capabilities: { tools: {} } },
	);
	mcp.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [...descriptorMap.values()],
	}));
	mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		if (closed || active) unavailable();
		const name = request.params.name;
		const tool = descriptorMap.get(name);
		const args = request.params.arguments;
		if (!tool || !isRecord(args)) unavailable();
		const digest = JSON.stringify([name, args]);
		const requestId =
			"requestId" in extra &&
			(typeof extra.requestId === "string" ||
				typeof extra.requestId === "number")
				? String(extra.requestId)
				: digest;
		const replayKey = `${requestId}:${digest}`;
		if (replayKeys.has(replayKey) || replayKeys.size >= maximumReplayKeys)
			unavailable();
		replayKeys.add(replayKey);
		active = true;
		const operationRef = randomUUID();
		const attemptRef = randomUUID();
		const startedAt = Date.now();
		const write = async (phase: RuntimeOperationFactV2["phase"]) => {
			await options.recordOperationFact?.({
				kind: "tool",
				operationRef,
				attemptRef,
				phase,
				toolId: name,
				...(phase === "started"
					? { startedAt: new Date(startedAt).toISOString() }
					: {}),
				...(phase === "completed" || phase === "failed" || phase === "unknown"
					? {
							finishedAt: new Date().toISOString(),
							durationMs: Math.max(0, Date.now() - startedAt),
						}
					: {}),
				...(phase === "failed"
					? { failureCode: "operation_failed" as const }
					: phase === "unknown"
						? { failureCode: "recovery_unconfirmed" as const }
						: {}),
			});
		};
		let blocked = false;
		const operation: StandardMcpOperation = {
			assertCurrent: async () => {
				if (closed || blocked) unavailable();
				await options.client.assertCurrent();
				const authorized = await options.authorizeToolAction?.({
					kind: "tool",
					nativeSessionRef: options.nativeSessionRef?.() ?? "pending",
					executionId: options.execution.executionId,
					runtimeOperationId: options.execution.executionId,
					operationRef,
					attemptRef,
				});
				if (options.authorizeToolAction && !authorized?.revalidate)
					unavailable();
				authorized?.revalidate?.();
				return () => {
					if (closed || blocked) unavailable();
					const guarded = authorized?.revalidate?.();
					if (guarded !== undefined) unavailable();
				};
			},
			block: () => {
				if (blocked) return;
				blocked = true;
				void options.onBlocked?.();
			},
			confirm: async (value) => {
				await write(value.phase);
			},
			prepare: async () => {
				await write("intent");
			},
			started: async () => {
				await write("started");
			},
		};
		try {
			return result(
				await options.client.call(
					name,
					args,
					operation,
					AbortSignal.any([extra.signal, AbortSignal.timeout(30_000)]),
				),
			);
		} finally {
			active = false;
		}
	});
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
	});
	await mcp.connect(transport);
	const server = createServer(async (request, response) => {
		if (request.url !== "/mcp" || !authorized(request, token)) {
			response.writeHead(404).end();
			return;
		}
		try {
			const body =
				request.method === "POST" ? await readJsonBody(request) : undefined;
			await transport.handleRequest(request, response, body);
		} catch {
			if (!response.headersSent) response.writeHead(400).end();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await transport.close().catch(() => {});
		await mcp.close().catch(() => {});
		server.close();
		unavailable();
	}
	return {
		server: {
			type: "http",
			name: "agent-infra-connection",
			url: `http://127.0.0.1:${address.port}/mcp`,
			headers: [{ name: "Authorization", value: `Bearer ${token}` }],
		},
		async close() {
			if (closed) return;
			closed = true;
			await transport.close().catch(() => {});
			await mcp.close().catch(() => {});
			await options.client.close().catch(() => {});
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
