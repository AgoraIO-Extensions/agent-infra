import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
	claudeCommand,
	completeClaudeResponse,
} from "./claude-native.test-support.js";
import { ClaudeRuntimeDriver } from "./claude-runtime-driver.js";
import type { RuntimeExternalActionAuthorization } from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";

// Exercise the real Driver and HTTP transport; this mock is not native barrier evidence.
const source = vi.hoisted(() => ({
	run: undefined as ((options: Options) => Promise<void>) | undefined,
}));
vi.mock("./claude-query.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./claude-query.js")>();
	return {
		...original,
		claudeQuery: (...args: Parameters<typeof original.claudeQuery>) => {
			if (!source.run) return original.claudeQuery(...args);
			const [options] = args;
			return {
				query: (async function* () {
					await source.run?.(options);
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						session_id: options.sessionId ?? options.resume,
					};
				})(),
				close: async () => {},
			};
		},
	};
});
afterEach(() => {
	source.run = undefined;
});

type ClaudeSourceRequest = (counting?: boolean) => Promise<Response>;
async function withClaudeSource(
	program: (request: ClaudeSourceRequest, options: Options) => Promise<void>,
	authorize:
		| false
		| ((
				action: RuntimeExternalActionAuthorization,
				driver: ClaudeRuntimeDriver,
		  ) => Promise<void>),
	verify: (context: {
		driver: ClaudeRuntimeDriver;
		ref: string;
		command: ReturnType<typeof claudeCommand>;
		requests: () => number;
		path: string;
	}) => Promise<void>,
) {
	const path = await mkdtemp(join(tmpdir(), "claude-current-authority-"));
	let requests = 0;
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {
			/* Drain the synthetic body. */
		}
		requests++;
		if (request.url?.includes("count_tokens"))
			response.end('{"input_tokens":123}');
		else completeClaudeResponse(response, "synthetic-message", "claude-opus-5");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw Error();
	let driver: ClaudeRuntimeDriver;
	source.run = (options) =>
		program(
			async (counting = false) =>
				fetch(
					`${options.env?.ANTHROPIC_BASE_URL}/v1/messages${counting ? "/count_tokens" : ""}`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${options.env?.ANTHROPIC_AUTH_TOKEN}`,
						},
						body: JSON.stringify({
							model: "claude-opus-5",
							messages: [],
							...(!counting
								? {
										stream: true,
										thinking: { type: "adaptive" },
										output_config: { effort: "high" },
									}
								: {}),
						}),
					},
				),
			options,
		);
	driver = await ClaudeRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "option-one",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "option-one",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer",
				endpoint: `http://127.0.0.1:${address.port}`,
				credential: "synthetic-credential",
			},
		],
		...(authorize
			? {
					authorizeExternalAction: (
						action: RuntimeExternalActionAuthorization,
					) => authorize(action, driver),
				}
			: {}),
	});
	try {
		const command = claudeCommand();
		const accepted = await driver.execute(command);
		await verify({
			driver,
			ref: accepted.nativeSessionRef,
			command,
			requests: () => requests,
			path,
		});
	} finally {
		await driver.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { recursive: true, force: true });
	}
}

it.each([
	["first", "revoked"],
	["continuation", "revoked"],
	["count_tokens", "revoked"],
	["first", "missing"],
	["count_tokens", "missing"],
	["first", "forged-attempt"],
] as const)(
	"blocks Claude %s model request with %s current authority",
	async (kind, authority) => {
		let responseStatus = 0;
		let receiptReturned = false;
		const actions: RuntimeExternalActionAuthorization[] = [];
		await withClaudeSource(
			async (request) => {
				if (kind === "continuation") {
					const first = await request();
					expect(first.ok).toBe(true);
					await first.text();
				}
				const response = await request(kind === "count_tokens");
				responseStatus = response.status;
				await response.text();
				throw Error("Synthetic native request denied");
			},
			authority === "missing"
				? false
				: async (action, driver) => {
						expect(receiptReturned).toBe(true);
						await driver.validateExternalAction(action);
						for (const changed of [
							{ nativeSessionRef: randomUUID() },
							{ executionId: randomUUID() },
							{ attemptRef: randomUUID() },
							{ operationRef: randomUUID() },
							{ runtimeOperationId: randomUUID() },
							{ kind: "tool" as const },
							{ purpose: "source-reserve" as const },
							{ purpose: "source-bind" as const },
						])
							await expect(
								driver.validateExternalAction({ ...action, ...changed }),
							).rejects.toThrow();
						actions.push(action);
						if (kind === "continuation" && actions.length === 1) return;
						if (authority === "forged-attempt")
							return driver.validateExternalAction({
								...action,
								attemptRef: randomUUID(),
							});
						throw Error("Synthetic current authority revoked");
					},
			async ({ driver, ref, command, requests }) => {
				receiptReturned = true;
				await vi.waitFor(() => expect(responseStatus).not.toBe(0));
				expect(responseStatus).toBe(400);
				expect(requests()).toBe(kind === "continuation" ? 1 : 0);
				expect(actions).toHaveLength(
					authority === "missing" ? 0 : kind === "continuation" ? 2 : 1,
				);
				const events = await driver.replayEvents(ref, command.executionId);
				const facts = events.flatMap((event) =>
					event.type === "operation" ? [event.payload] : [],
				);
				const intent = facts.findLast((fact) => fact.phase === "intent");
				expect(intent).toMatchObject({ kind: "model", phase: "intent" });
				expect(
					facts
						.filter(
							(fact) =>
								fact.operationRef === intent?.operationRef &&
								fact.attemptRef === intent?.attemptRef,
						)
						.map((fact) => fact.phase),
				).not.toContain("started");
				if (kind === "continuation")
					expect(intent?.attemptRef).not.toBe(facts[0]?.attemptRef);
				if (kind === "count_tokens")
					expect(intent?.operationRef).not.toBe(facts[0]?.operationRef);
			},
		);
	},
);

it.each([
	["PreToolUse", "revoked"],
	["canUseTool", "revoked"],
	["PreToolUse", "missing"],
	["canUseTool", "missing"],
] as const)(
	"blocks Claude %s tool permission with %s current authority",
	async (boundary, authority) => {
		let decided = false;
		let denied = false;
		const actions: RuntimeExternalActionAuthorization[] = [];
		await withClaudeSource(
			async (request, options) => {
				const response = await request();
				expect(response.ok).toBe(authority !== "missing");
				await response.text();
				const input = { file_path: join(String(options.cwd), "synthetic.txt") };
				const signal = new AbortController().signal;
				if (boundary === "canUseTool") {
					const decision = await options.canUseTool?.("Write", input, {
						signal,
						toolUseID: "synthetic-tool",
						requestId: "synthetic-permission-request",
					});
					denied = decision?.behavior === "deny";
				} else {
					const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
					const decision = await hook?.(
						{
							hook_event_name: "PreToolUse",
							session_id: String(options.sessionId),
							transcript_path: "synthetic-unused",
							cwd: String(options.cwd),
							tool_name: "Write",
							tool_input: input,
							tool_use_id: "synthetic-tool",
						},
						"synthetic-tool",
						{ signal },
					);
					denied =
						!!decision &&
						"hookSpecificOutput" in decision &&
						decision.hookSpecificOutput?.hookEventName === "PreToolUse" &&
						decision.hookSpecificOutput.permissionDecision === "deny";
				}
				decided = true;
			},
			authority === "missing"
				? false
				: async (action, driver) => {
						await driver.validateExternalAction(action);
						actions.push(action);
						if (action.kind === "tool")
							throw Error("Synthetic current authority revoked");
					},
			async ({ driver, ref, command }) => {
				await vi.waitFor(() => expect(decided).toBe(true));
				expect(denied).toBe(true);
				expect(actions.filter((action) => action.kind === "tool")).toHaveLength(
					authority === "missing" ? 0 : 1,
				);
				const events = await driver.replayEvents(ref, command.executionId);
				const facts = events.flatMap((event) =>
					event.type === "operation" && event.payload.kind === "tool"
						? [event.payload]
						: [],
				);
				expect(facts.map((fact) => fact.phase)).not.toContain("started");
			},
		);
	},
);

it("blocks Claude model requests before current authority when durable intent fails", async () => {
	let inject = false;
	let responseStatus = 0;
	let authorityChecks = 0;
	const update = DurableJsonFile.prototype.update;
	const spy = vi.spyOn(DurableJsonFile.prototype, "update");
	spy.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
		if (inject && new Error().stack?.includes("modelRequestIntent")) {
			inject = false;
			return Promise.reject(Error("Synthetic durable intent failure"));
		}
		return update.call(this, change);
	});
	try {
		await withClaudeSource(
			async (request) => {
				inject = true;
				const response = await request();
				responseStatus = response.status;
				await response.text();
				throw Error("Synthetic native request denied");
			},
			async (action, driver) => {
				authorityChecks++;
				await driver.validateExternalAction(action);
			},
			async ({ driver, ref, command, requests }) => {
				await vi.waitFor(() => expect(responseStatus).not.toBe(0));
				expect(responseStatus).toBe(400);
				expect(requests()).toBe(0);
				expect(authorityChecks).toBe(0);
				const events = await driver.replayEvents(ref, command.executionId);
				expect(
					events.flatMap((event) =>
						event.type === "operation" ? [event.payload.phase] : [],
					),
				).not.toContain("started");
			},
		);
	} finally {
		spy.mockRestore();
	}
});

it("retains an unknown Claude dispatch and refuses retry after started and receipt persistence fail", async () => {
	let inject = false;
	let finished = false;
	let observedRequests = () => 0;
	const statuses: number[] = [];
	const update = DurableJsonFile.prototype.update;
	const spy = vi.spyOn(DurableJsonFile.prototype, "update");
	spy.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
		if (inject && new Error().stack?.includes("modelPhase"))
			return vi
				.waitFor(() => expect(observedRequests()).toBe(1))
				.then(() => {
					throw Error("Synthetic model fact persistence failure");
				});
		return update.call(this, change);
	});
	try {
		await withClaudeSource(
			async (request) => {
				inject = true;
				const first = await request();
				statuses.push(first.status);
				await first.text();
				inject = false;
				const retry = await request();
				statuses.push(retry.status);
				await retry.text();
				finished = true;
			},
			(action, driver) => driver.validateExternalAction(action),
			async ({ driver, ref, command, requests, path }) => {
				observedRequests = requests;
				await vi.waitFor(() => expect(finished).toBe(true));
				expect(statuses).toEqual([400, 400]);
				expect(requests()).toBe(1);
				await vi.waitFor(async () =>
					expect(await driver.getStatus(ref, command.executionId)).toBe(
						"unknown",
					),
				);
				const events = await driver.replayEvents(ref, command.executionId);
				const facts = events.flatMap((event) =>
					event.type === "operation" ? [event.payload] : [],
				);
				expect(new Set(facts.map((fact) => fact.attemptRef)).size).toBe(1);
				await driver.close();
				const recovered = await ClaudeRuntimeDriver.open({
					path,
					configVersion: "configuration-a",
					defaultModelOptionId: "option-one",
					defaultReasoningLevel: "high",
					modelOptions: [
						{
							modelOptionId: "option-one",
							model: "claude-opus-5",
							reasoningLevels: ["high"],
							authentication: "bearer",
							endpoint: "http://127.0.0.1:1",
							credential: "synthetic-credential",
						},
					],
					authorizeExternalAction: (action) =>
						recovered.validateExternalAction(action),
				});
				try {
					expect(await recovered.getStatus(ref, command.executionId)).toBe(
						"unknown",
					);
					await recovered.execute(command);
					const events = await recovered.replayEvents(ref, command.executionId);
					expect(
						events.flatMap((event) =>
							event.type === "operation" ? [event.payload.phase] : [],
						),
					).toContain("unknown");
					expect(requests()).toBe(1);
				} finally {
					await recovered.close();
				}
			},
		);
	} finally {
		inject = false;
		spy.mockRestore();
	}
});

it("dispatches Claude immediately after current authority without waiting on another durable write", async () => {
	let afterGate = false;
	let paused = false;
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const update = DurableJsonFile.prototype.update;
	const spy = vi.spyOn(DurableJsonFile.prototype, "update");
	spy.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
		if (afterGate) {
			afterGate = false;
			paused = true;
			return barrier.then(() => update.call(this, change));
		}
		return update.call(this, change);
	});
	try {
		await withClaudeSource(
			async (request) => {
				const response = await request();
				await response.text();
			},
			async (action, driver) => {
				await driver.validateExternalAction(action);
				afterGate = true;
			},
			async ({ requests }) => {
				try {
					await vi.waitFor(() => {
						expect(paused).toBe(true);
						expect(requests()).toBe(1);
					});
				} finally {
					release();
				}
			},
		);
	} finally {
		release();
		spy.mockRestore();
	}
});

it("runs a native Claude Turn, durably replays its result and resumes the original Session", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-conformance-"));
	let calls = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (b) => {
			body += b;
		});
		req.on("end", () => {
			const value = JSON.parse(body);
			expect(value.model).toBe("claude-opus-5");
			expect(value.output_config.effort).toBe("high");
			calls++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{
					type: "message_start",
					message: {
						id: `msg_${calls}`,
						type: "message",
						role: "assistant",
						model: value.model,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: `OK-${calls}` },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 2 },
				},
				{ type: "message_stop" },
			])
				res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const options = {
		path,
		authorizeExternalAction: (action: RuntimeExternalActionAuthorization) =>
			driver.validateExternalAction(action),
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer" as const,
				endpoint: `http://127.0.0.1:${address.port}`,
				credential: "synthetic-model-credential",
			},
		],
	};
	let driver = await ClaudeRuntimeDriver.open(options);
	try {
		const command = {
			schemaVersion: 2 as const,
			kind: "submit-turn" as const,
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
			input: { text: "Reply with OK.", attachments: [] },
		};
		const accepted = await driver.execute(command);
		expect(accepted.result).toEqual({ outcome: "accepted", status: "running" });
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		const events = await driver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.payload.delta)
				.join(""),
		).toBe("OK-1");
		const modelFacts = events.flatMap((event) =>
			event.type === "operation" && event.payload.kind === "model"
				? [event.payload]
				: [],
		);
		expect(modelFacts.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"completed",
		]);
		expect(modelFacts.at(-1)?.usage).toEqual({
			inputTokens: 10,
			outputTokens: 2,
		});
		await driver.close();
		driver = await ClaudeRuntimeDriver.open(options);
		expect(await driver.execute(command)).toEqual(accepted);
		const next = {
			...command,
			operationId: "operation-b",
			executionId: "execution-b",
			turnId: "turn-b",
			nativeSessionRef: accepted.nativeSessionRef,
		};
		const resumed = await driver.execute(next);
		expect(resumed.nativeSessionRef).toBe(accepted.nativeSessionRef);
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(resumed.nativeSessionRef, next.executionId),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		expect(calls).toBe(2);
		await driver.close();
		await rm(join(path, accepted.nativeSessionRef, "state.json"));
		driver = await ClaudeRuntimeDriver.open(options);
		await expect(
			driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).rejects.toThrow("Runtime session could not be recovered");
		await expect(
			driver.execute({
				...next,
				operationId: "operation-c",
				executionId: "execution-c",
				turnId: "turn-c",
			}),
		).rejects.toThrow("Runtime session could not be recovered");
		expect(calls).toBe(2);
	} finally {
		await driver.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { recursive: true, force: true });
	}
}, 30000);
