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
	expect(
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
								description: "supported const",
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
	).toMatchObject({ type: "sdk" });
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

it("converts every input schema of the Connection tool list for both Claude servers", async () => {
	const { createClaudeConnectionRefusalMcpServer } = await import(
		"./claude-standard-mcp.js"
	);
	const { connectionToolInputSchemas } = await import(
		"./claude-connection-tools.fixture.js"
	);
	expect(connectionToolInputSchemas).toHaveLength(10);
	const tools = connectionToolInputSchemas.map((tool) => ({
		name: tool.name,
		description: tool.name,
		inputSchema: tool.inputSchema,
	}));
	expect(
		createClaudeConnectionRefusalMcpServer({
			declared: { contract: { ref: "connection", revision: "r1" }, tools },
			refusal: "authorization_required",
		}),
	).toMatchObject({ type: "sdk" });
	const installed = createClaudeStandardMcpServer({
		client: {
			toolDefinitions: [
				{
					name: "connection",
					tools: tools.map((tool, index) => ({
						name: `mcp_${index}`,
						description: tool.description,
						inputSchema: tool.inputSchema,
					})),
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
	});
	expect(installed).toMatchObject({ type: "sdk" });
	expect(sdk.tool).toHaveBeenCalledTimes(tools.length * 2);
});

it("converts const and a property-less object by JSON Schema semantics and keeps other shapes closed", async () => {
	const { toZod } = await import("./claude-standard-mcp.js");
	const literal = toZod({ type: "string", const: "APPROVE" });
	expect(literal.safeParse("APPROVE").success).toBe(true);
	expect(literal.safeParse("REJECT").success).toBe(false);
	expect(toZod({ const: 3 }).safeParse(3).success).toBe(true);
	expect(toZod({ const: null }).safeParse(null).success).toBe(true);
	// A `const` whose type contradicts it, or a structured `const`, fails closed.
	expect(() => toZod({ type: "number", const: "x" })).toThrow(
		"Standard Connection client is unavailable",
	);
	expect(() => toZod({ const: { a: 1 } })).toThrow(
		"Standard Connection client is unavailable",
	);
	expect(() => toZod({ const: "x", minLength: 1 })).toThrow(
		"Standard Connection client is unavailable",
	);

	const open = toZod({ type: "object", additionalProperties: true });
	expect(open.safeParse({ any: [1] }).success).toBe(true);
	expect(open.safeParse("text").success).toBe(false);
	expect(toZod({ type: "object" }).safeParse({ any: 1 }).success).toBe(true);
	const closed = toZod({ type: "object", additionalProperties: false });
	expect(closed.safeParse({}).success).toBe(true);
	expect(closed.safeParse({ any: 1 }).success).toBe(false);
	// `required` cannot name a property that the schema does not declare.
	expect(() => toZod({ type: "object", required: ["a"] })).toThrow(
		"Standard Connection client is unavailable",
	);
	expect(() => toZod({ type: "object", properties: [] })).toThrow(
		"Standard Connection client is unavailable",
	);
});
