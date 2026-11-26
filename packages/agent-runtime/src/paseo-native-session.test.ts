import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { openPaseoNativeSession } from "./paseo-native-session.js";
import { PaseoTransportError } from "./paseo-transport.js";

it.each(["stop", "revoked"])(
	"retires the original pending compact on %s before publishing a result",
	async (mode) => {
		let sent = false;
		let revoked = false;
		const admitted = Promise.withResolvers<void>();
		const cancel = vi.fn(async () => {});
		const close = vi.fn(async () => {});
		const update = vi.fn();
		const native = await openPaseoNativeSession({
			session: { runtimeSessionRef: "8a09d2ce-a488-44f8-999f-431117a1d900" },
			model: "model-a",
			close,
			beginCompact: () => {},
			hasConfirmedModelTurn: () => false,
			transport: {
				ensureAgent: vi.fn(),
				cancel,
				send: async (
					_id: string,
					_message: string,
					_text: string,
					assertCurrent: () => void,
				) => {
					assertCurrent();
					sent = true;
				},
				timeline: async () => ({
					epoch: "one",
					agent: { activeTurn: null },
					endCursor: { epoch: "one", seq: sent ? 2 : 0 },
					entries: sent
						? [
								{
									seqStart: 1,
									seqEnd: 1,
									item: {
										type: "user_message",
										clientMessageId: "compact-a",
										text: "/compact",
									},
								},
								{
									seqStart: 2,
									seqEnd: 2,
									item: {
										type: "compaction",
										status: "loading",
										trigger: "manual",
									},
								},
							]
						: [],
				}),
			},
		} as never);
		const pending = native.compact?.(
			{
				executionId: "compact-a",
				update,
				admit: async () => admitted.resolve(),
			} as never,
			{
				signal: new AbortController().signal,
				assertCurrent: () => {
					if (revoked) throw new Error("revoked");
				},
			} as never,
			() => {},
		);
		const rejected = expect(pending).rejects.toThrow();
		await admitted.promise;
		if (mode === "revoked") {
			revoked = true;
			await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		}
		await native.cancel();
		await rejected;
		if (mode === "stop")
			expect(cancel).toHaveBeenCalledWith(
				"8a09d2ce-a488-44f8-999f-431117a1d900",
			);
		expect(close).toHaveBeenCalledOnce();
		expect(update).not.toHaveBeenCalled();
	},
);

it.each([
	"manual",
	"manual-info",
	"manual-warning",
	"manual-error",
	"auto",
	"unconfirmed",
	"foreign-message",
])(
	"confirms SDK compact only after its own manual event and model receipt (%s)",
	async (mode) => {
		let sent = false;
		const update = vi.fn();
		const onSubmit = vi.fn();
		const beginCompact = vi.fn();
		const send = vi.fn(async (_id, _messageId, _text, assertCurrent) => {
			assertCurrent();
			sent = true;
		});
		const native = await openPaseoNativeSession({
			session: { runtimeSessionRef: "8a09d2ce-a488-44f8-999f-431117a1d900" },
			model: "configured/test",
			close: vi.fn(),
			beginCompact,
			hasConfirmedModelTurn: () => mode !== "unconfirmed",
			transport: {
				ensureAgent: vi.fn(),
				send,
				timeline: async () => ({
					epoch: "original",
					agent: { activeTurn: null },
					endCursor: {
						epoch: "original",
						seq: sent ? (mode.startsWith("manual-") ? 7 : 6) : 4,
					},
					entries: sent
						? [
								{
									seqStart: 5,
									seqEnd: 5,
									item: {
										type: "user_message",
										clientMessageId:
											mode === "foreign-message"
												? "foreign"
												: "execution-compact",
										text: "/compact",
									},
								},
								{
									seqStart: 6,
									seqEnd: 6,
									item: {
										type: "compaction",
										status: "completed",
										trigger: mode === "auto" ? "auto" : "manual",
									},
								},
								...(mode.startsWith("manual-")
									? [
											{
												seqStart: 7,
												seqEnd: 7,
												item: {
													type: "notification",
													level: mode.slice("manual-".length),
													message:
														"Repeated compaction can reduce model accuracy",
												},
											},
										]
									: []),
							]
						: [],
				}),
			},
		} as never);
		const pending = native.compact?.(
			{
				executionId: "execution-compact",
				update,
				admit: vi.fn(async () => {}),
			} as never,
			{ signal: new AbortController().signal, assertCurrent: vi.fn() } as never,
			onSubmit,
		);
		if (["manual", "manual-info", "manual-warning"].includes(mode)) {
			expect(await pending).toEqual({ stopReason: "stop" });
			expect(update).toHaveBeenCalledWith({
				type: "tool",
				payload: {
					toolCallId: "execution-compact",
					name: "native.compact",
					phase: "completed",
				},
			});
		} else {
			await expect(pending).rejects.toThrow("RUNTIME_ACCEPTANCE_UNKNOWN");
			expect(update).not.toHaveBeenCalled();
		}
		expect(send).toHaveBeenCalledOnce();
		expect(onSubmit).toHaveBeenCalledOnce();
		expect(beginCompact).toHaveBeenCalledOnce();
		await native.close();
	},
);

it("requires the original SDK agent on resume and never recreates an absent one", async () => {
	const id = "8a09d2ce-a488-44f8-999f-431117a1d900";
	const ensureAgent = vi.fn();
	const close = vi.fn(async () => {});
	const transport = {
		refetchAgent: vi.fn(async () => false),
		ensureAgent,
		close,
	};
	await expect(
		openPaseoNativeSession({
			session: { runtimeSessionRef: id, nativeId: `paseo:${id}` },
			model: "configured/test",
			transport,
			close,
		} as never),
	).rejects.toThrow("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	expect(transport.refetchAgent).toHaveBeenCalledWith(id);
	expect(ensureAgent).not.toHaveBeenCalled();
});

it("discovers commands through the original Paseo agent without opening a turn", async () => {
	const id = "8a09d2ce-a488-44f8-999f-431117a1d900";
	const commands = vi.fn(async () => [
		{ name: "compact", description: "Compact", argumentHint: "[instructions]" },
		{
			name: "skill:docs",
			description: "Docs",
			argumentHint: "",
			kind: "skill",
		},
	]);
	const transport = {
		ensureAgent: vi.fn(async () => {}),
		commands,
		refetchAgent: vi.fn(async () => true),
	};
	const native = await openPaseoNativeSession({
		session: { runtimeSessionRef: id },
		model: "configured/test",
		transport,
		close: vi.fn(async () => {}),
	} as never);
	const directory = await native.discoverCommands?.({
		signal: new AbortController().signal,
		expiresAt: Date.now() + 10_000,
		allowedRoots: [],
	});
	expect(directory).toMatchObject({
		nativeId: `paseo:${id}`,
		commands: [
			{ name: "compact", argumentHint: "[instructions]" },
			{ name: "skill:docs", kind: "skill" },
		],
	});
	expect(commands).toHaveBeenCalledOnce();
	expect(native.executeNativeCommand).toBeUndefined();
	await native.close();
	await expect(
		native.discoverCommands?.({
			signal: new AbortController().signal,
			expiresAt: Date.now() + 1000,
			allowedRoots: [],
		}),
	).rejects.toThrow("RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE");
	expect(commands).toHaveBeenCalledOnce();
});

it.each([true, false])(
	"binds the terminal to the original message and the confirmed model reply (%s)",
	async (confirmed) => {
		const id = "8a09d2ce-a488-44f8-999f-431117a1d900";
		const executionId = "execution-a";
		const update = vi.fn();
		let fire: (value: unknown) => void = () => {};
		const unsubscribe = vi.fn();
		let messageId = "";
		const transport = {
			ensureAgent: vi.fn(),
			subscribe: vi.fn(async (_: string, f: typeof fire) => {
				fire = f;
				return unsubscribe;
			}),
			send: vi.fn(
				async (_: string, msg: string, _text: string, onSubmit: () => void) => {
					onSubmit();
					messageId = msg;
					fire({
						agentId: id,
						event: { type: "turn_completed", turnId: "wrong" },
					});
					fire({
						agentId: id,
						event: { type: "turn_completed", turnId: "original" },
					});
				},
			),
			timeline: vi.fn(async () => ({
				agentId: id,
				epoch: "a",
				entries: [
					{
						seqStart: 1,
						turnId: "original",
						item: {
							type: "user_message",
							text: "hello",
							clientMessageId: messageId,
						},
					},
					{
						seqStart: 2,
						turnId: "wrong",
						item: { type: "assistant_message", text: "unrelated" },
					},
					{
						seqStart: 3,
						turnId: "original",
						item: { type: "assistant_message", text: "answer" },
					},
				],
			})),
		};
		const native = await openPaseoNativeSession({
			session: { runtimeSessionRef: id, executionId, admit: vi.fn(), update },
			model: "configured/test",
			transport,
			close: vi.fn(),
			hasConfirmedModelTurn: () => confirmed,
		} as never);
		if (!confirmed) {
			await expect(native.prompt("hello")).rejects.toThrow(
				"RUNTIME_ACCEPTANCE_UNKNOWN",
			);
			expect(update).not.toHaveBeenCalled();
			return;
		}
		expect(
			await native.prompt([{ type: "text", text: "hello" }]),
		).toMatchObject({ stopReason: "stop" });
		expect(update).toHaveBeenCalledWith({
			type: "text",
			payload: { delta: "answer" },
		});
		expect(update).not.toHaveBeenCalledWith({
			type: "text",
			payload: { delta: "unrelated" },
		});
		expect(unsubscribe).toHaveBeenCalled();
	},
);

it("publishes the bound assistant prefix before terminal and only the remaining suffix on completion", async () => {
	const id = "8a09d2ce-a488-44f8-999f-431117a1d900";
	const executionId = "execution-live";
	const subscribed = Promise.withResolvers<void>();
	const sent = Promise.withResolvers<void>();
	const firstOutput = Promise.withResolvers<void>();
	let fire: (message: unknown) => void = () => {};
	let answer = "first";
	const deltas: string[] = [];
	const transport = {
		ensureAgent: vi.fn(),
		subscribe: async (_id: string, handler: typeof fire) => {
			fire = handler;
			subscribed.resolve();
			return async () => {};
		},
		send: async () => {
			sent.resolve();
		},
		timeline: async () => ({
			epoch: "original-epoch",
			entries: [
				{
					turnId: "our-turn",
					item: {
						type: "user_message",
						clientMessageId: executionId,
						text: "hello",
					},
				},
				{
					turnId: "foreign-turn",
					item: { type: "assistant_message", text: "foreign" },
				},
				{
					turnId: "our-turn",
					item: { type: "assistant_message", text: answer },
				},
			],
		}),
	};
	const session = await openPaseoNativeSession({
		session: {
			runtimeSessionRef: id,
			executionId,
			update: async (e: { payload: { delta: string } }) => {
				deltas.push(e.payload.delta);
				firstOutput.resolve();
			},
		},
		model: "configured/test",
		transport,
		hasConfirmedModelTurn: () => true,
		close: async () => {},
	} as never);
	const done = session.prompt("hello");
	await subscribed.promise;
	await sent.promise;
	const textNotice = {
		event: {
			type: "timeline",
			turnId: "our-turn",
			item: { type: "assistant_message", text: "first" },
		},
	};
	fire(textNotice);
	try {
		await firstOutput.promise;
		expect(deltas).toEqual(["first"]);
		fire(textNotice);
		answer = "first second";
		fire({ event: { type: "turn_completed", turnId: "our-turn" } });
		expect((await done).stopReason).toBe("stop");
		expect(deltas.join("")).toBe(answer);
	} finally {
		await session.close();
	}
});

it.each([true, false])(
	"Pi auto-compaction requires the confirmation immediately after this SDK message (%s)",
	async (original) => {
		const id = "8a09d2ce-a488-44f8-999f-431117a1d900";
		const msg = "execution-command";
		const before = {
			agentId: id,
			epoch: "one",
			agent: { activeTurn: null },
			endCursor: { epoch: "one", seq: 4 },
			entries: [],
		};
		const after = {
			...before,
			endCursor: { epoch: "one", seq: 6 },
			entries: [
				{
					seqStart: 5,
					seqEnd: 5,
					item: {
						type: "user_message",
						text: "/autocompact off",
						clientMessageId: original ? msg : "foreign",
					},
				},
				{
					seqStart: 6,
					seqEnd: 6,
					item: {
						type: "assistant_message",
						text: "Auto-compaction disabled.",
					},
				},
			],
		};
		const transport = {
			ensureAgent: vi.fn(),
			send: vi.fn(),
			timeline: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
		};
		const native = await openPaseoNativeSession({
			session: { runtimeSessionRef: id },
			model: "configured/test",
			transport,
			close: vi.fn(),
		} as never);
		const execute = () =>
			native.setAutoCompaction!(false, msg, {
				signal: new AbortController().signal,
				assertCurrent: vi.fn(),
			});
		if (original)
			await expect(execute()).resolves.toEqual({ stopReason: "stop" });
		else await expect(execute()).rejects.toThrow();
		expect(transport.send).toHaveBeenCalledTimes(1);
		await native.close();
	},
);

it.each(["turn_canceled", "turn_failed", "error"] as const)(
	"keeps observing the original stopped turn after the model disconnects (%s)",
	async (terminal) => {
		const sent = Promise.withResolvers<void>();
		const pending = vi.fn();
		const stopping = Promise.withResolvers<void>();
		let fire: (message: unknown) => void = () => {};
		const native = await openPaseoNativeSession({
			session: {
				runtimeSessionRef: "agent",
				executionId: "execution",
				update: vi.fn(),
				notePendingCancellation: pending,
			},
			transport: {
				ensureAgent: vi.fn(),
				subscribe: async (_id: string, handler: typeof fire) => {
					fire = handler;
					return async () => {};
				},
				send: async () => sent.resolve(),
				timeline: async () => ({
					agent: { activeTurn: { turnId: "original" } },
					entries: [
						{
							turnId: "original",
							item: {
								type: "user_message",
								clientMessageId: "execution",
								text: "hello",
							},
						},
					],
				}),
				cancel: async () => stopping.resolve(),
			},
			close: vi.fn(),
			hasConfirmedModelTurn: () => false,
		} as never);
		expect(await native.handleCancellationStreamLoss()).toBe(false);
		const reply = native.prompt("hello");
		await sent.promise;
		await native.cancel();
		await stopping.promise;
		expect(await native.handleCancellationStreamLoss()).toBe(true);
		expect(pending).toHaveBeenCalledTimes(1);
		fire({ event: { type: "turn_canceled", turnId: "other" } });
		await new Promise((resolve) => setImmediate(resolve));
		if (terminal !== "turn_canceled") {
			await native.cancel();
			const rejected = expect(reply).rejects.toThrow();
			fire({
				event: { type: terminal, turnId: "original", error: "unavailable" },
			});
			await rejected;
			return;
		}
		fire({ event: { type: "turn_canceled", turnId: "original" } });
		expect(await reply).toMatchObject({ stopReason: "aborted" });
	},
);

it("keeps a submitted turn unknown if the native thread changes during readback", async () => {
	let notify: (event: unknown) => void = () => {};
	const markUnknown = vi.fn();
	const native = await openPaseoNativeSession({
		session: {
			runtimeSessionRef: "native",
			executionId: "exec-a",
			markUnknown,
		},
		model: "primary",
		close: vi.fn(),
		hasConfirmedModelTurn: () => true,
		transport: {
			ensureAgent: vi.fn(),
			subscribe: async (_id: string, callback: typeof notify) => {
				notify = callback;
				return async () => {};
			},
			send: async (
				_id: string,
				_mid: string,
				_text: string,
				submit: () => void,
			) => {
				submit();
				notify({ event: { type: "turn_completed", turnId: "paseo-turn" } });
			},
			timeline: async () => {
				throw new PaseoTransportError("thread_conflict");
			},
		},
	} as never);
	await expect(native.prompt("read")).rejects.toThrow(
		"RUNTIME_ACCEPTANCE_UNKNOWN",
	);
	expect(markUnknown).toHaveBeenCalledOnce();
	await native.close();
});

it.each([
	["completed", 0, "completed", true, true],
	["completed", 0, "completed", true, false],
	["completed", 0, "completed", false, false],
	["completed", 3, "failed", true, false],
	["completed", null, "unknown", true, false],
	["failed", null, undefined, true, false],
] as const)(
	"publishes only the bound native Shell receipt for %s exit %s (phase %s, model confirmed %s)",
	async (status, exitCode, expected, confirmed, lateExit) => {
		let notify: (message: unknown) => void = () => {};
		const callId = "private-call-id";
		const turnId = "owned-turn";
		const shell = {
			type: "tool_call",
			name: "shell",
			callId,
			status,
			detail: {
				type: "shell",
				command: "private-command",
				cwd: "private-path",
				output: "private-output",
				exitCode,
			},
		};
		const update = vi.fn();
		const recordSandboxTool = vi.fn();
		const native = await openPaseoNativeSession({
			session: {
				runtimeSessionRef: "8a09d2ce-a488-44f8-999f-431117a1d900",
				executionId: "exec-1",
				recordSandboxTool,
				update,
			},
			model: "model-a",
			close: async () => {},
			hasConfirmedModelTurn: () => confirmed,
			transport: {
				ensureAgent: vi.fn(),
				subscribe: async (_id: string, handler: typeof notify) => {
					notify = handler;
					return async () => {};
				},
				send: async (
					_id: string,
					_mid: string,
					_text: string,
					check: () => void,
				) => {
					check();
					notify({ event: { type: "turn_completed", turnId } });
				},
				timeline: async () => ({
					agent: { provider: "codex" },
					epoch: "one",
					entries: [
						{
							turnId,
							item: {
								type: "user_message",
								clientMessageId: "exec-1",
								text: "run",
							},
						},
						{ turnId: "other", item: { ...shell, callId: "foreign-call" } },
						...(lateExit
							? [
									{
										turnId,
										item: {
											...shell,
											detail: { ...shell.detail, exitCode: null },
										},
									},
								]
							: []),
						{ turnId, item: shell },
						{ turnId, item: shell },
					],
				}),
			},
		} as never);
		if (confirmed)
			expect(await native.prompt("run")).toMatchObject({ stopReason: "stop" });
		else
			await expect(native.prompt("run")).rejects.toThrow(
				"RUNTIME_ACCEPTANCE_UNKNOWN",
			);
		if (expected !== undefined)
			expect(recordSandboxTool).toHaveBeenCalledWith(
				createHash("sha256").update(callId).digest("hex"),
				expected,
			);
		else expect(recordSandboxTool).not.toHaveBeenCalled();
		const calls = update.mock.calls
			.map(([e]) => e)
			.filter((e) => e?.type === "tool");
		expect(calls).toEqual(
			expected !== undefined && expected !== "unknown"
				? [
						{
							type: "tool",
							payload: {
								toolCallId: createHash("sha256").update(callId).digest("hex"),
								name: "shell",
								phase: expected,
							},
						},
					]
				: [],
		);
		await native.close();
	},
);

it.each([
	"foreign-agent-thread",
	"foreign-message",
	"foreign-turn",
	"gap",
	"conflicting-exits",
	"missing-exit",
])(
	"reads no terminal Shell fact from %s during a cold restore",
	async (variation) => {
		const ref = "8a09d2ce-a488-44f8-999f-431117a1d900";
		const thread = "5b5e2b4b-8d0b-49ee-8268-04ca1b93900a";
		const send = vi.fn();
		const shell = {
			turnId: variation === "foreign-turn" ? "other" : "original",
			item: {
				type: "tool_call",
				name: "shell",
				callId: "synthetic-call",
				status: "completed",
				detail: {
					type: "shell",
					exitCode: variation === "missing-exit" ? null : 0,
				},
			},
		};
		const native = await openPaseoNativeSession({
			session: {
				runtimeSessionRef: ref,
				nativeId: "paseo:" + ref,
				codexThread: { expected: thread },
			},
			close: async () => {},
			hasConfirmedModelTurn: () => false,
			transport: {
				refetchAgent: async () => true,
				send,
				timeline: async () => ({
					epoch: "known",
					agent: {
						provider: "codex",
						persistence: {
							provider: "codex",
							sessionId:
								variation === "foreign-agent-thread" ? "other" : thread,
						},
					},
					gap: variation === "gap",
					entries: [
						{
							turnId: "original",
							item: {
								type: "user_message",
								clientMessageId:
									variation === "foreign-message" ? "foreign" : "execution",
							},
						},
						shell,
						...(variation === "conflicting-exits"
							? [
									{
										...shell,
										item: {
											...shell.item,
											detail: { type: "shell", exitCode: 1 },
										},
									},
								]
							: []),
					],
				}),
			},
		} as never);
		try {
			const result = native.readShellExits!("execution");
			if (variation === "conflicting-exits")
				await expect(result).rejects.toThrow("RUNTIME_ACCEPTANCE_UNKNOWN");
			else expect(await result).toEqual(new Map());
			expect(send).not.toHaveBeenCalled();
		} finally {
			await native.close();
		}
	},
);

it("reports a subscription failure before the SDK send as unsubmitted", async () => {
	const send = vi.fn();
	const markUnknown = vi.fn();
	const native = await openPaseoNativeSession({
		session: {
			runtimeSessionRef: "8a09d2ce-a488-44f8-999f-431117a1d900",
			executionId: "exec-1",
			markUnknown,
		},
		model: "model-a",
		close: async () => {},
		hasConfirmedModelTurn: () => false,
		transport: {
			ensureAgent: vi.fn(),
			send,
			subscribe: async () => {
				throw new Error("subscription unavailable");
			},
		},
	} as never);
	try {
		await expect(native.prompt("read")).rejects.toMatchObject({
			code: "not_submitted",
		});
		expect(send).not.toHaveBeenCalled();
		expect(markUnknown).not.toHaveBeenCalled();
	} finally {
		await native.close();
	}
});
