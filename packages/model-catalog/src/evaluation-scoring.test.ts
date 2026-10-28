import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { expect, it } from "vitest";
import type { ModelEndpointV1 } from "./catalog.js";
import {
	EvaluationModelScoringErrorV1,
	type EvaluationModelScoringInputV1,
	scoreEvaluationModelV1,
} from "./evaluation-scoring.js";

const credential = new TextEncoder().encode("synthetic-scoring-credential");
const score = { status: "scored", value: 0.75, reason: "Synthetic rationale" };
type Protocol = ModelEndpointV1["protocol"];
const protocols: Protocol[] = ["openai-responses-v1", "anthropic-messages-v1"];
function envelope(
	protocol: Protocol,
	result: unknown = score,
): Record<string, unknown> {
	const text = JSON.stringify(result);
	return protocol === "openai-responses-v1"
		? {
				id: "response-fixture",
				object: "response",
				status: "completed",
				model: "fixture-model",
				error: null,
				incomplete_details: null,
				output: [
					{
						id: "message-fixture",
						type: "message",
						status: "completed",
						role: "assistant",
						content: [{ type: "output_text", text, annotations: [] }],
					},
				],
			}
		: {
				id: "message-fixture",
				type: "message",
				role: "assistant",
				model: "fixture-model",
				stop_reason: "end_turn",
				stop_sequence: null,
				content: [{ type: "text", text }],
				usage: { input_tokens: 1, output_tokens: 1 },
			};
}
async function fixture(
	protocol: Protocol,
	handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
	const server = createServer((req, res) => {
		void Promise.resolve(handler(req, res)).catch(() => {
			res.destroy();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("fixture address");
	const origin = `http://127.0.0.1:${address.port}`;
	const input: EvaluationModelScoringInputV1 = {
		endpoint: {
			endpointId: "fixture",
			baseUrl: origin,
			origin,
			protocol,
			...(protocol === "anthropic-messages-v1"
				? { authentication: "api-key" as const }
				: {}),
			security: { tls: "loopback-http", redirects: "reject" },
			capabilities: { streaming: true, tools: true, reasoningLevels: ["low"] },
			allowedModels: ["fixture-model"],
			available: true,
		},
		modelId: "fixture-model",
		credential,
		rubric: "Match the approved standard.",
		sample: "Synthetic question",
		context: "Synthetic context",
		expected: "Synthetic expected answer",
		output: "Synthetic actual answer",
		minimum: 0,
		maximum: 1,
		maxInputBytes: 4096,
		maxOutputBytes: 4096,
		maxOutputTokens: 256,
		timeoutMs: 2000,
	};
	return {
		input,
		origin,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
function json(res: ServerResponse, value: unknown) {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}
it.each(protocols)(
	"sends an actual bounded %s request with no tools and reads the exact-model score",
	async (protocol) => {
		let observed:
			| {
					path: string | undefined;
					headers: IncomingMessage["headers"];
					body: Record<string, unknown>;
			  }
			| undefined;
		const f = await fixture(protocol, async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			observed = {
				path: req.url,
				headers: req.headers,
				body: JSON.parse(body),
			};
			json(res, envelope(protocol));
		});
		const before = credential.slice();
		try {
			expect(await scoreEvaluationModelV1(f.input)).toEqual(score);
			expect(credential).toEqual(before);
			expect(observed?.path).toBe(
				protocol === "openai-responses-v1" ? "/responses" : "/v1/messages",
			);
			expect(observed?.body.model).toBe("fixture-model");
			expect(observed?.body.stream).toBe(false);
			expect(observed?.body).not.toHaveProperty("conversation");
			expect(observed?.body).not.toHaveProperty("previous_response_id");
			if (protocol === "openai-responses-v1") {
				expect(observed?.headers.authorization).toBe(
					"Bearer synthetic-scoring-credential",
				);
				expect(observed?.headers["x-api-key"]).toBeUndefined();
				expect(observed?.body).toMatchObject({
					tools: [],
					tool_choice: "none",
					store: false,
					max_output_tokens: 256,
				});
			} else {
				expect(observed?.headers["x-api-key"]).toBe(
					"synthetic-scoring-credential",
				);
				expect(observed?.headers.authorization).toBeUndefined();
				expect(observed?.headers["anthropic-version"]).toBe("2023-06-01");
				expect(observed?.body).not.toHaveProperty("tools");
				expect(observed?.body.max_tokens).toBe(256);
			}
			const sent = JSON.stringify(observed?.body);
			expect(sent).toContain("Synthetic actual answer");
			expect(sent).toContain("Synthetic context");
		} finally {
			await f.close();
		}
	},
);
it("uses a Messages Bearer only when the approved endpoint selects it", async () => {
	let headers: IncomingMessage["headers"] | undefined;
	const f = await fixture("anthropic-messages-v1", (req, res) => {
		headers = req.headers;
		json(
			res,
			envelope("anthropic-messages-v1", {
				status: "not_applicable",
				value: null,
				reason: "No applicable criterion",
			}),
		);
	});
	try {
		expect(
			await scoreEvaluationModelV1({
				...f.input,
				endpoint: { ...f.input.endpoint, authentication: "bearer" },
			}),
		).toMatchObject({ status: "not_applicable", value: null });
		expect(headers?.authorization).toBe("Bearer synthetic-scoring-credential");
		expect(headers?.["x-api-key"]).toBeUndefined();
	} finally {
		await f.close();
	}
});
it("does not send omitted content categories or return Responses reasoning as score rationale", async () => {
	let body: Record<string, unknown> | undefined;
	const response = envelope("openai-responses-v1");
	response.output = [
		{
			id: "reasoning-fixture",
			type: "reasoning",
			summary: [{ type: "summary_text", text: "Synthetic private reasoning" }],
		},
		...(response.output as unknown[]),
	];
	const f = await fixture("openai-responses-v1", async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		body = JSON.parse(raw);
		json(res, response);
	});
	try {
		const {
			sample: _sample,
			context: _context,
			expected: _expected,
			...input
		} = f.input;
		expect(await scoreEvaluationModelV1(input)).toEqual(score);
		const sent = JSON.stringify(body);
		expect(sent).not.toContain("Synthetic question");
		expect(sent).not.toContain("Synthetic context");
		expect(sent).not.toContain("Synthetic expected answer");
	} finally {
		await f.close();
	}
});
it.each(protocols)(
	"rejects %s tools, mismatched model, duplicate final text and incomplete completion",
	async (protocol) => {
		const mutations: ((value: Record<string, unknown>) => void)[] = [
			(value) => {
				value.model = "other-model";
			},
			(value) => {
				if (protocol === "openai-responses-v1") value.status = "incomplete";
				else value.stop_reason = "max_tokens";
			},
			(value) => {
				if (protocol === "openai-responses-v1")
					value.output = [
						{
							type: "function_call",
							name: "malicious",
							arguments: "{}",
							status: "completed",
						},
					];
				else {
					value.stop_reason = "tool_use";
					value.content = [
						{
							type: "tool_use",
							id: "tool-fixture",
							name: "malicious",
							input: {},
						},
					];
				}
			},
			(value) => {
				if (protocol === "openai-responses-v1")
					value.output = [
						...(value.output as unknown[]),
						...(value.output as unknown[]),
					];
				else
					value.content = [
						...(value.content as unknown[]),
						...(value.content as unknown[]),
					];
			},
			(value) => {
				if (protocol === "openai-responses-v1")
					value.error = { message: "PRIVATE_PROVIDER_ERROR" };
				else value.stop_reason = "refusal";
			},
		];
		for (const mutate of mutations) {
			const value = envelope(protocol);
			mutate(value);
			const f = await fixture(protocol, (_req, res) => json(res, value));
			try {
				await expect(scoreEvaluationModelV1(f.input)).rejects.toMatchObject({
					code: "invalid_result",
				});
			} finally {
				await f.close();
			}
		}
	},
);
it.each(protocols)(
	"rejects %s malformed, out-of-range, authority-bearing or oversize results",
	async (protocol) => {
		for (const result of [
			{ ...score, value: 2 },
			{ ...score, value: null },
			{ ...score, status: "failed" },
			{ ...score, tools: [] },
			{ status: "not_applicable", value: 0, reason: "x" },
			{ ...score, reason: "\ud800" },
			{ ...score, reason: "x".repeat(5000) },
		]) {
			const f = await fixture(protocol, (_req, res) =>
				json(res, envelope(protocol, result)),
			);
			try {
				await expect(scoreEvaluationModelV1(f.input)).rejects.toMatchObject({
					code: "invalid_result",
				});
			} finally {
				await f.close();
			}
		}
	},
);
it.each(protocols)(
	"rejects %s truncated JSON, invalid UTF-8, multiple envelopes and SSE instead of non-stream JSON",
	async (protocol) => {
		for (const [contentType, body] of [
			["application/json", '{"status":'],
			["application/json", Buffer.from([0xff])],
			[
				"application/json",
				JSON.stringify(envelope(protocol)) + JSON.stringify(envelope(protocol)),
			],
			["text/event-stream", `data: ${JSON.stringify(envelope(protocol))}\n\n`],
		] as const) {
			const f = await fixture(protocol, (_req, res) => {
				res.writeHead(200, { "content-type": contentType });
				res.end(body);
			});
			try {
				await expect(scoreEvaluationModelV1(f.input)).rejects.toMatchObject({
					code: "invalid_result",
				});
			} finally {
				await f.close();
			}
		}
	},
);
it.each(protocols)(
	"rejects %s redirect without forwarding credentials and hides provider errors",
	async (protocol) => {
		let redirects = 0;
		const f = await fixture(protocol, (req, res) => {
			if (req.url === "/secret-target") {
				redirects++;
				json(res, envelope(protocol));
				return;
			}
			res.writeHead(307, { location: "/secret-target" });
			res.end("PRIVATE_PROVIDER_ERROR");
		});
		try {
			await expect(scoreEvaluationModelV1(f.input)).rejects.toMatchObject({
				code: "unavailable",
				message: "EVALUATION_MODEL_UNAVAILABLE",
			});
			expect(redirects).toBe(0);
			const failure = await scoreEvaluationModelV1({
				...f.input,
				fetch: async () => {
					throw new Error(
						"synthetic-scoring-credential PRIVATE_PROVIDER_ERROR",
					);
				},
			}).catch((error: unknown) => error);
			expect(failure).toMatchObject({
				message: "EVALUATION_MODEL_UNAVAILABLE",
			});
			expect(failure).not.toHaveProperty("cause");
			expect(JSON.stringify(failure)).not.toContain(
				"synthetic-scoring-credential",
			);
		} finally {
			await f.close();
		}
	},
);
it.each(protocols)(
	"bounds %s response headers and stalled response bodies with one deadline",
	async (protocol) => {
		for (const headers of [false, true]) {
			const f = await fixture(protocol, (_req, res) => {
				if (headers) {
					res.writeHead(200, { "content-type": "application/json" });
					res.write('{"waiting":');
				}
			});
			try {
				await expect(
					scoreEvaluationModelV1({ ...f.input, timeoutMs: 40 }),
				).rejects.toMatchObject({ code: "timeout" });
			} finally {
				await f.close();
			}
		}
	},
);
it("rejects invalid approved inputs before any request and preserves caller cancellation", async () => {
	let calls = 0;
	const f = await fixture("openai-responses-v1", (_req, res) => {
		calls++;
		json(res, envelope("openai-responses-v1"));
	});
	try {
		for (const input of [
			{ ...f.input, maxInputBytes: 20 },
			{ ...f.input, timeoutMs: 0 },
			{ ...f.input, maxOutputBytes: 0 },
			{ ...f.input, maxOutputTokens: 0 },
			{ ...f.input, minimum: 1, maximum: 1 },
			{
				...f.input,
				credential: new TextEncoder().encode("contains\nheader\ncontrol"),
			},
			{
				...f.input,
				endpoint: { ...f.input.endpoint, allowedModels: ["different"] },
			},
			{ ...f.input, endpoint: { ...f.input.endpoint, available: false } },
			{
				...f.input,
				endpoint: { ...f.input.endpoint, origin: "https://foreign.test" },
			},
			{ ...f.input, output: "\ud800" },
		])
			await expect(scoreEvaluationModelV1(input)).rejects.toMatchObject({
				code: "invalid",
			});
		const controller = new AbortController();
		controller.abort();
		await expect(
			scoreEvaluationModelV1({ ...f.input, signal: controller.signal }),
		).rejects.toMatchObject({ code: "timeout" });
		expect(calls).toBe(0);
		const err = new EvaluationModelScoringErrorV1("invalid_result");
		expect(err.message).toBe("EVALUATION_MODEL_INVALID_RESULT");
	} finally {
		await f.close();
	}
});

it.each(protocols)(
	"rejects credential echoes anywhere in %s provider material without exposing them",
	async (protocol) => {
		for (const field of ["reason", "metadata", "escaped"]) {
			const leaked =
				field === "metadata"
					? envelope(protocol)
					: envelope(protocol, {
							...score,
							reason: "synthetic-scoring-credential",
						});
			if (field === "metadata")
				leaked.provider_metadata = {
					private_value: "synthetic-scoring-credential",
				};
			const f = await fixture(protocol, (_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				const body = JSON.stringify(leaked);
				res.end(
					field === "escaped"
						? body.replaceAll(
								"synthetic-scoring-credential",
								"\\u0073ynthetic-scoring-credential",
							)
						: body,
				);
			});
			try {
				await expect(scoreEvaluationModelV1(f.input)).rejects.toMatchObject({
					code: "invalid_result",
					message: "EVALUATION_MODEL_INVALID_RESULT",
				});
			} finally {
				await f.close();
			}
		}
	},
);
it("releases the bounded response reader", async () => {
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(
				new TextEncoder().encode(
					JSON.stringify(envelope("openai-responses-v1")),
				),
			);
			c.close();
		},
	});
	const f = await fixture("openai-responses-v1", (_req, res) =>
		json(res, envelope("openai-responses-v1")),
	);
	try {
		expect(
			await scoreEvaluationModelV1({
				...f.input,
				fetch: async () =>
					new Response(body, {
						headers: { "content-type": "application/json" },
					}),
			}),
		).toEqual(score);
		expect(body.locked).toBe(false);
	} finally {
		await f.close();
	}
});
it("freezes model identity and response limits before awaiting transport", async () => {
	const f = await fixture("openai-responses-v1", (_req, res) =>
		json(res, envelope("openai-responses-v1")),
	);
	try {
		const input: EvaluationModelScoringInputV1 = {
			...f.input,
			fetch: async () => {
				Object.assign(input, {
					modelId: "other-model",
					maximum: 100,
					maxOutputBytes: 100000,
				});
				return Response.json({
					...envelope("openai-responses-v1"),
					model: "other-model",
				});
			},
		};
		await expect(scoreEvaluationModelV1(input)).rejects.toMatchObject({
			code: "invalid_result",
		});
		const controller = new AbortController();
		const pending = scoreEvaluationModelV1({
			...input,
			modelId: "fixture-model",
			signal: controller.signal,
			fetch: () => new Promise<Response>(() => {}),
		});
		controller.abort(new Error("PRIVATE_ABORT_REASON"));
		await expect(pending).rejects.toMatchObject({
			code: "timeout",
			message: "EVALUATION_MODEL_TIMEOUT",
		});
	} finally {
		await f.close();
	}
});

it.each([401, 403])(
	"classifies trusted HTTP %s as definite authorization rejection without provider text",
	async (status) => {
		const f = await fixture("openai-responses-v1", (_req, res) => {
			res.writeHead(status, { "content-type": "text/plain" });
			res.end("PRIVATE_AUTH_REJECTION synthetic-scoring-credential");
		});
		try {
			await expect(scoreEvaluationModelV1(f.input)).rejects.toMatchObject({
				code: "authorization_denied",
				message: "EVALUATION_MODEL_AUTHORIZATION_DENIED",
			});
		} finally {
			await f.close();
		}
	},
);

it("does not classify a redirected or forged error as a trusted authorization refusal", async () => {
	const f = await fixture("openai-responses-v1", (_req, res) => {
		res.writeHead(401);
		res.end();
	});
	try {
		for (const fetch of [
			async () => {
				throw { code: "authorization_denied" };
			},
			async () => {
				const response = new Response(null, { status: 401 });
				Object.defineProperty(response, "redirected", { value: true });
				return response;
			},
		])
			await expect(
				scoreEvaluationModelV1({ ...f.input, fetch }),
			).rejects.toMatchObject({ code: "unavailable" });
	} finally {
		await f.close();
	}
});
