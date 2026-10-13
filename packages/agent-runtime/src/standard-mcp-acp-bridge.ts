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
const maximumBridgeLifetimeMs = 5 * 60_000;

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
	readonly nativeSessionRef: () => string;
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
	const bridgeExpiresAt = Math.min(
		options.client.expiresAt,
		Date.now() + maximumBridgeLifetimeMs,
	);
	if (bridgeExpiresAt <= Date.now()) unavailable();
	const descriptorMap = new Map(
		tools(options.client).map((tool) => [tool.name, tool]),
	);
	const replayKeys = new Set<string>();
	let closed = false;
	let active = false;
	let blocked = false;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	let closePromise: Promise<void> | undefined;
	const expired = () => Date.now() >= bridgeExpiresAt;
	const mcp = new Server(
		{ name: "agent-infra-connection", version: "1" },
		{ capabilities: { tools: {} } },
	);
	let close: () => Promise<void>;
	mcp.setRequestHandler(ListToolsRequestSchema, async () => {
		if (closed || blocked || expired()) unavailable();
		await options.client.assertCurrent();
		return { tools: [...descriptorMap.values()] };
	});
	mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		if (closed || blocked || expired() || active) unavailable();
		const name = request.params.name;
		const tool = descriptorMap.get(name);
		const args = request.params.arguments;
		if (!tool || !isRecord(args)) unavailable();
		const digest = JSON.stringify([name, args]);
		const requestId =
			"requestId" in extra &&
			(typeof extra.requestId === "string" ||
				typeof extra.requestId === "number")
				? extra.requestId
				: undefined;
		const replayKey =
			requestId !== undefined
				? `${typeof requestId}:${String(requestId)}`
				: `digest:${digest}`;
		if (replayKeys.has(replayKey) || replayKeys.size >= maximumReplayKeys)
			unavailable();
		replayKeys.add(replayKey);
		active = true;
		const operationRef = randomUUID();
		const attemptRef = randomUUID();
		const startedAt = Date.now();
		let requestIdentity:
			| { rpcRequestId: string | number; requestDigest: string }
			| undefined;
		const write = async (phase: RuntimeOperationFactV2["phase"]) => {
			await options.recordOperationFact?.({
				kind: "tool",
				operationRef,
				attemptRef,
				phase,
				toolId: name,
				...(requestIdentity ?? {}),
				// The deployed MCP contract does not expose a same-call callRef or
				// an original-record query for this consumer.
				// Preserve the independently validated ConsumerInstance mapping while
				// keeping the call association explicitly unverified.
				connection: {
					serviceRef: options.client.serviceRef,
					verification: "unverified",
					consumerId: options.client.consumerId,
					instanceRef: options.client.instanceRef,
					credentialRevision: options.client.credentialRevision,
					reason: "record_unavailable",
				},
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
		const operation: StandardMcpOperation = {
			assertCurrent: async () => {
				if (closed || blocked || expired()) unavailable();
				await options.client.assertCurrent();
				const nativeSessionRef = options.nativeSessionRef();
				if (!nativeSessionRef.trim()) unavailable();
				const authorized = await options.authorizeToolAction?.({
					kind: "tool",
					nativeSessionRef,
					executionId: options.execution.executionId,
					runtimeOperationId: options.execution.executionId,
					operationRef,
					attemptRef,
				});
				if (options.authorizeToolAction && !authorized?.revalidate)
					unavailable();
				authorized?.revalidate?.();
				return () => {
					if (closed || blocked || expired()) unavailable();
					const guarded = authorized?.revalidate?.();
					if (guarded !== undefined) unavailable();
				};
			},
			block: () => {
				if (blocked) return;
				blocked = true;
				void Promise.resolve(options.onBlocked?.()).catch(() => {});
			},
			confirm: async (value) => {
				await write(value.phase);
			},
			prepare: async (request) => {
				requestIdentity = request;
				await write("intent");
			},
			started: async (request) => {
				requestIdentity = request;
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
		if (
			expired() ||
			request.method !== "POST" ||
			request.url !== "/mcp" ||
			!authorized(request, token)
		) {
			response.writeHead(404).end();
			if (expired()) void close();
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
	close = async () => {
		if (closePromise) return closePromise;
		closePromise = (async () => {
			closed = true;
			blocked = true;
			if (expiryTimer) clearTimeout(expiryTimer);
			await transport.close().catch(() => {});
			await mcp.close().catch(() => {});
			await options.client.close().catch(() => {});
			await new Promise<void>((resolve) => server.close(() => resolve()));
		})();
		return closePromise;
	};
	expiryTimer = setTimeout(() => void close(), bridgeExpiresAt - Date.now());
	if (typeof expiryTimer.unref === "function") expiryTimer.unref();
	return {
		server: {
			type: "http",
			name: "agent-infra-connection",
			url: `http://127.0.0.1:${address.port}/mcp`,
			headers: [{ name: "Authorization", value: `Bearer ${token}` }],
		},
		close,
	};
}
