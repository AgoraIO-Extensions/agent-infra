import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
	token,
} from "./standard-mcp.fixture.js";
import { createStandardMcpAcpBridge } from "./standard-mcp-acp-bridge.js";
import { StandardMcpClient, standardMcpDigest } from "./standard-mcp-client.js";

const bridges: { close(): Promise<void> }[] = [];

afterEach(async () => {
	while (bridges.length) await bridges.pop()?.close();
	await closeStandardMcpFixtures();
	vi.useRealTimers();
});

it("keeps Connection credentials in Host while serving an ACP MCP bridge", async () => {
	const fixture = await standardMcpFixture();
	const facts: Extract<RuntimeOperationFactV2, { kind: "tool" }>[] = [];
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
		nativeSessionRef: () => "native-bridge-test",
		recordOperationFact: async (fact) => {
			if (fact.kind === "tool") facts.push(fact);
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
	expect(facts.map((fact) => fact.phase)).toEqual([
		"intent",
		"started",
		"completed",
	]);
	expect(
		facts.every(
			(fact) =>
				(typeof fact.rpcRequestId === "string" ||
					typeof fact.rpcRequestId === "number") &&
				/^[a-f0-9]{64}$/.test(fact.requestDigest ?? ""),
		),
	).toBe(true);
	expect(facts.map((fact) => fact.connection)).toEqual([
		{
			serviceRef: "connection-fixture",
			verification: "unverified",
			consumerId: "platform",
			instanceRef: "instance-a",
			credentialRevision: "r1",
			reason: "record_unavailable",
		},
		{
			serviceRef: "connection-fixture",
			verification: "unverified",
			consumerId: "platform",
			instanceRef: "instance-a",
			credentialRevision: "r1",
			reason: "record_unavailable",
		},
		{
			serviceRef: "connection-fixture",
			verification: "unverified",
			consumerId: "platform",
			instanceRef: "instance-a",
			credentialRevision: "r1",
			reason: "record_unavailable",
		},
	]);
	expect(
		fixture.trace.filter((entry) => entry.method === "tools/call"),
	).toHaveLength(1);
	expect(JSON.stringify(result)).not.toContain(token);
	await peer.close();
});

it("rejects replayed JSON-RPC ids while keeping string and numeric ids distinct", async () => {
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
		nativeSessionRef: () => "native-bridge-test",
	});
	bridges.push(bridge);
	const authorization = bridge.server.headers[0].value;
	const post = async (body: unknown, sessionId?: string) => {
		const response = await fetch(bridge.server.url, {
			method: "POST",
			headers: {
				Authorization: authorization,
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"MCP-Protocol-Version": "2025-11-25",
				...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
			},
			body: JSON.stringify(body),
		});
		const text = await response.text();
		return {
			response,
			text,
			sessionId: response.headers.get("MCP-Session-Id") ?? sessionId,
		};
	};
	const message = (text: string) => {
		const data = text.match(/^data: (.+)$/m)?.[1];
		if (!data) throw new Error("bridge response missing JSON-RPC message");
		return JSON.parse(data) as Record<string, unknown>;
	};
	const toolName = `mcp_${standardMcpDigest("write_note").slice(0, 32)}`;
	const initialized = await post({
		jsonrpc: "2.0",
		id: "initialize",
		method: "initialize",
		params: {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "bridge-replay-test", version: "1" },
		},
	});
	if (!initialized.sessionId) throw new Error("bridge session missing");
	const sessionId = initialized.sessionId;
	await post(
		{ jsonrpc: "2.0", method: "notifications/initialized", params: {} },
		sessionId,
	);
	await post(
		{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
		sessionId,
	);
	const first = await post(
		{
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: toolName, arguments: { text: "first" } },
		},
		sessionId,
	);
	expect(first.response.status).toBe(200);
	expect(message(first.text)).toMatchObject({
		id: 7,
		result: { isError: false },
	});
	const duplicate = await post(
		{
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: toolName, arguments: { text: "changed" } },
		},
		sessionId,
	);
	expect(duplicate.response.status).toBe(200);
	expect(message(duplicate.text)).toMatchObject({
		id: 7,
		error: { code: -32603 },
	});
	const typed = await post(
		{
			jsonrpc: "2.0",
			id: "7",
			method: "tools/call",
			params: { name: toolName, arguments: { text: "typed" } },
		},
		sessionId,
	);
	expect(typed.response.status).toBe(200);
	expect(message(typed.text)).toMatchObject({
		id: "7",
		result: { isError: false },
	});
	expect(
		fixture.trace.filter((entry) => entry.method === "tools/call"),
	).toHaveLength(2);
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
		nativeSessionRef: () => "native-bridge-test",
	});
	bridges.push(bridge);
	const response = await fetch(bridge.server.url, {
		method: "POST",
		body: "{}",
	});
	expect(response.status).toBe(404);
	const methodResponse = await fetch(bridge.server.url, {
		method: "GET",
		headers: { Authorization: bridge.server.headers[0].value },
	});
	expect(methodResponse.status).toBe(404);
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

it("closes the local bearer at the approved credential expiry", async () => {
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
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	vi.setSystemTime(client.expiresAt - 10);
	const bridge = await createStandardMcpAcpBridge({
		client,
		execution: reference,
		nativeSessionRef: () => "native-bridge-test",
	});
	bridges.push(bridge);
	vi.setSystemTime(client.expiresAt + 1);
	await vi.runOnlyPendingTimersAsync();
	await expect(
		fetch(bridge.server.url, {
			method: "POST",
			headers: {
				Authorization: bridge.server.headers[0].value,
				"Content-Type": "application/json",
			},
			body: "{}",
		}),
	).rejects.toThrow();
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
	const facts: Extract<RuntimeOperationFactV2, { kind: "tool" }>[] = [];
	const order: string[] = [];
	let blocked = 0;
	const bridge = await createStandardMcpAcpBridge({
		client,
		execution: reference,
		nativeSessionRef: () => "native-bridge-test",
		recordOperationFact: async (fact) => {
			if (fact.kind === "tool") {
				facts.push(fact);
				order.push(`fact:${fact.phase}`);
			}
		},
		onBlocked: () => {
			blocked++;
			order.push("blocked");
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
	expect(facts.map((fact) => fact.phase)).toEqual([
		"intent",
		"started",
		"unknown",
	]);
	expect(
		facts.every((fact) => fact.connection?.verification === "unverified"),
	).toBe(true);
	expect(blocked).toBe(1);
	expect(order.at(-1)).toBe("blocked");
	const before = fixture.trace.filter(
		(entry) => entry.method === "tools/call",
	).length;
	await expect(
		peer.callTool({ name, arguments: { text: "unknown-again" } }),
	).rejects.toThrow();
	expect(
		fixture.trace.filter((entry) => entry.method === "tools/call").length,
	).toBe(before);
	await peer.close();
});

it("blocks native cancellation when intent persistence fails before dispatch", async () => {
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
	let blocked = 0;
	let firstIntent = true;
	const bridge = await createStandardMcpAcpBridge({
		client,
		execution: reference,
		nativeSessionRef: () => "native-bridge-test",
		recordOperationFact: async (fact) => {
			if (fact.phase === "intent" && firstIntent) {
				firstIntent = false;
				throw new Error("controlled intent persistence failure");
			}
		},
		onBlocked: () => {
			blocked++;
		},
	});
	bridges.push(bridge);
	const peer = new Client({ name: "bridge-intent-failure-test", version: "1" });
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
	await expect(
		peer.callTool({ name, arguments: { text: "intent-failure" } }),
	).rejects.toThrow();
	expect(blocked).toBe(1);
	expect(
		fixture.trace.filter((entry) => entry.method === "tools/call"),
	).toHaveLength(0);
	await peer.close();
});
