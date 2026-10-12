import { afterEach, expect, it, vi } from "vitest";
import { createClaudeStandardMcpServer } from "./claude-standard-mcp.js";

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

afterEach(() => vi.clearAllMocks());

it("maps approved Standard MCP tools into an in-process SDK server", async () => {
	const call = vi.fn(async () => ({
		phase: "completed" as const,
		success: true,
		contentItems: [{ type: "inputText" as const, text: "done" }],
	}));
	const client = {
		toolDefinitions: [
			{
				name: "connection",
				tools: [
					{
						name: "mcp_fixture",
						description: "Fixture Connection tool",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
							additionalProperties: false,
						},
					},
				],
			},
		],
		call,
	} as unknown as Parameters<typeof createClaudeStandardMcpServer>[0]["client"];
	const operation = {
		assertCurrent: async () => () => {},
		block: vi.fn(),
		confirm: vi.fn(async () => {}),
		prepare: vi.fn(async () => {}),
		started: vi.fn(async () => {}),
	};
	const server = createClaudeStandardMcpServer({
		client,
		operation: () => operation,
	});
	const sdkTool = sdk.tool.mock.results[0]?.value as {
		inputSchema: { _zod?: unknown };
		handler: (input: unknown, extra: unknown) => Promise<unknown>;
	};
	expect(server).toMatchObject({ type: "sdk", name: "agent-infra-connection" });
	expect(sdkTool).toBeDefined();
	expect(sdkTool.inputSchema._zod).toBeDefined();
	expect(await sdkTool.handler({ text: "hello" }, {})).toEqual({
		content: [{ type: "text", text: "done" }],
		isError: false,
	});
	expect(call).toHaveBeenCalledWith(
		"mcp_fixture",
		{ text: "hello" },
		operation,
		expect.any(AbortSignal),
	);
});

it("rejects unsupported JSON Schema instead of widening the model tool", () => {
	const client = {
		toolDefinitions: [
			{
				name: "connection",
				tools: [
					{
						name: "mcp_unsupported",
						description: "unsupported",
						inputSchema: {
							type: "object",
							properties: { value: { $ref: "#/$defs/value" } },
						},
					},
				],
			},
		],
	} as unknown as Parameters<typeof createClaudeStandardMcpServer>[0]["client"];
	expect(() =>
		createClaudeStandardMcpServer({
			client,
			operation: () => ({
				assertCurrent: async () => () => {},
				block: () => {},
				confirm: async () => {},
				prepare: async () => {},
				started: async () => {},
			}),
		}),
	).toThrow("Standard Connection client is unavailable");
});

it("preserves nullable parameters and rejects unsupported constraints", () => {
	const client = {
		toolDefinitions: [
			{
				name: "connection",
				tools: [
					{
						name: "mcp_nullable",
						description: "nullable",
						inputSchema: {
							type: "object",
							properties: {
								value: {
									anyOf: [{ type: "string" }, { type: "null" }],
								},
							},
						},
					},
				],
			},
		],
	} as unknown as Parameters<typeof createClaudeStandardMcpServer>[0]["client"];
	const nullable = createClaudeStandardMcpServer({
		client,
		operation: () => ({
			assertCurrent: async () => () => {},
			block: () => {},
			confirm: async () => {},
			prepare: async () => {},
			started: async () => {},
		}),
	});
	expect(nullable).toMatchObject({ type: "sdk" });
	expect(() =>
		createClaudeStandardMcpServer({
			client: {
				...client,
				toolDefinitions: [
					{
						type: "namespace",
						name: "connection",
						description: "Connection tools",
						tools: [
							{
								type: "function",
								name: "mcp_const",
								description: "unsupported",
								inputSchema: {
									type: "object",
									properties: { value: { type: "string", const: "x" } },
								},
							},
						],
					},
				],
			} as unknown as Parameters<
				typeof createClaudeStandardMcpServer
			>[0]["client"],
			operation: () => ({
				assertCurrent: async () => () => {},
				block: () => {},
				confirm: async () => {},
				prepare: async () => {},
				started: async () => {},
			}),
		}),
	).toThrow("Standard Connection client is unavailable");
	expect(() =>
		createClaudeStandardMcpServer({
			client: {
				...client,
				toolDefinitions: [
					{
						name: "connection",
						tools: [
							{
								name: "mcp_enum_constraints",
								description: "unsupported enum combination",
								inputSchema: {
									type: "object",
									properties: {
										value: {
											type: "string",
											enum: ["a", "abcd"],
											minLength: 3,
										},
									},
								},
							},
						],
					},
				],
			} as unknown as Parameters<
				typeof createClaudeStandardMcpServer
			>[0]["client"],
			operation: () => ({
				assertCurrent: async () => () => {},
				block: () => {},
				confirm: async () => {},
				prepare: async () => {},
				started: async () => {},
			}),
		}),
	).toThrow("Standard Connection client is unavailable");
	expect(() =>
		createClaudeStandardMcpServer({
			client: {
				...client,
				toolDefinitions: [
					{
						name: "connection",
						tools: [
							{
								name: "mcp_nullable_constraints",
								description: "unsupported nullable combination",
								inputSchema: {
									type: "object",
									properties: {
										value: {
											type: "string",
											anyOf: [{ type: "string" }, { type: "null" }],
										},
									},
								},
							},
						],
					},
				],
			} as unknown as Parameters<
				typeof createClaudeStandardMcpServer
			>[0]["client"],
			operation: () => ({
				assertCurrent: async () => () => {},
				block: () => {},
				confirm: async () => {},
				prepare: async () => {},
				started: async () => {},
			}),
		}),
	).toThrow("Standard Connection client is unavailable");
});
