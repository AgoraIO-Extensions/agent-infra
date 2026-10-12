import {
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import { type ZodTypeAny, z } from "zod";
import { RuntimeHostError } from "./errors.js";
import type {
	StandardMcpClient,
	StandardMcpOperation,
	StandardMcpResult,
} from "./standard-mcp-client.js";

type JsonSchema = Record<string, unknown>;

function unavailable(): never {
	throw new RuntimeHostError(
		"CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
		"Standard Connection client is unavailable",
		503,
		false,
	);
}

function object(value: unknown): value is JsonSchema {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schema(value: unknown): JsonSchema {
	if (!object(value)) unavailable();
	return value;
}

function jsonSchemaType(value: unknown): string {
	const type = schema(value).type;
	if (typeof type !== "string") unavailable();
	return type;
}

function toZod(value: unknown): ZodTypeAny {
	const input = schema(value);
	if (Array.isArray(input.anyOf)) {
		const nullable = input.anyOf.find((entry) => entry === null);
		const alternatives = input.anyOf.filter((entry) => entry !== null);
		if (nullable !== undefined && alternatives.length === 1)
			return toZod(alternatives[0]).nullable();
		unavailable();
	}
	if (Array.isArray(input.enum)) {
		if (
			input.enum.length < 1 ||
			input.enum.some((entry) => typeof entry !== "string")
		)
			unavailable();
		return z.enum(input.enum as [string, ...string[]]);
	}
	const type = jsonSchemaType(input);
	if (type === "string") {
		let result = z.string();
		if (typeof input.minLength === "number")
			result = result.min(input.minLength);
		if (typeof input.maxLength === "number")
			result = result.max(input.maxLength);
		if (typeof input.pattern === "string") {
			try {
				result = result.regex(new RegExp(input.pattern));
			} catch {
				unavailable();
			}
		}
		return result;
	}
	if (type === "number" || type === "integer") {
		let result = type === "integer" ? z.number().int() : z.number();
		if (typeof input.minimum === "number") result = result.min(input.minimum);
		if (typeof input.maximum === "number") result = result.max(input.maximum);
		return result;
	}
	if (type === "boolean") return z.boolean();
	if (type === "null") return z.null();
	if (type === "array") {
		if (input.items === undefined) unavailable();
		let result = z.array(toZod(input.items));
		if (typeof input.minItems === "number") result = result.min(input.minItems);
		if (typeof input.maxItems === "number") result = result.max(input.maxItems);
		return result;
	}
	if (type === "object") {
		const properties = input.properties;
		if (!object(properties)) unavailable();
		const required = new Set(
			Array.isArray(input.required)
				? input.required.filter(
						(entry): entry is string => typeof entry === "string",
					)
				: [],
		);
		const shape: Record<string, ZodTypeAny> = {};
		for (const [name, property] of Object.entries(properties)) {
			let parsed = toZod(property);
			if (!required.has(name)) parsed = parsed.optional();
			shape[name] = parsed;
		}
		const result = z.object(shape);
		return input.additionalProperties === false
			? result.strict()
			: result.passthrough();
	}
	unavailable();
}

function resultToCallToolResult(result: StandardMcpResult) {
	return {
		content: result.contentItems.map((item) => ({
			type: "text" as const,
			text: item.text,
		})),
		isError: result.phase !== "completed" || !result.success,
	};
}

export function createClaudeStandardMcpServer(options: {
	client: StandardMcpClient;
	operation: (toolName: string) => StandardMcpOperation;
}): McpSdkServerConfigWithInstance {
	const namespace = options.client.toolDefinitions.find(
		(entry) => entry.name === "connection",
	);
	if (!namespace) unavailable();
	const tools = namespace.tools.map((definition) => {
		const parsed = toZod(definition.inputSchema);
		if (!(parsed instanceof z.ZodObject)) unavailable();
		return sdkTool(
			definition.name,
			definition.description,
			parsed.shape,
			async (arguments_) => {
				const result = await options.client.call(
					definition.name,
					arguments_ as Record<string, unknown>,
					options.operation(definition.name),
					AbortSignal.timeout(30_000),
				);
				return resultToCallToolResult(result);
			},
			{ alwaysLoad: true },
		);
	});
	return createSdkMcpServer({
		name: "agent-infra-connection",
		version: "1",
		tools,
		alwaysLoad: true,
	});
}
