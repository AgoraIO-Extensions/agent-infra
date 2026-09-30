import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
	claudeCommand,
	completeClaudeResponse,
} from "./claude-native.test-support.js";
import { ClaudeRuntimeDriver } from "./claude-runtime-driver.js";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";

// Exercise the real Driver and HTTP transport; this mock is not native barrier evidence.
const source = vi.hoisted(() => ({
	run: undefined as
		| ((options: Options) => Promise<void> | AsyncGenerator<SDKMessage, void>)
		| undefined,
}));
const historySource = vi.hoisted(() => ({
	read: undefined as
		| (() => Promise<{
				users: string[];
				completed: boolean;
				events: {
					type: "text" | "tool";
					payload: {
						delta?: string;
						id?: string;
						name?: string;
						phase?: "started" | "completed" | "failed";
					};
				}[];
		  }>)
		| undefined,
	calls: 0,
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
					const run = source.run?.(options);
					if (run && Symbol.asyncIterator in run) yield* run;
					else await run;
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
vi.mock("./claude-session-history.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("./claude-session-history.js")>();
	return {
		...original,
		readClaudeSessionHistory: (
			...args: Parameters<typeof original.readClaudeSessionHistory>
		) => {
			historySource.calls++;
			return historySource.read
				? historySource.read()
				: original.readClaudeSessionHistory(...args);
		},
	};
});
afterEach(() => {
	source.run = undefined;
	historySource.read = undefined;
	historySource.calls = 0;
});

type ClaudeSourceRequest = (counting?: boolean) => Promise<Response>;
async function withClaudeSource(
	program: (
		request: ClaudeSourceRequest,
		options: Options,
	) => Promise<void> | AsyncGenerator<SDKMessage, void>,
	authorize:
		| false
		| ((
				action: RuntimeExternalActionAuthorization,
				driver: ClaudeRuntimeDriver,
				// biome-ignore lint/suspicious/noConfusingVoidType: validation callbacks may intentionally return no delivery value
		  ) => Promise<RuntimeExternalActionAuthorizationResult | void>),
	verify: (context: {
		driver: ClaudeRuntimeDriver;
		ref: string;
		command: ReturnType<typeof claudeCommand>;
		requests: () => number;
		path: string;
		options: Options;
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
	let currentOptions: Options | undefined;
	source.run = (options) => {
		currentOptions = options;
		return program(
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
	};
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
					) =>
						authorize(action, driver).then(
							(result) => result ?? { relayKey: "synthetic-credential" },
						),
				}
			: {}),
	});
	try {
		const command = claudeCommand();
		const accepted = await driver.execute(command);
		if (!currentOptions) throw Error("Native options missing");
		await verify({
			driver,
			ref: accepted.nativeSessionRef,
			command,
			requests: () => requests,
			path,
			options: currentOptions,
		});
	} finally {
		await driver.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { recursive: true, force: true });
	}
}

it("replays legacy Claude tool history without fabricating operation facts", async () => {
	await withClaudeSource(
		async (request) => {
			const response = await request();
			expect(response.ok).toBe(true);
			await response.text();
		},
		(action, driver) => driver.validateExternalAction(action),
		async ({ driver, ref, command, requests, path }) => {
			await driver.close();
			const statePath = join(path, ref, "state.json");
			type LegacyEvent = {
				type: string;
				cursor: string;
				payload?: { delta?: string };
			};
			type LegacyState = {
				sequence: number;
				turns: Array<{
					executionId: string;
					userMessageId: string;
					status: string;
					events: LegacyEvent[];
					modelResponse?: { state: string; endTurn: boolean };
					nativeResult?: unknown;
					toolOperations?: unknown;
				}>;
			};
			const state = JSON.parse(
				await readFile(statePath, "utf8"),
			) as LegacyState;
			const turn = state.turns.find(
				(entry) => entry.executionId === command.executionId,
			);
			if (!turn) throw Error("Synthetic turn missing");
			turn.events = turn.events.filter((event) => event.type !== "completed");
			turn.status = "running";
			turn.modelResponse = { state: "completed", endTurn: true };
			delete turn.nativeResult;
			delete turn.toolOperations;
			state.sequence = state.turns.reduce(
				(total, entry) => total + entry.events.length,
				0,
			);
			await writeFile(statePath, JSON.stringify(state));

			historySource.read = async () => ({
				users: [turn.userMessageId],
				completed: true,
				events: [
					{ type: "text", payload: { delta: "OK" } },
					{
						type: "tool",
						payload: { id: "legacy-completed", name: "Read", phase: "started" },
					},
					{
						type: "tool",
						payload: { id: "legacy-completed", phase: "completed" },
					},
					{
						type: "tool",
						payload: { id: "legacy-failed", name: "Read", phase: "started" },
					},
					{
						type: "tool",
						payload: { id: "legacy-failed", phase: "failed" },
					},
				],
			});
			const reopened = await ClaudeRuntimeDriver.open({
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
			});
			try {
				expect(await reopened.getStatus(ref, command.executionId)).toBe(
					"completed",
				);
				const events = await reopened.replayEvents(ref, command.executionId);
				const toolEvents = events.filter((event) => event.type === "tool");
				expect(toolEvents).toHaveLength(4);
				expect(
					toolEvents.map((event) =>
						event.type === "tool" ? event.payload.phase : undefined,
					),
				).toEqual(["started", "completed", "started", "failed"]);
				expect(
					events.filter(
						(event) =>
							event.type === "operation" && event.payload.kind === "tool",
					),
				).toHaveLength(0);
				expect(historySource.calls).toBe(1);
				const requestsBeforeReplay = requests();
				const eventCount = events.length;
				await reopened.close();

				const reopenedAgain = await ClaudeRuntimeDriver.open({
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
				});
				try {
					expect(
						(await reopenedAgain.replayEvents(ref, command.executionId)).length,
					).toBe(eventCount);
					expect(historySource.calls).toBe(1);
					expect(requests()).toBe(requestsBeforeReplay);
				} finally {
					await reopenedAgain.close();
				}
			} finally {
				await reopened.close();
			}
		},
	);
});

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

it("records one failed attempt when Claude repeats a denied tool permission", async () => {
	const decisions: string[] = [];
	await withClaudeSource(
		async (request, options) => {
			const response = await request();
			expect(response.ok).toBe(true);
			await response.text();
			const input = {
				file_path: join(String(options.cwd), "..", "outside.txt"),
			};
			const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
			const hookDecision = await hook?.(
				{
					hook_event_name: "PreToolUse",
					session_id: String(options.sessionId),
					transcript_path: "synthetic-unused",
					cwd: String(options.cwd),
					tool_name: "Read",
					tool_input: input,
					tool_use_id: "same-native-tool",
				},
				"same-native-tool",
				{ signal: new AbortController().signal },
			);
			decisions.push(
				hookDecision &&
					"hookSpecificOutput" in hookDecision &&
					hookDecision.hookSpecificOutput &&
					"permissionDecision" in hookDecision.hookSpecificOutput &&
					hookDecision.hookSpecificOutput.permissionDecision === "deny"
					? "deny"
					: "allow",
			);
			const permission = await options.canUseTool?.("Read", input, {
				signal: new AbortController().signal,
				toolUseID: "same-native-tool",
				requestId: "synthetic-permission-request",
			});
			decisions.push(permission?.behavior ?? "missing");
		},
		async (action, driver) => driver.validateExternalAction(action),
		async ({ driver, ref, command }) => {
			await vi.waitFor(() => expect(decisions).toHaveLength(2), {
				timeout: 15_000,
			});
			expect(decisions).toEqual(["deny", "deny"]);
			const events = await driver.replayEvents(ref, command.executionId);
			const facts = events.flatMap((event) =>
				event.type === "operation" && event.payload.kind === "tool"
					? [event.payload]
					: [],
			);
			expect(facts.map((fact) => fact.phase)).toEqual(["intent", "failed"]);
			expect(new Set(facts.map((fact) => fact.attemptRef)).size).toBe(1);
		},
	);
}, 20_000);

it("denies a repeated Claude tool ID with a different tool name", async () => {
	const decisions: string[] = [];
	await withClaudeSource(
		async (request, options) => {
			const response = await request();
			expect(response.ok).toBe(true);
			await response.text();
			const input = {
				file_path: join(String(options.cwd), "synthetic.txt"),
			};
			for (const name of ["Read", "Write"]) {
				const decision = await options.canUseTool?.(name, input, {
					signal: new AbortController().signal,
					toolUseID: "same-native-tool",
					requestId: "synthetic-permission-request",
				});
				decisions.push(decision?.behavior ?? "missing");
			}
		},
		async (action, driver) => driver.validateExternalAction(action),
		async ({ driver, ref, command }) => {
			await vi.waitFor(() => expect(decisions).toHaveLength(2), {
				timeout: 15_000,
			});
			expect(decisions).toEqual(["allow", "deny"]);
			const events = await driver.replayEvents(ref, command.executionId);
			const facts = events.flatMap((event) =>
				event.type === "operation" && event.payload.kind === "tool"
					? [event.payload]
					: [],
			);
			expect(facts[0]).toMatchObject({ phase: "intent", toolId: "Read" });
			expect(facts.every((fact) => fact.toolId === "Read")).toBe(true);
			expect(new Set(facts.map((fact) => fact.operationRef)).size).toBe(1);
			expect(new Set(facts.map((fact) => fact.attemptRef)).size).toBe(1);
		},
	);
}, 20_000);

it("denies a repeated Claude tool ID with changed input", async () => {
	const decisions: string[] = [];
	await withClaudeSource(
		async (request, options) => {
			const response = await request();
			expect(response.ok).toBe(true);
			await response.text();
			const first = {
				file_path: join(String(options.cwd), "synthetic.txt"),
				content: "first synthetic value",
			};
			for (const input of [
				first,
				{ ...first },
				{ ...first, content: "changed synthetic value" },
			]) {
				const decision = await options.canUseTool?.("Write", input, {
					signal: new AbortController().signal,
					toolUseID: "same-native-tool",
					requestId: "synthetic-permission-request",
				});
				decisions.push(decision?.behavior ?? "missing");
			}
		},
		async (action, driver) => driver.validateExternalAction(action),
		async ({ driver, ref, command }) => {
			await vi.waitFor(() => expect(decisions).toHaveLength(3), {
				timeout: 15_000,
			});
			expect(decisions).toEqual(["allow", "allow", "deny"]);
			const events = await driver.replayEvents(ref, command.executionId);
			const facts = events.flatMap((event) =>
				event.type === "operation" && event.payload.kind === "tool"
					? [event.payload]
					: [],
			);
			expect([["intent"], ["intent", "unknown"]]).toContainEqual(
				facts.map((fact) => fact.phase),
			);
			expect(facts.every((fact) => fact.toolId === "Write")).toBe(true);
			expect(new Set(facts.map((fact) => fact.operationRef)).size).toBe(1);
			expect(new Set(facts.map((fact) => fact.attemptRef)).size).toBe(1);
		},
	);
}, 20_000);

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
					authorizeExternalAction: async (action) => {
						await recovered.validateExternalAction(action);
						return { relayKey: "synthetic-credential" };
					},
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

it.each(["pending", "failed"] as const)(
	"waits for the durable Claude tool result before the next model request when receipt is %s",
	async (receipt) => {
		let holdReceipt = false;
		let receiptEntered = false;
		let injectedFailure = false;
		let toolAuthorizations = 0;
		let secondAuthorizationEntered = false;
		let releaseSecondAuthorization = () => {};
		const secondAuthorization = new Promise<void>((resolve) => {
			releaseSecondAuthorization = resolve;
		});
		let secondPermission:
			| Promise<{ behavior: string } | null | undefined>
			| undefined;
		let release = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let continuation: Promise<number> | undefined;
		const update = DurableJsonFile.prototype.update;
		const spy = vi.spyOn(DurableJsonFile.prototype, "update");
		spy.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
			return update.call(this, async (draft) => {
				const result = await change(draft);
				const last = (
					draft as {
						turns?: {
							events?: {
								type: string;
								payload: { kind?: string; phase?: string };
							}[];
						}[];
					}
				).turns?.[0]?.events?.at(-1);
				if (
					holdReceipt &&
					last?.type === "operation" &&
					last.payload.kind === "tool" &&
					last.payload.phase === "completed"
				) {
					holdReceipt = false;
					receiptEntered = true;
					await barrier;
					if (receipt === "failed") {
						injectedFailure = true;
						throw Error("Synthetic durable tool result failure");
					}
				}
				return result;
			});
		});
		try {
			await withClaudeSource(
				async function* (request, options) {
					const first = await request();
					expect(first.ok).toBe(true);
					await first.text();
					const input = {
						file_path: join(String(options.cwd), "synthetic.txt"),
					};
					const permission = await options.canUseTool?.("Write", input, {
						signal: new AbortController().signal,
						toolUseID: "synthetic-tool",
						requestId: "synthetic-tool-request",
					});
					expect(permission?.behavior).toBe("allow");
					yield {
						type: "stream_event",
						session_id: options.sessionId,
						parent_tool_use_id: null,
						event: {
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "tool_use",
								id: "synthetic-tool",
								name: "Write",
								input: {},
							},
						},
					} as SDKMessage;
					if (receipt === "failed") {
						secondPermission = options.canUseTool?.(
							"Write",
							{ file_path: join(String(options.cwd), "second.txt") },
							{
								signal: new AbortController().signal,
								toolUseID: "second-tool",
								requestId: "second-tool-request",
							},
						);
						await vi.waitFor(() =>
							expect(secondAuthorizationEntered).toBe(true),
						);
					}
					continuation = request().then(
						async (response) => {
							await response.text();
							return response.status;
						},
						() => 0,
					);
					holdReceipt = true;
					yield {
						type: "user",
						session_id: options.sessionId,
						parent_tool_use_id: null,
						message: {
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "synthetic-tool",
									content: "ok",
								},
							],
						},
					} as SDKMessage;
					await continuation;
				},
				async (action, driver) => {
					if (action.kind === "tool") toolAuthorizations++;
					await driver.validateExternalAction(action);
					if (receipt === "failed" && toolAuthorizations === 2) {
						secondAuthorizationEntered = true;
						await secondAuthorization;
					}
				},
				async ({ driver, ref, command, requests, path, options }) => {
					try {
						await vi.waitFor(() => expect(receiptEntered).toBe(true));
						expect(requests()).toBe(1);
					} finally {
						release();
					}
					await vi.waitFor(() => expect(continuation).toBeDefined());
					if (receipt === "failed")
						expect([0, 400]).toContain(await continuation);
					else expect(await continuation).toBe(200);
					expect(requests()).toBe(receipt === "failed" ? 1 : 2);
					if (receipt === "failed") {
						expect(injectedFailure).toBe(true);
						releaseSecondAuthorization();
						expect(
							(secondPermission && (await secondPermission))?.behavior,
						).toBe("deny");
						const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
						const late = await hook?.(
							{
								hook_event_name: "PreToolUse",
								session_id: String(options.sessionId),
								transcript_path: "synthetic-unused",
								cwd: String(options.cwd),
								tool_name: "Write",
								tool_input: {
									file_path: join(String(options.cwd), "second.txt"),
								},
								tool_use_id: "second-tool",
							},
							"second-tool",
							{ signal: new AbortController().signal },
						);
						expect(
							late &&
								"hookSpecificOutput" in late &&
								late.hookSpecificOutput &&
								"permissionDecision" in late.hookSpecificOutput &&
								late.hookSpecificOutput.permissionDecision,
						).toBe("deny");
						expect(toolAuthorizations).toBe(2);
						await driver.execute(command);
						await driver.close();
						expect(await driver.getStatus(ref, command.executionId)).toBe(
							"unknown",
						);
						expect(requests()).toBe(1);
						const events = await driver.replayEvents(ref, command.executionId);
						const toolFacts = events.flatMap((event) =>
							event.type === "operation" && event.payload.kind === "tool"
								? [event.payload]
								: [],
						);
						expect(toolFacts.map((fact) => fact.phase)).toContain("unknown");
						expect(toolFacts.map((fact) => fact.phase)).not.toContain(
							"completed",
						);
						expect(events.some((event) => event.type === "completed")).toBe(
							false,
						);
						expect(
							events.filter(
								(event) =>
									event.type === "operation" &&
									event.payload.kind === "model" &&
									event.payload.phase === "started",
							),
						).toHaveLength(1);
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
							authorizeExternalAction: async (action) => {
								await recovered.validateExternalAction(action);
								return { relayKey: "synthetic-credential" };
							},
						});
						try {
							expect(await recovered.getStatus(ref, command.executionId)).toBe(
								"unknown",
							);
							await recovered.execute(command);
							expect(requests()).toBe(1);
						} finally {
							await recovered.close();
						}
					}
				},
			);
		} finally {
			release();
			releaseSecondAuthorization();
			spy.mockRestore();
		}
	},
);

it.each(["close", "stop"] as const)(
	"wakes a Claude tool-result gate promptly on %s",
	async (kind) => {
		let continuation: Promise<unknown> | undefined;
		let continuationSettled = false;
		let stallRead = false;
		let readEntered = false;
		let releaseRead = () => {};
		const readCommitted = DurableJsonFile.prototype.readCommitted;
		const spy = vi.spyOn(DurableJsonFile.prototype, "readCommitted");
		spy.mockImplementation(function (this: DurableJsonFile<unknown>) {
			if (stallRead) {
				stallRead = false;
				readEntered = true;
				return new Promise((resolve, reject) => {
					releaseRead = () => {
						void readCommitted.call(this).then(resolve, reject);
					};
				});
			}
			return readCommitted.call(this);
		});
		try {
			await withClaudeSource(
				async function* (request, options) {
					const first = await request();
					await first.text();
					const permission = await options.canUseTool?.(
						"Write",
						{ file_path: join(String(options.cwd), "synthetic.txt") },
						{
							signal: new AbortController().signal,
							toolUseID: "blocked-tool",
							requestId: "blocked-tool-request",
						},
					);
					expect(permission?.behavior).toBe("allow");
					stallRead = true;
					continuation = request()
						.then(
							(response) => response.text(),
							() => "closed",
						)
						.finally(() => {
							continuationSettled = true;
						});
					await continuation;
				},
				(action, driver) => driver.validateExternalAction(action),
				async ({ driver, ref, command, requests }) => {
					await vi.waitFor(() => expect(continuation).toBeDefined());
					await vi.waitFor(() => expect(readEntered).toBe(true));
					expect(continuationSettled).toBe(false);
					expect(requests()).toBe(1);
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							kind === "close"
								? driver.close()
								: driver.execute({
										schemaVersion: 1,
										kind: "stop",
										agentId: command.agentId,
										conversationId: command.conversationId,
										sessionGeneration: command.sessionGeneration,
										nativeSessionRef: ref,
										executionId: command.executionId,
										turnId: command.turnId,
										operationId: "stop-blocked-tool",
									}),
							new Promise<never>((_, reject) => {
								timer = setTimeout(
									() => reject(Error("Gate did not wake on retirement")),
									1_000,
								);
							}),
						]);
					} finally {
						clearTimeout(timer);
					}
					expect(continuationSettled).toBe(true);
					expect(requests()).toBe(1);
				},
			);
		} finally {
			releaseRead();
			spy.mockRestore();
		}
	},
);

it("does not turn a confirmed Claude tool result into unknown when stop retires its model continuation", async () => {
	let proceed = () => {};
	const ready = new Promise<void>((resolve) => {
		proceed = resolve;
	});
	let continuation: Promise<unknown> | undefined;
	try {
		await withClaudeSource(
			async function* (request, options) {
				const first = await request();
				await first.text();
				await ready;
				const permission = await options.canUseTool?.(
					"Write",
					{ file_path: join(String(options.cwd), "synthetic.txt") },
					{
						signal: new AbortController().signal,
						toolUseID: "confirmed-tool",
						requestId: "confirmed-tool-request",
					},
				);
				expect(permission?.behavior).toBe("allow");
				yield {
					type: "stream_event",
					session_id: options.sessionId,
					parent_tool_use_id: null,
					event: {
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "tool_use",
							id: "confirmed-tool",
							name: "Write",
							input: {},
						},
					},
				} as SDKMessage;
				continuation = request().then(
					(response) => response.text(),
					() => "closed",
				);
				yield {
					type: "user",
					session_id: options.sessionId,
					parent_tool_use_id: null,
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "confirmed-tool",
								content: "ok",
							},
						],
					},
				} as SDKMessage;
				await continuation;
			},
			(action, driver) => driver.validateExternalAction(action),
			async ({ driver, ref, command, requests }) => {
				const waiters = (
					driver as unknown as {
						waiters: Map<string, Set<() => void>>;
					}
				).waiters;
				const held = new Set<() => void>();
				let released = false;
				const iterate = held[Symbol.iterator].bind(held);
				Object.defineProperty(held, Symbol.iterator, {
					value: () => (released ? iterate() : [][Symbol.iterator]()),
				});
				waiters.set(ref, held);
				proceed();
				await vi.waitFor(() => expect(continuation).toBeDefined());
				await vi.waitFor(async () => {
					const events = await driver.replayEvents(ref, command.executionId);
					expect(
						events.some(
							(event) =>
								event.type === "tool" && event.payload.phase === "completed",
						),
					).toBe(true);
				});
				expect(requests()).toBe(1);
				const stop = driver.execute({
					schemaVersion: 1,
					kind: "stop",
					agentId: command.agentId,
					conversationId: command.conversationId,
					sessionGeneration: command.sessionGeneration,
					nativeSessionRef: ref,
					executionId: command.executionId,
					turnId: command.turnId,
					operationId: "stop-confirmed-tool",
				});
				try {
					await vi.waitFor(() =>
						expect(
							(
								driver as unknown as {
									handles: Map<string, { retiring: boolean }>;
								}
							).handles.get(ref)?.retiring,
						).toBe(true),
					);
				} finally {
					released = true;
					for (const wake of held) wake();
				}
				await stop;
				expect(await driver.getStatus(ref, command.executionId)).toBe(
					"cancelled",
				);
				expect(requests()).toBe(1);
			},
		);
	} finally {
		proceed();
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
		authorizeExternalAction: async (
			action: RuntimeExternalActionAuthorization,
		) => {
			await driver.validateExternalAction(action);
			return { relayKey: "synthetic-model-credential" };
		},
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
