import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
	token,
} from "./standard-mcp.fixture.js";
import { createStandardMcpAcpBridge } from "./standard-mcp-acp-bridge.js";
import { StandardMcpClient } from "./standard-mcp-client.js";

const bridges: { close(): Promise<void> }[] = [];

afterEach(async () => {
	while (bridges.length) await bridges.pop()?.close();
	await closeStandardMcpFixtures();
});

it("keeps Connection credentials in Host while serving an ACP MCP bridge", async () => {
	const fixture = await standardMcpFixture();
	const facts: string[] = [];
	const client = await StandardMcpClient.open(
		{
			target: fixture.target,
			resolveInput: async () => fixture.input,
			fetch: fixture.fetch,
		},
		reference,
		new AbortController().signal,
	);
	const bridge = await createStandardMcpAcpBridge({
		client,
		execution: reference,
		recordOperationFact: async (fact) => {
			facts.push(fact.phase);
		},
	});
	bridges.push(bridge);
	const peer = new Client({ name: "bridge-test", version: "1" });
	const transport = new StreamableHTTPClientTransport(
		new URL(bridge.server.url),
		{
			requestInit: {
				headers: Object.fromEntries(
					bridge.server.headers.map((header) => [header.name, header.value]),
				),
			},
		},
	);
	await peer.connect(transport);
	const listed = await peer.listTools();
	const name = listed.tools[0]?.name;
	if (!name) throw new Error("bridge tool missing");
	expect(JSON.stringify(listed)).not.toContain(token);
	const result = await peer.callTool({ name, arguments: { text: "bridge" } });
	expect(result).toMatchObject({
		isError: false,
		content: [{ type: "text", text: expect.stringContaining("written") }],
	});
	expect(facts).toEqual(["intent", "started", "completed"]);
	expect(
		fixture.trace.filter((entry) => entry.method === "tools/call"),
	).toHaveLength(1);
	expect(JSON.stringify(result)).not.toContain(token);
	await peer.close();
});

it("rejects requests without the local bearer", async () => {
	const fixture = await standardMcpFixture();
	const client = await StandardMcpClient.open(
		{
			target: fixture.target,
			resolveInput: async () => fixture.input,
			fetch: fixture.fetch,
		},
		reference,
		new AbortController().signal,
	);
	const bridge = await createStandardMcpAcpBridge({
		client,
		execution: reference,
	});
	bridges.push(bridge);
	const response = await fetch(bridge.server.url, {
		method: "POST",
		body: "{}",
	});
	expect(response.status).toBe(404);
	const peer = new Client({ name: "bridge-test", version: "1" });
	const transport = new StreamableHTTPClientTransport(
		new URL(bridge.server.url),
		{
			requestInit: {
				headers: Object.fromEntries(
					bridge.server.headers.map((header) => [header.name, header.value]),
				),
			},
		},
	);
	await peer.connect(transport);
	await peer.close();
});

it("blocks the bridge when a Connection WRITE result is unknown", async () => {
	const fixture = await standardMcpFixture();
	fixture.setBehavior("unknown");
	const client = await StandardMcpClient.open(
		{
			target: fixture.target,
			resolveInput: async () => fixture.input,
			fetch: fixture.fetch,
		},
		reference,
		new AbortController().signal,
	);
	const facts: string[] = [];
	let blocked = 0;
	const bridge = await createStandardMcpAcpBridge({
		client,
		execution: reference,
		recordOperationFact: async (fact) => {
			facts.push(fact.phase);
		},
		onBlocked: () => {
			blocked++;
		},
	});
	bridges.push(bridge);
	const peer = new Client({ name: "bridge-test", version: "1" });
	const transport = new StreamableHTTPClientTransport(
		new URL(bridge.server.url),
		{
			requestInit: {
				headers: Object.fromEntries(
					bridge.server.headers.map((header) => [header.name, header.value]),
				),
			},
		},
	);
	await peer.connect(transport);
	const name = (await peer.listTools()).tools[0]?.name;
	if (!name) throw new Error("bridge tool missing");
	const result = await peer.callTool({ name, arguments: { text: "unknown" } });
	expect(result).toMatchObject({ isError: true });
	expect(facts).toEqual(["intent", "started", "unknown"]);
	expect(blocked).toBe(1);
	await peer.close();
});
