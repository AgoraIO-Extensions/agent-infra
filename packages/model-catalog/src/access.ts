import { createParser } from "eventsource-parser";
import { z } from "zod";
import {
	ModelConfigurationErrorV1,
	type ModelEndpointV1,
	ModelEndpointV1Schema,
	modelIdentifier,
	modelOperationV1,
	reasoningLevel,
} from "./catalog.js";

export interface ModelAccessInputV1 {
	readonly endpoint: ModelEndpointV1;
	readonly modelId: string;
	readonly reasoningLevels: readonly string[];
	readonly credential: Uint8Array;
}
export interface ModelAccessValidatorV1 {
	validate(
		input: ModelAccessInputV1,
		options: { readonly signal: AbortSignal },
	): Promise<void>;
}

function validatePolicy(input: ModelAccessInputV1): string {
	try {
		const endpoint = ModelEndpointV1Schema.parse(input.endpoint);
		modelIdentifier.parse(input.modelId);
		const credential = new TextDecoder("utf-8", { fatal: true }).decode(
			input.credential,
		);
		if (
			!endpoint.available ||
			!/^[\x21-\x7e]{16,8192}$/.test(credential) ||
			(endpoint.allowedModels !== null &&
				!endpoint.allowedModels.includes(input.modelId)) ||
			!input.reasoningLevels.length ||
			input.reasoningLevels.length > 32 ||
			new Set(input.reasoningLevels).size !== input.reasoningLevels.length ||
			input.reasoningLevels.some(
				(level) =>
					!reasoningLevel.safeParse(level).success ||
					!endpoint.capabilities.reasoningLevels.includes(level),
			)
		)
			throw new ModelConfigurationErrorV1();
		return credential;
	} catch {
		throw new ModelConfigurationErrorV1();
	}
}

const completedSchema = z.object({
	type: z.literal("response.completed"),
	response: z.object({
		status: z.literal("completed"),
		model: z.string(),
		reasoning: z.object({ effort: z.string() }),
		output: z.array(
			z.object({
				type: z.string(),
				name: z.string().optional(),
				arguments: z.string().optional(),
				status: z.string().optional(),
			}),
		),
	}),
});

/** A bounded synthetic Responses request; never contains an Owner/User conversation or executes a tool. */
export function createResponsesModelAccessValidatorV1(
	options: { readonly fetch?: typeof fetch } = {},
): ModelAccessValidatorV1 {
	const fetcher = options.fetch ?? globalThis.fetch;
	return {
		async validate(input, { signal }) {
			const credential = validatePolicy(input);
			await modelOperationV1(signal, async () => {
				for (const level of input.reasoningLevels) {
					const response = await fetcher(
						`${input.endpoint.baseUrl.replace(/\/$/, "")}/responses`,
						{
							method: "POST",
							redirect: "error",
							signal,
							headers: {
								Authorization: `Bearer ${credential}`,
								"Content-Type": "application/json",
								Accept: "text/event-stream",
							},
							body: JSON.stringify({
								model: input.modelId,
								reasoning: { effort: level },
								input: "Call agent_infra_conformance with no arguments.",
								store: false,
								stream: true,
								max_output_tokens: 1024,
								tools: [
									{
										type: "function",
										name: "agent_infra_conformance",
										description: "Configuration conformance; no side effects.",
										parameters: {
											type: "object",
											properties: {},
											required: [],
											additionalProperties: false,
										},
										strict: true,
									},
								],
								tool_choice: {
									type: "function",
									name: "agent_infra_conformance",
								},
								parallel_tool_calls: false,
							}),
						},
					);
					if (
						!response.ok ||
						!/^text\/event-stream(?:;|$)/i.test(
							response.headers.get("content-type") ?? "",
						) ||
						!response.body
					) {
						void response.body?.cancel().catch(() => {});
						throw new ModelConfigurationErrorV1(
							response.status === 429 || response.status >= 500,
						);
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder("utf-8", { fatal: true });
					let ending = "";
					let bytes = 0;
					let passed = false;
					const parser = createParser({
						onError() {
							throw new ModelConfigurationErrorV1();
						},
						onRetry() {
							throw new ModelConfigurationErrorV1();
						},
						onEvent({ data }) {
							if (passed) throw new ModelConfigurationErrorV1();
							if (!data) return;
							const value = JSON.parse(data);
							if (
								["error", "response.failed", "response.incomplete"].includes(
									value?.type,
								)
							)
								throw new ModelConfigurationErrorV1();
							if (value?.type !== "response.completed") return;
							const result = completedSchema.parse(value).response;
							passed =
								(result.model === input.modelId ||
									result.model.startsWith(`${input.modelId}-`)) &&
								result.reasoning.effort === level &&
								result.output.some(
									(item) =>
										item.type === "function_call" &&
										item.name === "agent_infra_conformance" &&
										item.status === "completed" &&
										item.arguments !== undefined &&
										Object.keys(
											z.strictObject({}).parse(JSON.parse(item.arguments)),
										).length === 0,
								);
							if (!passed) throw new ModelConfigurationErrorV1();
						},
					});
					try {
						while (true) {
							const chunk = await modelOperationV1(signal, () => reader.read());
							if (chunk.done) break;
							bytes += chunk.value.byteLength;
							if (bytes > 1_048_576) throw new ModelConfigurationErrorV1();
							const decoded = decoder.decode(chunk.value, { stream: true });
							ending = `${ending}${decoded}`.slice(-4);
							parser.feed(decoded);
						}
						parser.feed(decoder.decode());
						// The parser defers a trailing CR while waiting to distinguish CRLF.
						// At EOF, finish that terminator without completing a missing blank line.
						if (ending.endsWith("\r")) parser.feed("\n");
						if (!ending.replace(/\r\n?/g, "\n").endsWith("\n\n"))
							throw new ModelConfigurationErrorV1();
					} finally {
						void reader.cancel().catch(() => {});
					}
					if (!passed) throw new ModelConfigurationErrorV1();
				}
			});
		},
	};
}

export function createFakeModelAccessValidatorV1(
	grants: readonly {
		readonly endpointId: string;
		readonly modelId: string;
		readonly credential: string;
		readonly reasoningLevels: readonly string[];
	}[],
): ModelAccessValidatorV1 {
	const admitted = structuredClone(grants);
	return {
		async validate(input, { signal }) {
			await modelOperationV1(signal, async () => {
				const credential = validatePolicy(input);
				if (
					!admitted.some(
						(grant) =>
							grant.endpointId === input.endpoint.endpointId &&
							grant.modelId === input.modelId &&
							grant.credential === credential &&
							input.reasoningLevels.every((level) =>
								grant.reasoningLevels.includes(level),
							),
					)
				)
					throw new ModelConfigurationErrorV1();
			});
		},
	};
}
