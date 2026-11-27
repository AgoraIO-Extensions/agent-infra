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
import {
	type DynamicConnectionClientV1,
	declaredConnectionDefinitions,
	dynamicConnectionRefusalsV1,
} from "./dynamic-connection.js";
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

export interface StandardMcpAcpBridgeCall {
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
	readonly close?: () => Promise<void>;
}

export interface StandardMcpAcpBridgeOptions {
	/**
	 * The Execution's protected client. Absent only with `declared` and
	 * `refusal` (§13.5.6): every call then answers the fixed refusal and sends
	 * nothing to Connection.
	 */
	readonly client?: StandardMcpClient;
	readonly declared?: DynamicConnectionClientV1["declared"];
	readonly refusal?: keyof typeof dynamicConnectionRefusalsV1;
	readonly execution?: RuntimeOriginalExecutionRef;
	readonly nativeSessionRef?: () => string;
	readonly recordOperationFact?: (
		fact: RuntimeOperationFactV2,
	) => Promise<void>;
	readonly authorizeToolAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
	readonly onBlocked?: () => void | Promise<void>;
	/** A session-scoped bearer that survives Host restart while the Agent is durable. */
	readonly token?: string;
	readonly listenPort?: number;
	readonly resolveCall?: () => Promise<
		| StandardMcpAcpBridgeCall
		| { readonly refusal: keyof typeof dynamicConnectionRefusalsV1 }
	>;
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

function tools(
	definitions: ReturnType<typeof declaredConnectionDefinitions>,
): Tool[] {
	const namespace = definitions.find((entry) => entry.name === "connection");
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
 * native peer receives only the session-scoped loopback bearer; Connection
 * credentials never enter the ACP payload.
 */
export async function createStandardMcpAcpBridge(
	options: StandardMcpAcpBridgeOptions,
): Promise<StandardMcpAcpBridge> {
	const token = options.token ?? randomBytes(32).toString("base64url");
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) unavailable();
	const client = options.client;
	if (
		options.listenPort !== undefined &&
		(!Number.isInteger(options.listenPort) ||
			options.listenPort < 1024 ||
			options.listenPort > 65535)
	)
		unavailable();
	if (
		(!options.resolveCall &&
			(client
				? options.declared !== undefined || options.refusal !== undefined
				: options.declared === undefined || options.refusal === undefined)) ||
		(options.resolveCall &&
			!client &&
			options.declared === undefined &&
			options.refusal !== undefined)
	)
		unavailable();
	const bridgeExpiresAt = Math.min(
		client?.expiresAt ?? Number.POSITIVE_INFINITY,
		Date.now() + maximumBridgeLifetimeMs,
	);
	if (bridgeExpiresAt <= Date.now()) unavailable();
	const descriptorMap = new Map<string, Tool>();
	const updateDescriptors = (next: Tool[]) => {
		descriptorMap.clear();
		for (const tool of next) descriptorMap.set(tool.name, tool);
	};
	if (client) updateDescriptors(tools(client.toolDefinitions));
	else if (options.declared)
		updateDescriptors(tools(declaredConnectionDefinitions(options.declared)));
	const replayKeys = new Set<string>();
	let closed = false;
	let active = false;
	let blocked = false;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	let closePromise: Promise<void> | undefined;
	const openClients = new Set<StandardMcpClient>();
	if (client) openClients.add(client);
	const expired = () => Date.now() >= bridgeExpiresAt;
	const mcp = new Server(
		{ name: "agent-infra-connection", version: "1" },
		{ capabilities: { tools: {} } },
	);
	let close: () => Promise<void>;
	mcp.setRequestHandler(ListToolsRequestSchema, async () => {
		if (closed || blocked || expired()) unavailable();
		if (options.resolveCall) {
			const resolved = await options.resolveCall();
			if (!("refusal" in resolved)) {
				try {
					await resolved.client.assertCurrent();
					updateDescriptors(tools(resolved.client.toolDefinitions));
				} finally {
					await resolved.close?.().catch(() => {});
				}
			}
		} else await client?.assertCurrent();
		return { tools: [...descriptorMap.values()] };
	});
	mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		if (closed || blocked || expired() || active) unavailable();
		const name = request.params.name;
		const args = request.params.arguments;
		if (!isRecord(args)) unavailable();
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
		const resolved = options.resolveCall
			? await options.resolveCall()
			: undefined;
		if (resolved && "refusal" in resolved) {
			// §13.5.6: a deterministic refusal decided before any Connection request.
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(dynamicConnectionRefusalsV1[resolved.refusal]),
					},
				],
				isError: true,
			};
		}
		if (resolved && "client" in resolved) {
			try {
				updateDescriptors(tools(resolved.client.toolDefinitions));
			} catch (error) {
				await resolved.close?.().catch(() => {});
				throw error;
			}
		}
		const tool = descriptorMap.get(name);
		if (!tool) {
			await resolved?.close?.().catch(() => {});
			unavailable();
		}
		const call: StandardMcpAcpBridgeCall | undefined = resolved
			? resolved
			: client && options.execution && options.nativeSessionRef
				? {
						client,
						execution: options.execution,
						nativeSessionRef: options.nativeSessionRef,
						recordOperationFact: options.recordOperationFact,
						authorizeToolAction: options.authorizeToolAction,
						onBlocked: options.onBlocked,
					}
				: undefined;
		if (!call) {
			if (options.refusal === undefined) unavailable();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(dynamicConnectionRefusalsV1[options.refusal]),
					},
				],
				isError: true,
			};
		}
		openClients.add(call.client);
		active = true;
		const operationRef = randomUUID();
		const attemptRef = randomUUID();
		const startedAt = Date.now();
		let requestIdentity:
			| { rpcRequestId: string | number; requestDigest: string }
			| undefined;
		let blockNotified = false;
		let intentCommitted = false;
		const notifyBlocked = async () => {
			if (blockNotified) return;
			blockNotified = true;
			await Promise.resolve(call.onBlocked?.()).catch(() => {});
		};
		const write = async (phase: RuntimeOperationFactV2["phase"]) => {
			await call.recordOperationFact?.({
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
					serviceRef: call.client.serviceRef,
					verification: "unverified",
					consumerId: call.client.consumerId,
					instanceRef: call.client.instanceRef,
					credentialRevision: call.client.credentialRevision,
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
				await call.client.assertCurrent();
				const nativeSessionRef = call.nativeSessionRef();
				if (!nativeSessionRef.trim()) unavailable();
				const authorized = await call.authorizeToolAction?.({
					kind: "tool",
					nativeSessionRef,
					executionId: call.execution.executionId,
					runtimeOperationId: call.execution.executionId,
					operationRef,
					attemptRef,
				});
				if (call.authorizeToolAction && !authorized?.revalidate) unavailable();
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
				if (!intentCommitted) void notifyBlocked();
			},
			confirm: async (value) => {
				try {
					await write(value.phase);
				} catch (error) {
					if (blocked) await notifyBlocked();
					throw error;
				}
				if (value.phase === "unknown" && blocked) await notifyBlocked();
			},
			prepare: async (request) => {
				requestIdentity = request;
				await write("intent");
				intentCommitted = true;
			},
			started: async (request) => {
				requestIdentity = request;
				await write("started");
			},
		};
		try {
			return result(
				await call.client.call(
					name,
					args,
					operation,
					AbortSignal.any([extra.signal, AbortSignal.timeout(30_000)]),
				),
			);
		} finally {
			await call.close?.().catch(() => {});
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
		server.listen(options.listenPort ?? 0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await transport.close().catch(() => {});
		await mcp.close().catch(() => {});
		await Promise.all(
			[...openClients].map((entry) => entry.close().catch(() => {})),
		);
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
			await Promise.all(
				[...openClients].map((entry) => entry.close().catch(() => {})),
			);
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
