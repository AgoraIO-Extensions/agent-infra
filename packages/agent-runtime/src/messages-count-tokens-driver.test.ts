import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import {
	claudeCommand,
	completeClaudeResponse,
} from "./claude-native.test-support.js";
import { ClaudeRuntimeDriver } from "./claude-runtime-driver.js";
import type { RuntimeExternalActionAuthorization } from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

// A source-boundary regression, not proof that pinned Claude emits a count request.
const source = vi.hoisted(() => ({ run: async (_options: Options) => {} }));
vi.mock("./claude-query.js", () => ({
	claudeQuery: (options: Options) => ({
		query: (async function* () {
			await source.run(options);
			yield {
				type: "result",
				subtype: "success",
				is_error: false,
				session_id: options.sessionId,
			};
		})(),
		close: async () => {},
	}),
}));

it.each(["claude", "shared"] as const)(
	"%s keeps generation identity and receipt separate across auxiliary count requests and restart",
	async (kind) => {
		const path = await mkdtemp(join(tmpdir(), "messages-count-facts-"));
		const command = claudeCommand();
		let stateFile = "";
		let requests = 0;
		const readState = async () => {
			const state = JSON.parse(await readFile(stateFile, "utf8"));
			const facts: RuntimeOperationFactV2[] = state.turns[0].events.flatMap(
				(event: { type: string; payload: RuntimeOperationFactV2 }) =>
					event.type === "operation" ? [event.payload] : [],
			);
			return { state, facts };
		};
		const server = createServer(async (request, response) => {
			try {
				for await (const _chunk of request) {
					/* Drain the synthetic body. */
				}
				const { facts } = await readState();
				// Actual upstream observes the committed per-request intent before answering.
				const current = request.url?.includes("count_tokens")
					? facts.at(-1)
					: facts.findLast(
							(fact) => fact.operationRef === facts[0]?.operationRef,
						);
				expect(current?.phase).toMatch(/intent|started/);
				requests++;
				if (request.url?.includes("count_tokens"))
					response.end('{"input_tokens":123}');
				else
					completeClaudeResponse(response, `msg_${requests}`, "claude-opus-5");
			} catch {
				response.writeHead(500).end();
			}
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw Error();
		const modelOptions = [
			{
				modelOptionId: "option-one",
				model: "claude-opus-5",
				nativeModelId: "claude-opus-5",
				reasoningLevels: ["high"],
				endpoint: `http://127.0.0.1:${address.port}`,
				credential: "synthetic-credential",
				authentication: "bearer" as const,
			},
		] as const;
		const base = {
			path,
			configVersion: "config-one",
			defaultModelOptionId: "option-one",
			defaultReasoningLevel: "high",
			modelOptions,
		};
		const program = async (endpoint: string, credential: string) => {
			const request = async (counting: boolean) => {
				const response = await fetch(
					`${endpoint}/v1/messages${counting ? "/count_tokens" : ""}`,
					{
						method: "POST",
						headers: { authorization: `Bearer ${credential}` },
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
				);
				expect(response.ok).toBe(true);
				await response.text();
			};
			await request(true);
			let durable = await readState();
			expect(durable.state.turns[0].modelResponse).toBeUndefined();
			expect(durable.facts[0]?.phase).toBe("intent");
			await request(false);
			await request(true);
			durable = await readState();
			if (kind === "claude")
				expect(durable.state.turns[0].modelResponse).toEqual({
					state: "completed",
					endTurn: true,
				});
			await request(false);
			await request(true);
		};
		const open = async () => {
			if (kind === "claude") {
				const driver = await ClaudeRuntimeDriver.open({
					...base,
					authorizeExternalAction: (action) =>
						driver.validateExternalAction(action),
				});
				return driver;
			}
			const sharedDriver = await SessionRuntimeDriver.open({
				...base,
				authorizeExternalAction: (action) =>
					sharedDriver.validateExternalAction(action),
				cursorPrefix: "count-test",
				modelLifecycleAtTransport: true,
				retireSession: async () => {},
				completionStatus: () => "completed",
				openSession: async (callbacks) => {
					stateFile = join(callbacks.directory, "state.json");
					const transport = await openRuntimeMessagesTransport({
						...modelOptions[0],
						effort: "high",
						admit: callbacks.admit,
						beforeSend: callbacks.modelRequestIntent,
						started: callbacks.modelRequestStarted,
						receipt: async (state, _endTurn, usage) => {
							if (state !== "sent")
								await callbacks.modelRequestFinished?.(state, usage);
						},
					});
					return {
						nativeId: callbacks.nativeId ?? randomUUID(),
						select: async () => {},
						prompt: async () => {
							await program(
								transport.modelAccess.endpoint,
								transport.modelAccess.credential,
							);
							return { stopReason: "end_turn" };
						},
						cancel: async () => {},
						close: () => transport.close(),
					};
				},
			});
			return sharedDriver;
		};
		source.run = async (options) => {
			// The production Query cwd is in the same durable Session directory.
			stateFile = join(String(options.cwd), "..", "state.json");
			await program(
				String(options.env?.ANTHROPIC_BASE_URL),
				String(options.env?.ANTHROPIC_AUTH_TOKEN),
			);
		};
		let driver = await open();
		try {
			const accepted = await driver.execute(command);
			stateFile = join(path, accepted.nativeSessionRef, "state.json");
			// Five sequential HTTP requests each commit durable operation facts before completion.
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
			const { state, facts } = await readState();
			const generation = facts.filter(
				(fact) => fact.operationRef === facts[0]?.operationRef,
			);
			expect(generation.map((fact) => fact.phase)).toEqual([
				"intent",
				"started",
				"completed",
				"intent",
				"started",
				"completed",
			]);
			expect(generation[0]?.attemptRef).not.toBe(generation[3]?.attemptRef);
			const counts = facts.filter(
				(fact) => fact.operationRef !== facts[0]?.operationRef,
			);
			expect(new Set(counts.map((fact) => fact.operationRef)).size).toBe(3);
			expect(counts.map((fact) => fact.phase)).toEqual([
				"intent",
				"started",
				"completed",
				"intent",
				"started",
				"completed",
				"intent",
				"started",
				"completed",
			]);
			expect(
				counts.every(
					(fact) => fact.kind === "model" && fact.usage === undefined,
				),
			).toBe(true);
			expect(requests).toBe(5);
			await driver.close();
			// Simulate a crash snapshot with earlier generation and two auxiliary attempts still pending.
			state.turns[0].status = "running";
			delete state.turns[0].modelResponse;
			const pendingRefs = [
				generation[0]?.operationRef,
				counts[0]?.operationRef,
				counts[3]?.operationRef,
			];
			state.turns[0].events = state.turns[0].events.filter(
				(event: { type: string; payload: RuntimeOperationFactV2 }) =>
					event.type !== "completed" &&
					!(
						event.type === "operation" &&
						pendingRefs.includes(event.payload.operationRef) &&
						event.payload.phase === "completed"
					),
			);
			state.sequence = state.turns[0].events.length;
			await writeFile(stateFile, JSON.stringify(state));
			driver = await open();
			expect(
				await driver.getStatus(accepted.nativeSessionRef, command.executionId),
			).toBe("unknown");
			const recovered = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			for (const operationRef of pendingRefs)
				expect(
					recovered.findLast(
						(event) =>
							event.type === "operation" &&
							event.payload.operationRef === operationRef,
					),
				).toMatchObject({
					payload: { phase: "unknown", failureCode: "recovery_unconfirmed" },
				});
			await driver.close();
			driver = await open();
			expect(
				await driver.replayEvents(
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toEqual(recovered);
			expect(await driver.execute(command)).toEqual(accepted);
			expect(requests).toBe(5);
		} finally {
			await driver.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(path, { recursive: true, force: true });
		}
	},
	15000,
);

it.each(["claude", "shared"] as const)(
	"%s preserves a confirmed count failure and completes the subsequent generation without a retry",
	async (kind) => {
		await withCountDriver(
			kind,
			async (request) => {
				const count = await request();
				expect(count.ok).toBe(false);
				await count.text();
				const generation = await request(false);
				expect(generation.ok).toBe(true);
				await generation.text();
			},
			async ({ driver, command, ref, stateFile, requests, reopen }) => {
				await vi.waitFor(async () =>
					expect(await driver.getStatus(ref, command.executionId)).toBe(
						"completed",
					),
				);
				await driver.close();
				const events = await driver.replayEvents(ref, command.executionId);
				const facts = events.flatMap((event) =>
					event.type === "operation" ? [event.payload] : [],
				);
				const count = facts.filter(
					(fact) => fact.operationRef !== facts[0]?.operationRef,
				);
				expect(count.map((fact) => fact.phase)).toEqual([
					"intent",
					"started",
					"failed",
				]);
				expect(
					count.every((fact) => fact.kind === "model" && !fact.usage),
				).toBe(true);
				expect(
					facts.findLast(
						(fact) => fact.operationRef === facts[0]?.operationRef,
					),
				).toMatchObject({
					phase: "completed",
					usage: { inputTokens: 10, outputTokens: 2 },
				});
				const state = JSON.parse(await readFile(stateFile, "utf8"));
				expect(state.turns[0].nativeResult).toMatchObject({
					status: "completed",
				});
				expect(state.turns[0].nativeResult.failure).toBeUndefined();
				expect(requests()).toBe(2);
				const recovered = await reopen();
				try {
					expect(await recovered.getStatus(ref, command.executionId)).toBe(
						"completed",
					);
					expect(
						await recovered.replayEvents(ref, command.executionId),
					).toEqual(events);
					expect(await recovered.execute(command)).toMatchObject({
						nativeSessionRef: ref,
						result: { outcome: "accepted" },
					});
					expect(requests()).toBe(2);
				} finally {
					await recovered.close();
				}
			},
			false,
			true,
			403,
		);
	},
);

it.each(["claude", "shared"] as const)(
	"%s rejects a new generation at the durable native result before terminal persistence",
	async (kind) => {
		let pending: Promise<unknown> | undefined;
		let send = async (_counting?: boolean): Promise<Response> => {
			throw Error("Native request unavailable");
		};
		let pauseTerminal = false;
		let paused = false;
		let resume = () => {};
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const update = DurableJsonFile.prototype.update;
		const spy = vi.spyOn(DurableJsonFile.prototype, "update");
		spy.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
			const stack = new Error().stack;
			if (
				pauseTerminal &&
				stack?.includes(".status") &&
				stack.includes(".modelPhase")
			) {
				pauseTerminal = false;
				paused = true;
				// Keep the final status caller outside the lock while allowing another request to contend.
				return gate.then(() => update.call(this, change));
			}
			return update.call(this, change);
		});
		try {
			await withCountDriver(
				kind,
				async (request, stateFile) => {
					send = request;
					pending = request().then((response) => response.text());
					await vi.waitFor(async () => {
						const state = JSON.parse(await readFile(stateFile, "utf8"));
						expect(state.turns[0].events.at(-1)?.payload.phase).toBe("started");
					});
				},
				async ({ stateFile, requests, dispatches, release }) => {
					try {
						await vi.waitFor(async () => {
							const state = JSON.parse(await readFile(stateFile, "utf8"));
							expect(state.turns[0].nativeResult?.status).toBe("completed");
						});
						pauseTerminal = true;
						release();
						await pending;
						await vi.waitFor(() => expect(paused).toBe(true));
						const next = await send(false);
						expect(next.status).toBe(400);
						await next.text();
						expect(requests()).toBe(1);
						expect(dispatches()).toBe(1);
					} finally {
						resume();
					}
				},
				true,
			);
		} finally {
			resume();
			spy.mockRestore();
		}
	},
);

async function withCountDriver(
	kind: "claude" | "shared",
	program: (
		request: (counting?: boolean) => Promise<Response>,
		stateFile: string,
	) => Promise<void>,
	verify: (context: {
		driver: ClaudeRuntimeDriver | SessionRuntimeDriver;
		command: ReturnType<typeof claudeCommand>;
		ref: string;
		stateFile: string;
		requests: () => number;
		dispatches: () => number;
		release: () => void;
		reopen: () => Promise<ClaudeRuntimeDriver | SessionRuntimeDriver>;
	}) => Promise<void>,
	holdResponse = false,
	checkpointed = true,
	upstreamStatus = 200,
	authorize?:
		| false
		| ((
				action: RuntimeExternalActionAuthorization,
				driver: ClaudeRuntimeDriver | SessionRuntimeDriver,
		  ) => Promise<void>),
) {
	const path = await mkdtemp(join(tmpdir(), "count-admission-"));
	let requests = 0;
	let release = () => {};
	const responseGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {
			/* Drain the synthetic body. */
		}
		requests++;
		if (holdResponse) await responseGate;
		if (request.url?.includes("count_tokens"))
			response.writeHead(upstreamStatus).end('{"input_tokens":123}');
		else completeClaudeResponse(response, `msg_${requests}`, "claude-opus-5");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw Error();
	const option = {
		modelOptionId: "option-one",
		model: "claude-opus-5",
		nativeModelId: "claude-opus-5",
		reasoningLevels: ["high"],
		endpoint: `http://127.0.0.1:${address.port}`,
		credential: "synthetic-credential",
		authentication: "bearer" as const,
	};
	const base = {
		path,
		configVersion: "config-one",
		defaultModelOptionId: "option-one",
		defaultReasoningLevel: "high",
		modelOptions: [option],
	};
	let dispatches = 0;
	const upstreamFetch = fetch;
	const fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation((url, init) => {
			if (String(url).startsWith(option.endpoint)) dispatches++;
			return upstreamFetch(url, init);
		});
	const run = (endpoint: string, credential: string, stateFile: string) =>
		program(
			(counting = true) =>
				fetch(`${endpoint}/v1/messages${counting ? "/count_tokens" : ""}`, {
					method: "POST",
					headers: { authorization: `Bearer ${credential}` },
					body: JSON.stringify({
						model: option.model,
						messages: [],
						...(!counting
							? {
									stream: true,
									thinking: { type: "adaptive" },
									output_config: { effort: "high" },
								}
							: {}),
					}),
				}),
			stateFile,
		);
	source.run = (options) =>
		run(
			String(options.env?.ANTHROPIC_BASE_URL),
			String(options.env?.ANTHROPIC_AUTH_TOKEN),
			join(String(options.cwd), "..", "state.json"),
		);
	const open = async () => {
		if (kind === "claude") {
			const driver = await ClaudeRuntimeDriver.open({
				...base,
				authorizeExternalAction:
					authorize === false
						? undefined
						: async (action) => {
								await driver.validateExternalAction(action);
								await authorize?.(action, driver);
							},
			});
			return driver;
		}
		const sharedDriver = await SessionRuntimeDriver.open({
			...base,
			// This controlled fixture validates the durable action; production uses Host authority.
			authorizeExternalAction:
				authorize === false
					? undefined
					: async (action) => {
							await sharedDriver.validateExternalAction(action);
							await authorize?.(action, sharedDriver);
						},
			cursorPrefix: "count-admission",
			modelLifecycleAtTransport: true,
			retireSession: async () => {},
			completionStatus: () => "completed",
			openSession: async (callbacks) => {
				let checkpoint = callbacks.history?.checkpoint ?? "count-before";
				const transport = await openRuntimeMessagesTransport({
					...option,
					effort: "high",
					admit: callbacks.admit,
					beforeSend: callbacks.modelRequestIntent,
					started: callbacks.modelRequestStarted,
					receipt: async (state, _endTurn, usage) => {
						if (state !== "sent")
							await callbacks.modelRequestFinished?.(state, usage);
					},
				});
				return {
					nativeId: callbacks.nativeId ?? randomUUID(),
					select: async () => {},
					...(checkpointed ? { checkpoint: async () => checkpoint } : {}),
					prompt: async () => {
						await run(
							transport.modelAccess.endpoint,
							transport.modelAccess.credential,
							join(callbacks.directory, "state.json"),
						);
						checkpoint = "count-after";
						return {
							stopReason: "end_turn",
							...(checkpointed ? { checkpoint } : {}),
						};
					},
					cancel: async () => {},
					close: () => transport.close(),
				};
			},
		});
		return sharedDriver;
	};
	const driver = await open();
	const command = claudeCommand();
	try {
		const accepted = await driver.execute(command);
		await verify({
			driver,
			command,
			ref: accepted.nativeSessionRef,
			stateFile: join(path, accepted.nativeSessionRef, "state.json"),
			requests: () => requests,
			dispatches: () => dispatches,
			release,
			reopen: open,
		});
	} finally {
		release();
		try {
			await driver.close();
		} finally {
			fetchSpy.mockRestore();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(path, { recursive: true, force: true });
		}
	}
}

it.each([
	["claude", "terminal"],
	["shared", "terminal"],
	["claude", "current_turn"],
	["shared", "current_turn"],
] as const)(
	"%s sends zero count requests after a queued %s admission race",
	async (kind, race) => {
		let injectRace = false;
		const update = DurableJsonFile.prototype.update;
		const spy = vi.spyOn(DurableJsonFile.prototype, "update");
		spy.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
			if (injectRace && new Error().stack?.includes("modelRequestIntent")) {
				injectRace = false;
				// Commit the competing transition ahead of the queued count intent.
				// The intent callback has already read the old, active Turn.
				void update.call(this, (draft) => {
					const state = draft as {
						turns: {
							status: string;
							executionId: string;
							turnId: string;
							events: unknown[];
						}[];
					};
					const turn = state.turns[0];
					if (!turn) throw new Error("Missing competing Turn");
					if (race === "terminal") turn.status = "completed";
					else
						state.turns.push({
							...structuredClone(turn),
							executionId: randomUUID(),
							turnId: randomUUID(),
							events: [],
						});
				});
			}
			return update.call(this, change);
		});
		let responseStatus = 0;
		try {
			await withCountDriver(
				kind,
				async (request) => {
					injectRace = true;
					const response = await request();
					responseStatus = response.status;
					await response.text();
				},
				async ({ stateFile, requests, dispatches }) => {
					await vi.waitFor(() => expect(responseStatus).not.toBe(0));
					expect(dispatches()).toBe(0);
					expect(responseStatus).toBe(400);
					expect(requests()).toBe(0);
					const state = JSON.parse(await readFile(stateFile, "utf8"));
					if (race === "terminal")
						expect(state.turns[0].status).toBe("completed");
					const facts: RuntimeOperationFactV2[] = state.turns[0].events
						.filter((event: { type: string }) => event.type === "operation")
						.map((event: { payload: RuntimeOperationFactV2 }) => event.payload);
					expect(
						facts.filter(
							(fact) => fact.operationRef !== facts[0]?.operationRef,
						),
					).toEqual([]);
				},
			);
		} finally {
			spy.mockRestore();
		}
	},
);

it.each([
	["claude", false],
	["shared", false],
	["shared", true],
] as const)(
	"%s retains native proof with checkpoint %s and automatically completes after count",
	async (kind, checkpointed) => {
		let pending: Promise<unknown> | undefined;
		await withCountDriver(
			kind,
			async (request, stateFile) => {
				pending = request().then(
					(response) => response.text(),
					() => undefined,
				);
				await vi.waitFor(async () => {
					const state = JSON.parse(await readFile(stateFile, "utf8"));
					expect(state.turns[0].events.at(-1)?.payload.phase).toBe("started");
				});
				// Native completion races the in-flight auxiliary request.
			},
			async ({
				driver,
				command,
				ref,
				stateFile,
				requests,
				release,
				reopen,
			}) => {
				await vi.waitFor(async () => {
					const state = JSON.parse(await readFile(stateFile, "utf8"));
					expect(state.turns[0].nativeResult).toMatchObject({
						status: "completed",
					});
					if (kind === "shared")
						expect(state.turns[0].nativeResult).toMatchObject({
							stopReason: "end_turn",
							...(checkpointed ? { checkpoint: "count-after" } : {}),
						});
				});
				expect(await driver.getStatus(ref, command.executionId)).toBe(
					"running",
				);
				release();
				await pending;
				await vi.waitFor(async () =>
					expect(await driver.getStatus(ref, command.executionId)).toBe(
						"completed",
					),
				);
				await vi.waitFor(async () => {
					const state = JSON.parse(await readFile(stateFile, "utf8"));
					const facts: RuntimeOperationFactV2[] = state.turns[0].events
						.filter((event: { type: string }) => event.type === "operation")
						.map((event: { payload: RuntimeOperationFactV2 }) => event.payload);
					const count = facts.filter(
						(fact) => fact.operationRef !== facts[0]?.operationRef,
					);
					expect(count.map((fact) => fact.phase)).toEqual([
						"intent",
						"started",
						"completed",
					]);
					expect(
						count.every(
							(fact) => fact.kind === "model" && fact.usage === undefined,
						),
					).toBe(true);
					expect(
						state.turns[0].events.some(
							(event: { type: string }) => event.type === "completed",
						),
					).toBe(true);
					if (kind === "shared") {
						expect(state.turns[0].nativeStopReason).toBe("end_turn");
						expect(state.turns[0].nativeTerminalCheckpoint).toBe(
							checkpointed ? "count-after" : undefined,
						);
					}
				});
				expect(requests()).toBe(1);
				await driver.close();
				const events = await driver.replayEvents(ref, command.executionId);
				const recovered = await reopen();
				try {
					expect(await recovered.getStatus(ref, command.executionId)).toBe(
						"completed",
					);
					expect(
						await recovered.replayEvents(ref, command.executionId),
					).toEqual(events);
					expect(requests()).toBe(1);
				} finally {
					await recovered.close();
				}
				// Crash after count completion and durable native proof, before Turn terminal.
				const snapshot = JSON.parse(await readFile(stateFile, "utf8"));
				snapshot.turns[0].status = "running";
				delete snapshot.turns[0].nativeStopReason;
				delete snapshot.turns[0].nativeTerminalCheckpoint;
				snapshot.turns[0].events = snapshot.turns[0].events.filter(
					(event: { type: string }) => event.type !== "completed",
				);
				snapshot.sequence = snapshot.turns[0].events.length;
				await writeFile(stateFile, JSON.stringify(snapshot));
				let converged: Awaited<ReturnType<typeof driver.replayEvents>> = [];
				const afterCrash = await reopen();
				try {
					expect(await afterCrash.getStatus(ref, command.executionId)).toBe(
						"completed",
					);
					converged = await afterCrash.replayEvents(ref, command.executionId);
					expect(converged.slice(0, -1)).toEqual(events.slice(0, -1));
					expect(converged.at(-1)).toMatchObject({
						type: "completed",
						payload: { status: "completed" },
					});
					expect(requests()).toBe(1);
				} finally {
					await afterCrash.close();
				}
				const again = await reopen();
				try {
					expect(await again.replayEvents(ref, command.executionId)).toEqual(
						converged,
					);
					expect(requests()).toBe(1);
				} finally {
					await again.close();
				}
			},
			true,
			checkpointed,
		);
	},
);

it.each([
	["claude", "close"],
	["shared", "close"],
	["claude", "failed"],
	["shared", "failed"],
] as const)(
	"%s preserves native proof after %s count without a forged completion or resend",
	async (kind, mode) => {
		let pending: Promise<unknown> | undefined;
		await withCountDriver(
			kind,
			async (request, stateFile) => {
				pending = request().then(
					(response) => response.text(),
					() => undefined,
				);
				await vi.waitFor(async () => {
					const state = JSON.parse(await readFile(stateFile, "utf8"));
					expect(state.turns[0].events.at(-1)?.payload.phase).toBe("started");
				});
			},
			async ({
				driver,
				command,
				ref,
				stateFile,
				requests,
				reopen,
				release,
			}) => {
				await vi.waitFor(async () => {
					const state = JSON.parse(await readFile(stateFile, "utf8"));
					expect(state.turns[0].nativeResult?.status).toBe("completed");
				});
				if (mode === "failed") {
					release();
					await pending;
					await vi.waitFor(async () =>
						expect(await driver.getStatus(ref, command.executionId)).toBe(
							"completed",
						),
					);
				}
				await driver.close();
				await pending;
				const state = JSON.parse(await readFile(stateFile, "utf8"));
				expect(state.turns[0].status).toBe(
					mode === "failed" ? "completed" : "unknown",
				);
				expect(state.turns[0].nativeResult).toMatchObject({
					status: "completed",
				});
				if (kind === "shared")
					expect(state.turns[0].nativeResult).toMatchObject({
						stopReason: "end_turn",
						checkpoint: "count-after",
					});
				const events = await driver.replayEvents(ref, command.executionId);
				const facts = events.flatMap((event) =>
					event.type === "operation" ? [event.payload] : [],
				);
				expect(
					facts
						.filter((fact) => fact.operationRef !== facts[0]?.operationRef)
						.map((fact) => fact.phase),
				).toEqual([
					"intent",
					"started",
					mode === "failed" ? "failed" : "unknown",
				]);
				expect(events.some((event) => event.type === "completed")).toBe(
					mode === "failed",
				);
				expect(requests()).toBe(1);
				for (let restart = 0; restart < 2; restart++) {
					const recovered = await reopen();
					try {
						expect(await recovered.getStatus(ref, command.executionId)).toBe(
							mode === "failed" ? "completed" : "unknown",
						);
						expect(
							await recovered.replayEvents(ref, command.executionId),
						).toEqual(events);
						expect(await recovered.execute(command)).toMatchObject({
							nativeSessionRef: ref,
							result: { outcome: "accepted" },
						});
						expect(requests()).toBe(1);
					} finally {
						await recovered.close();
					}
				}
			},
			true,
			true,
			mode === "failed" ? 403 : 200,
		);
	},
);

it.each([
	["claude", false],
	["shared", false],
	["claude", true],
	["shared", true],
] as const)(
	"%s settles an unsent denied count with receipt failure %s before native completion, stop, close and restart",
	async (kind, receiptFailure) => {
		let responseStatus = 0;
		let allowTerminal = false;
		let releaseNative = () => {};
		const nativeGate = new Promise<void>((resolve) => {
			releaseNative = resolve;
		});
		let gateCalls = 0;
		let injectFailure = false;
		const update = DurableJsonFile.prototype.update;
		const spy = vi.spyOn(DurableJsonFile.prototype, "update");
		spy.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
			if (injectFailure && new Error().stack?.includes("modelPhase")) {
				injectFailure = false;
				return Promise.reject(
					new Error("Synthetic denied receipt save failure"),
				);
			}
			return update.call(this, change);
		});
		try {
			await withCountDriver(
				kind,
				async (request) => {
					const generated = await request(false);
					expect(generated.ok).toBe(true);
					await generated.text();
					const denied = await request();
					responseStatus = denied.status;
					await denied.text();
					await nativeGate;
					// On a red verdict, leave through the source error path so cleanup cannot hang.
					if (!allowTerminal) throw new Error("Synthetic test cleanup");
				},
				async ({
					driver,
					command,
					ref,
					stateFile,
					requests,
					dispatches,
					reopen,
				}) => {
					try {
						await vi.waitFor(() => expect(responseStatus).toBe(400));
						const facts = (
							await driver.replayEvents(ref, command.executionId)
						).flatMap((event) =>
							event.type === "operation" ? [event.payload] : [],
						);
						const generation = facts[0]?.operationRef;
						const counts = facts.filter(
							(fact) => fact.operationRef !== generation,
						);
						expect(counts.map((fact) => fact.phase)).toEqual([
							"intent",
							receiptFailure ? "unknown" : "failed",
						]);
						expect(counts.at(-1)).toMatchObject({
							failureCode: receiptFailure
								? "recovery_unconfirmed"
								: "authorization_denied",
						});
						expect(counts.at(-1)?.startedAt).toBeUndefined();
						expect(counts.at(-1)?.durationMs).toBeUndefined();
						expect(new Set(counts.map((fact) => fact.attemptRef)).size).toBe(1);
						expect(gateCalls).toBe(2);
						expect(requests()).toBe(1);
						expect(dispatches()).toBe(1);
						allowTerminal = true;
						releaseNative();
						await vi.waitFor(async () => {
							const state = JSON.parse(await readFile(stateFile, "utf8"));
							expect(state.turns[0].nativeResult?.status).toBe("completed");
						});
						await vi.waitFor(async () =>
							expect(await driver.getStatus(ref, command.executionId)).toBe(
								receiptFailure ? "unknown" : "completed",
							),
						);
						const liveEvents = await driver.replayEvents(
							ref,
							command.executionId,
						);
						expect(
							liveEvents.filter((event) => event.type === "completed"),
						).toHaveLength(receiptFailure ? 0 : 1);
						if (!receiptFailure) {
							const stopped = await driver.execute({
								schemaVersion: 1,
								kind: "stop",
								agentId: command.agentId,
								conversationId: command.conversationId,
								executionId: command.executionId,
								turnId: command.turnId,
								sessionGeneration: command.sessionGeneration,
								nativeSessionRef: ref,
								operationId: "stop-after-denied-count",
							});
							expect(stopped.result).toMatchObject({
								outcome: "accepted",
								status: "completed",
							});
						}
						let closed = false;
						const closing = driver.close().then(() => {
							closed = true;
						});
						await vi.waitFor(() => expect(closed).toBe(true));
						await closing;
						const events = await driver.replayEvents(ref, command.executionId);
						expect(
							events.filter((event) => event.type === "operation"),
						).toEqual(liveEvents.filter((event) => event.type === "operation"));
						const recovered = await reopen();
						try {
							expect(await recovered.execute(command)).toMatchObject({
								nativeSessionRef: ref,
								result: { outcome: "accepted" },
							});
							expect(await recovered.getStatus(ref, command.executionId)).toBe(
								receiptFailure ? "unknown" : "completed",
							);
							expect(
								await recovered.replayEvents(ref, command.executionId),
							).toEqual(events);
							expect(requests()).toBe(1);
							expect(dispatches()).toBe(1);
						} finally {
							await recovered.close();
						}
					} finally {
						releaseNative();
					}
				},
				false,
				true,
				200,
				async () => {
					gateCalls++;
					if (gateCalls > 1) {
						injectFailure = receiptFailure;
						throw new Error("RUNTIME_AUTHORIZATION_DENIED");
					}
				},
			);
		} finally {
			spy.mockRestore();
		}
	},
);

it.each([
	["first", "revoked"],
	["continuation", "revoked"],
	["count_tokens", "revoked"],
	["first", "missing"],
	["count_tokens", "missing"],
] as const)(
	"shared prevents %s model dispatch with %s current authority",
	async (requestKind, authority) => {
		let responseStatus = 0;
		let gateCalls = 0;
		let receiptReturned = false;
		const actions: RuntimeExternalActionAuthorization[] = [];
		await withCountDriver(
			"shared",
			async (request) => {
				if (requestKind === "continuation") {
					const first = await request(false);
					expect(first.ok).toBe(true);
					await first.text();
				}
				const denied = await request(requestKind === "count_tokens");
				responseStatus = denied.status;
				await denied.text();
				throw new Error("Native request denied");
			},
			async ({ command, ref, stateFile, requests, dispatches }) => {
				receiptReturned = true;
				await vi.waitFor(() => expect(responseStatus).not.toBe(0));
				expect(responseStatus).toBe(400);
				const permittedRequests = requestKind === "continuation" ? 1 : 0;
				expect(requests()).toBe(permittedRequests);
				expect(dispatches()).toBe(permittedRequests);
				expect(gateCalls).toBe(
					authority === "missing" ? 0 : permittedRequests + 1,
				);
				const state = JSON.parse(await readFile(stateFile, "utf8"));
				expect(state.binding.ref).toBe(ref);
				expect(state.operations[0].record.operationId).toBe(
					command.operationId,
				);
				const facts: RuntimeOperationFactV2[] = state.turns[0].events.flatMap(
					(event: { type: string; payload: RuntimeOperationFactV2 }) =>
						event.type === "operation" ? [event.payload] : [],
				);
				const deniedIntent = facts.findLast((fact) => fact.phase === "intent");
				expect(deniedIntent).toMatchObject({ kind: "model", phase: "intent" });
				expect(deniedIntent?.startedAt).toBeUndefined();
				expect(
					facts
						.filter(
							(fact) =>
								fact.operationRef === deniedIntent?.operationRef &&
								fact.attemptRef === deniedIntent?.attemptRef,
						)
						.map((fact) => fact.phase),
				).not.toContain("started");
				expect(deniedIntent?.operationRef === facts[0]?.operationRef).toBe(
					requestKind !== "count_tokens",
				);
				if (requestKind === "continuation")
					expect(deniedIntent?.attemptRef).not.toBe(facts[0]?.attemptRef);
				if (authority !== "missing") {
					const action = actions.at(-1);
					expect(action).toEqual({
						nativeSessionRef: ref,
						executionId: command.executionId,
						runtimeOperationId: command.operationId,
						operationRef: deniedIntent?.operationRef,
						attemptRef: deniedIntent?.attemptRef,
						kind: "model",
					});
				}
			},
			false,
			true,
			200,
			authority === "missing"
				? false
				: async (action, driver) => {
						gateCalls++;
						expect(receiptReturned).toBe(true);
						await expect(
							driver.validateExternalAction(action),
						).resolves.toBeUndefined();
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
						if (requestKind !== "continuation" || gateCalls > 1)
							throw new Error("RUNTIME_AUTHORIZATION_DENIED");
					},
		);
	},
);

it("shared prevents model dispatch and authority checks when durable request intent fails", async () => {
	let injectFailure = false;
	let responseStatus = 0;
	let gateCalls = 0;
	const update = DurableJsonFile.prototype.update;
	const spy = vi.spyOn(DurableJsonFile.prototype, "update");
	spy.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
		if (injectFailure && new Error().stack?.includes("modelRequestIntent")) {
			injectFailure = false;
			return Promise.reject(new Error("Synthetic durable intent failure"));
		}
		return update.call(this, change);
	});
	try {
		await withCountDriver(
			"shared",
			async (request) => {
				injectFailure = true;
				const denied = await request();
				responseStatus = denied.status;
				await denied.text();
				throw new Error("Native request denied");
			},
			async ({ driver, command, ref, stateFile, requests, dispatches }) => {
				await vi.waitFor(() => expect(responseStatus).not.toBe(0));
				expect(responseStatus).toBe(400);
				expect(requests()).toBe(0);
				expect(dispatches()).toBe(0);
				expect(gateCalls).toBe(0);
				await vi.waitFor(async () => {
					const events = await driver.replayEvents(ref, command.executionId);
					expect(
						events.filter((event) => event.type === "operation").at(-1)?.payload
							.phase,
					).toBe("unknown");
				});
				const state = JSON.parse(await readFile(stateFile, "utf8"));
				const facts: RuntimeOperationFactV2[] = state.turns[0].events.flatMap(
					(event: { type: string; payload: RuntimeOperationFactV2 }) =>
						event.type === "operation" ? [event.payload] : [],
				);
				expect(
					facts.every((fact) => fact.operationRef === facts[0]?.operationRef),
				).toBe(true);
				expect(facts.map((fact) => fact.phase)).toEqual(["intent", "unknown"]);
			},
			false,
			true,
			200,
			async () => {
				gateCalls++;
			},
		);
	} finally {
		spy.mockRestore();
	}
});
