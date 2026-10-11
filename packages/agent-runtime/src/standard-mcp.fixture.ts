import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import {
	connectionConsumerProfileFingerprintV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import type { StandardMcpInput } from "./standard-mcp-client.js";

const closes: (() => Promise<void>)[] = [];
export async function closeStandardMcpFixtures() {
	for (const close of closes.splice(0).reverse()) await close();
}
export const token = "synthetic-fixture-credential-a";
export const reference = {
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: "execution-a",
	sessionGeneration: 1,
};
export const terminalSchema = {
	type: "object",
	properties: {
		structuredContent: {
			type: "object",
			properties: { status: { const: "COMPLETED" } },
			required: ["status"],
		},
	},
	required: ["structuredContent"],
};

export async function standardMcpFixture(
	inputSchema?: Record<string, unknown>,
) {
	const material = await runtimeTlsFixture();
	closes.push(material.cleanup);
	const trace: { method: string; id?: unknown; arguments?: unknown }[] = [];
	let behavior:
		| "completed"
		| "unknown"
		| "redirect"
		| "lost"
		| "leak"
		| "key-leak"
		| "tool-key" = "completed";
	const server = createServer(
		{ cert: material.cert, key: material.key },
		async (req, res) => {
			if (req.headers.authorization !== `Bearer ${token}`) {
				res.writeHead(401);
				res.end();
				return;
			}
			if (req.method === "GET") {
				res.writeHead(405);
				res.end();
				return;
			}
			if (behavior === "redirect") {
				res.writeHead(302, { location: "https://other.example.test/mcp" });
				res.end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const message = JSON.parse(Buffer.concat(chunks).toString());
			trace.push({
				method: message.method,
				id: message.id,
				arguments: message.params?.arguments,
			});
			if (message.method === "notifications/initialized") {
				res.writeHead(202);
				res.end();
				return;
			}
			let result: unknown;
			if (message.method === "initialize")
				result = {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "fixture", version: "1" },
				};
			else if (message.method === "tools/list")
				result = {
					tools: [
						{
							name: "write_note",
							description: "Write a note",
							inputSchema: structuredClone(
								inputSchema ?? {
									type: "object",
									properties: { text: { type: "string" } },
									required: ["text"],
									additionalProperties: false,
								},
							),
						},
					],
				};
			else if (message.method === "tools/call") {
				if (behavior === "lost") {
					req.socket.destroy();
					return;
				}
				result = {
					isError: false,
					content: [
						{ type: "text", text: behavior === "leak" ? token : "written" },
					],
					structuredContent: {
						status: behavior === "unknown" ? "UNCERTAIN" : "COMPLETED",
					},
				};
			} else {
				res.writeHead(400);
				res.end();
				return;
			}
			if (behavior === "tool-key" && message.method === "tools/list") {
				const tools = (
					result as {
						tools: { inputSchema: { properties: Record<string, unknown> } }[];
					}
				).tools;
				if (tools[0])
					tools[0].inputSchema.properties[token] = { type: "string" };
			}
			if (behavior === "key-leak" && message.method === "tools/call")
				(
					result as { structuredContent: Record<string, unknown> }
				).structuredContent[token] = "key-only";
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		},
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closes.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const origin = `https://localhost:${(server.address() as AddressInfo).port}`;
	const profile = {
		schemaVersion: 1 as const,
		publicOrigin: origin,
		mcpPath: "/mcp",
		consumerId: "platform",
		audience: "fixture-resource",
		egressProfile: { ref: "fixture-egress", revision: "r1" },
	};
	const approval = {
		schemaVersion: 1 as const,
		configFingerprint: connectionConsumerProfileFingerprintV1(profile),
		source: { ref: "fixture-deployment", revision: "r1" },
		egressEnforced: true as const,
	};
	const approved = resolveApprovedConnectionConsumerProfileV1(
		profile,
		approval,
	);
	if (approved.status !== "available") throw new Error("Invalid fixture");
	const target = { ...approved, url: `${origin}/mcp` };
	const input: StandardMcpInput = {
		schemaVersion: 1,
		principal: { kind: "user", id: "user-a" },
		scope: { ...reference },
		serviceRef: "connection-fixture",
		consumerId: "platform",
		instanceRef: "instance-a",
		issuer: origin,
		resource: target.url,
		audience: "fixture-resource",
		configFingerprint: approved.configFingerprint,
		source: approved.source,
		credentialRef: "credential-a",
		credentialRevision: "r1",
		expiresAt: Date.now() + 120_000,
		token,
		contract: {
			ref: "fixture-mcp-contract",
			revision: "r1",
			serverInfo: { name: "fixture", version: "1" },
			tools: [{ name: "write_note", succeededResultSchema: terminalSchema }],
		},
	};
	// The real SDK performs real TLS requests. This fixture-specific CA is not
	// a production TLS bypass or an egress/protection acceptance statement.
	const fetch: FetchLike = async (url, init) =>
		new Promise<Response>((resolve, reject) => {
			const req = request(
				new URL(url),
				{
					ca: material.ca,
					family: 4,
					method: init?.method,
					headers: Object.fromEntries(new Headers(init?.headers)),
					signal: init?.signal ?? undefined,
				},
				(res) => {
					const buffers: Buffer[] = [];
					res.on("data", (chunk) => buffers.push(Buffer.from(chunk)));
					res.on("end", () =>
						resolve(
							new Response(Buffer.concat(buffers), {
								status: res.statusCode,
								headers: Object.fromEntries(
									Object.entries(res.headers).map(([key, value]) => [
										key,
										Array.isArray(value) ? value.join(",") : (value ?? ""),
									]),
								),
							}),
						),
					);
				},
			);
			req.once("error", reject);
			req.end(typeof init?.body === "string" ? init.body : undefined);
		});
	return {
		trace,
		target,
		input,
		fetch,
		setBehavior: (next: typeof behavior) => {
			behavior = next;
		},
	};
}
