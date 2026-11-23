import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";
import {
	type DynamicConnectionClientV1,
	DynamicConnectionRefusalV1,
	dynamicConnectionRefusalsV1,
	openDynamicConnectionV1,
	resolveConnectionForBridgeV1,
} from "./dynamic-connection.js";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
	token,
} from "./standard-mcp.fixture.js";
import { createStandardMcpAcpBridge } from "./standard-mcp-acp-bridge.js";
import type { StandardMcpClient } from "./standard-mcp-client.js";

const sdk = vi.hoisted(() => ({
	createSdkMcpServer: vi.fn((options: Record<string, unknown>) => ({
		type: "sdk",
		name: options.name,
		instance: { tools: options.tools },
	})),
	tool: vi.fn(
		(
			name: string,
			description: string,
			inputSchema: unknown,
			handler: (input: unknown, extra: unknown) => Promise<unknown>,
		) => ({ name, description, inputSchema, handler }),
	),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
	while (open.length) await open.pop()?.close();
	await closeStandardMcpFixtures();
	vi.clearAllMocks();
});

const declared: DynamicConnectionClientV1["declared"] = {
	contract: { ref: "fixture-mcp-contract", revision: "r1" },
	tools: [
		{
			name: "write_note",
			description: "Write a note",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
				additionalProperties: false,
			},
		},
	],
};

async function dynamicClient(
	options: {
		refusal?: "authorization_required" | "unavailable" | "other";
		declared?: DynamicConnectionClientV1["declared"];
		/** An installation that belongs to another Agent, user or Connection. */
		owner?: { agentId: string };
	} = {},
) {
	const fixture = await standardMcpFixture();
	const seen: unknown[] = [];
	const client: DynamicConnectionClientV1 = {
		declared: options.declared ?? declared,
		resolveTarget: async (ref) => {
			seen.push(structuredClone(ref));
			if (options.owner && options.owner.agentId !== ref.agentId)
				throw new DynamicConnectionRefusalV1("authorization_required");
			if (options.refusal === "other") throw new Error("host detail");
			if (options.refusal)
				throw new DynamicConnectionRefusalV1(options.refusal);
			return fixture.target;
		},
		resolveInput: async (ref) => ({
			...fixture.input,
			scope: { ...ref },
		}),
		fetch: fixture.fetch,
	};
	return { fixture, client, seen };
}

const calls = (fixture: Awaited<ReturnType<typeof standardMcpFixture>>) =>
	fixture.trace.filter((entry) => entry.method !== undefined);

it.each([
	["authorization_required", "authorization_required"],
	["unavailable", "unavailable"],
	["other", "unavailable"],
] as const)(
	"opens no Connection request when the reader refuses (%s)",
	async (refusal, expected) => {
		const { fixture, client } = await dynamicClient({ refusal });
		const opened = await openDynamicConnectionV1(
			client,
			reference,
			new AbortController().signal,
		);
		expect(opened).toEqual({ refusal: expected });
		expect(calls(fixture)).toHaveLength(0);
	},
);

it("hands the reader only the Execution's own reference and opens the installed client", async () => {
	const { fixture, client, seen } = await dynamicClient();
	const opened = await openDynamicConnectionV1(
		client,
		reference,
		new AbortController().signal,
	);
	if (!("client" in opened)) throw new Error("expected a client");
	open.push(opened.client);
	expect(seen).toEqual([reference]);
	expect(opened.client.contractSource).toEqual(declared.contract);
	expect(calls(fixture).some((entry) => entry.method === "tools/call")).toBe(
		false,
	);
});

it("refuses an Agent whose installation belongs to another Agent without a Connection request", async () => {
	const { fixture, client } = await dynamicClient({
		owner: { agentId: "agent-b" },
	});
	const opened = await openDynamicConnectionV1(
		client,
		reference,
		new AbortController().signal,
	);
	expect(opened).toEqual({ refusal: "authorization_required" });
	expect(calls(fixture)).toHaveLength(0);
});

it.each([
	[
		"another contract",
		{ ...declared, contract: { ref: "other-contract", revision: "r1" } },
	],
	[
		"another tool set",
		{
			...declared,
			tools: [{ ...declared.tools[0], name: "delete_note" }],
		},
	],
] as const)(
	"refuses a Connection whose discovery differs from the declaration (%s)",
	async (_label, other) => {
		const { fixture, client } = await dynamicClient({
			declared: other as unknown as DynamicConnectionClientV1["declared"],
		});
		const opened = await openDynamicConnectionV1(
			client,
			reference,
			new AbortController().signal,
		);
		expect(opened).toEqual({ refusal: "unavailable" });
		expect(fixture.trace.some((entry) => entry.method === "tools/call")).toBe(
			false,
		);
	},
);

it.each([
	["another Agent", { agentId: "agent-b" }],
	["another Conversation", { conversationId: "conversation-b" }],
	["another Execution", { executionId: "execution-b" }],
] as const)(
	"refuses an installation input scoped to %s without any tool call",
	async (_label, scope) => {
		const { fixture, client } = await dynamicClient();
		const foreign: DynamicConnectionClientV1 = {
			...client,
			resolveInput: async (ref) => ({
				...fixture.input,
				scope: { ...ref, ...scope },
			}),
		};
		const opened = await openDynamicConnectionV1(
			foreign,
			reference,
			new AbortController().signal,
		);
		expect(opened).toEqual({ refusal: "unavailable" });
		expect(fixture.trace.some((entry) => entry.method === "tools/call")).toBe(
			false,
		);
	},
);

it("refuses an installation input issued by another Connection service", async () => {
	const { fixture, client } = await dynamicClient();
	const foreign: DynamicConnectionClientV1 = {
		...client,
		resolveInput: async (ref) => ({
			...fixture.input,
			scope: { ...ref },
			// A credential issued for another Connection service must not match
			// the approved target the Host resolved for this Execution.
			issuer: "https://other-connection.example.test",
		}),
	};
	const opened = await openDynamicConnectionV1(
		foreign,
		reference,
		new AbortController().signal,
	);
	expect(opened).toEqual({ refusal: "unavailable" });
	expect(fixture.trace.some((entry) => entry.method === "tools/call")).toBe(
		false,
	);
});

it("rejects static and dynamic Connection input together", async () => {
	const { client } = await dynamicClient();
	await expect(
		resolveConnectionForBridgeV1(
			{
				dynamicConnectionClient: client,
				standardConnectionClient: {} as never,
			},
			reference,
			new AbortController().signal,
		),
	).rejects.toThrow("CONNECTION_STANDARD_CLIENT_UNAVAILABLE");
});

async function peerFor(bridge: {
	server: { url: string; headers: unknown[] };
}) {
	const peer = new Client({ name: "dynamic-test", version: "1" });
	await peer.connect(
		new StreamableHTTPClientTransport(new URL(bridge.server.url), {
			requestInit: {
				headers: Object.fromEntries(
					(bridge.server.headers as { name: string; value: string }[]).map(
						(header) => [header.name, header.value],
					),
				),
			},
		}),
	);
	open.push({ close: () => peer.close() });
	return peer;
}

it("serves the declared tools through the loopback bridge and refuses every call when no installation backs it", async () => {
	const { fixture, client } = await dynamicClient({
		refusal: "authorization_required",
	});
	const resolved = await resolveConnectionForBridgeV1(
		{ dynamicConnectionClient: client },
		reference,
		new AbortController().signal,
	);
	if ("client" in resolved) throw new Error("expected a refusal");
	const bridge = await createStandardMcpAcpBridge({
		...resolved,
		execution: reference,
		nativeSessionRef: () => "native-dynamic",
		recordOperationFact: async () => {
			throw new Error("a refusal records no Connection operation");
		},
	});
	open.push(bridge);
	const peer = await peerFor(bridge);
	const listed = await peer.listTools();
	expect(listed.tools.map((tool) => tool.name)).toHaveLength(1);
	const name = listed.tools[0]?.name as string;
	const result = await peer.callTool({ name, arguments: { text: "hi" } });
	expect(result).toMatchObject({
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify(
					dynamicConnectionRefusalsV1.authorization_required,
				),
			},
		],
	});
	// Unknown tools stay refused, and nothing reached Connection.
	await expect(
		peer.callTool({ name: "delete_note", arguments: {} }),
	).rejects.toThrow();
	expect(calls(fixture)).toHaveLength(0);
	expect(JSON.stringify([listed, result])).not.toContain(token);
});

it("routes a call through the installed client once the Owner's installation exists", async () => {
	const { fixture, client } = await dynamicClient();
	const resolved = await resolveConnectionForBridgeV1(
		{ dynamicConnectionClient: client },
		reference,
		new AbortController().signal,
	);
	if (!("client" in resolved)) throw new Error("expected a client");
	const bridge = await createStandardMcpAcpBridge({
		...resolved,
		execution: reference,
		nativeSessionRef: () => "native-dynamic",
	});
	open.push(bridge);
	const peer = await peerFor(bridge);
	const name = (await peer.listTools()).tools[0]?.name as string;
	const result = await peer.callTool({ name, arguments: { text: "hi" } });
	expect(result).toMatchObject({ isError: false });
	expect(
		fixture.trace.filter((entry) => entry.method === "tools/call"),
	).toHaveLength(1);
});

it("rejects a bridge given a client together with a declaration, or a declaration without a refusal", async () => {
	const { client } = await dynamicClient();
	const resolved = await resolveConnectionForBridgeV1(
		{ dynamicConnectionClient: client },
		reference,
		new AbortController().signal,
	);
	if (!("client" in resolved)) throw new Error("expected a client");
	open.push(resolved.client);
	await expect(
		createStandardMcpAcpBridge({
			client: resolved.client as StandardMcpClient,
			declared,
			refusal: "unavailable",
			execution: reference,
			nativeSessionRef: () => "n",
		}),
	).rejects.toThrow();
	await expect(
		createStandardMcpAcpBridge({
			declared,
			execution: reference,
			nativeSessionRef: () => "n",
		}),
	).rejects.toThrow();
});

it("answers the fixed refusal from the Claude SDK server and records the refused call", async () => {
	const { createClaudeConnectionRefusalMcpServer } = await import(
		"./claude-standard-mcp.js"
	);
	const onRefused = vi.fn(async () => {});
	const server = createClaudeConnectionRefusalMcpServer({
		declared,
		refusal: "unavailable",
		onRefused,
	});
	expect(server).toMatchObject({ type: "sdk", name: "agent-infra-connection" });
	const tool = sdk.tool.mock.results[0]?.value as {
		name: string;
		handler: (input: unknown, extra: unknown) => Promise<unknown>;
	};
	expect(tool.name).toMatch(/^mcp_[a-f0-9]{32}$/);
	expect(await tool.handler({ text: "hi" }, {})).toEqual({
		content: [
			{
				type: "text",
				text: JSON.stringify(dynamicConnectionRefusalsV1.unavailable),
			},
		],
		isError: true,
	});
	expect(onRefused).toHaveBeenCalledWith(tool.name);
});
