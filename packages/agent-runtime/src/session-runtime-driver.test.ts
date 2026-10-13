import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RuntimeDriverCommand } from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";
import {
	createRuntimeFileResultReceiptV1,
	type RuntimeFileBridgePortV1,
} from "./runtime-file-bridge.js";
import {
	type NativeSession,
	type NativeSessionOptions,
	SessionRuntimeDriver,
} from "./session-runtime-driver.js";

const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function command(attachments: readonly string[]): RuntimeDriverCommand {
	return {
		schemaVersion: 2,
		kind: "submit-turn",
		agentId: "agent-a",
		conversationId: "conversation-a",
		sessionGeneration: 1,
		executionId: "execution-a",
		turnId: "turn-a",
		operationId: "operation-a",
		input: { text: "describe this image", attachments: [...attachments] },
		selection: {
			schemaVersion: 1,
			modelOptionId: "primary",
			reasoningLevel: "high",
		},
	};
}

function fileBridge(onRevalidate?: (call: number) => void): {
	port: RuntimeFileBridgePortV1;
	readInput: ReturnType<typeof vi.fn>;
	revalidate: ReturnType<typeof vi.fn>;
} {
	let revocations = 0;
	const readInput = vi.fn(async (fileId: string) => ({
		fileId,
		descriptor: {
			name: "screen.png",
			mediaType: "image/png",
			sizeBytes: imageBytes.byteLength,
			sha256: createHash("sha256").update(imageBytes).digest("hex"),
		},
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(imageBytes);
				controller.close();
			},
		}),
	}));
	const revalidate = vi.fn(() => {
		revocations += 1;
		onRevalidate?.(revocations);
	});
	return {
		readInput,
		revalidate,
		port: {
			readInput,
			revalidate,
			writeResult: async () => {
				throw new Error("unused");
			},
		},
	};
}

it("publishes one request-scoped native result file", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-result-file-"));
	let publishAfterTerminal: (() => Promise<void>) | undefined;
	const writeResult = vi.fn(
		async (descriptor: Parameters<RuntimeFileBridgePortV1["writeResult"]>[0]) =>
			createRuntimeFileResultReceiptV1(
				{
					actorId: "actor-a",
					channelId: "web",
					agentId: "agent-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					sessionGeneration: 1,
					grantId: "grant-a",
					expiresAt: Date.now() + 60_000,
					inputFileIds: [],
				},
				{
					schemaVersion: 1,
					fileId: "result-file-session",
					kind: "result",
					descriptor,
					status: "available",
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
			),
	);
	const openSession = vi.fn(async (options: NativeSessionOptions) => ({
		nativeId: "native-a",
		select: async () => {},
		prompt: async () => {
			await options.resultFile?.({
				path: join(tmpdir(), "outside-result.txt"),
				content: "outside",
			});
			await options.resultFile?.({
				path: join(options.cwd, "result.txt"),
				content: "session result",
			});
			await options.resultFile?.({
				path: join(options.cwd, "second-result.txt"),
				content: "duplicate",
			});
			publishAfterTerminal = async () => {
				await options.resultFile?.({
					path: join(options.cwd, "late-result.txt"),
					content: "late",
				});
			};
			return { stopReason: "completed" };
		},
		cancel: async () => {},
		close: async () => {},
	}));
	const runtime = await driver(path, openSession);
	try {
		const accepted = await runtime.execute(command([]), {
			fileBridge: {
				readInput: async () => {
					throw new Error("unused");
				},
				writeResult,
				revalidate: () => {},
			},
		});
		await vi.waitFor(async () =>
			expect(
				await runtime.getStatus(accepted.nativeSessionRef, "execution-a"),
			).toBe("completed"),
		);
		await publishAfterTerminal?.();
		expect(writeResult).toHaveBeenCalledOnce();
		expect(
			(
				await runtime.replayEvents(accepted.nativeSessionRef, "execution-a")
			).some((event) => event.type === "file"),
		).toBe(true);
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

async function driver(
	path: string,
	openSession: (options: NativeSessionOptions) => Promise<NativeSession>,
	options: {
		supportsAttachments?: boolean;
		attachmentsNegotiated?: () => boolean;
	} = {},
): Promise<SessionRuntimeDriver> {
	return SessionRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "configured/model",
				reasoningLevels: ["high"],
			},
		],
		supportsAttachments: options.supportsAttachments ?? true,
		...(options.attachmentsNegotiated
			? { attachmentsNegotiated: options.attachmentsNegotiated }
			: {}),
		cursorPrefix: "test",
		retireSession: async () => {},
		completionStatus: () => "completed",
		openSession,
	});
}

it("rejects attachments before opening a Session the Driver does not declare support for", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-attachment-declared-"));
	const { port, readInput, revalidate } = fileBridge();
	const openSession = vi.fn(async () => ({
		nativeId: "native-a",
		select: async () => {},
		prompt: async () => ({ stopReason: "completed" }),
		cancel: async () => {},
		close: async () => {},
	}));
	const runtime = await driver(path, openSession, {
		supportsAttachments: false,
	});
	try {
		await expect(
			runtime.execute(command(["file-1"]), { fileBridge: port }),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(openSession).not.toHaveBeenCalled();
		expect(readInput).not.toHaveBeenCalled();
		expect(revalidate).not.toHaveBeenCalled();
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("rejects attachments before any bridge read or Session side effect when the peer did not negotiate image input", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-attachment-gate-"));
	const { port, readInput, revalidate } = fileBridge();
	const openSession = vi.fn(async () => ({
		nativeId: "native-a",
		select: async () => {},
		prompt: async () => ({ stopReason: "completed" }),
		cancel: async () => {},
		close: async () => {},
	}));
	const runtime = await driver(path, openSession, {
		attachmentsNegotiated: () => false,
	});
	try {
		await expect(
			runtime.execute(command(["file-1"]), { fileBridge: port }),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(readInput).not.toHaveBeenCalled();
		expect(revalidate).not.toHaveBeenCalled();
		expect(openSession).not.toHaveBeenCalled();
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("rejects attachments before model selection when the opened Session refuses image input", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-attachment-refused-"));
	const { port, readInput, revalidate } = fileBridge();
	const select = vi.fn(async () => {});
	const close = vi.fn(async () => {});
	const prompt = vi.fn(async () => ({ stopReason: "completed" }));
	const runtime = await driver(path, async () => ({
		nativeId: "native-a",
		supportsImagePrompt: false,
		select,
		prompt,
		cancel: async () => {},
		close,
	}));
	try {
		await expect(
			runtime.execute(command(["file-1"]), { fileBridge: port }),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(readInput).toHaveBeenCalledWith("file-1");
		expect(revalidate).toHaveBeenCalledTimes(1);
		expect(select).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("reads and revalidates bridge bytes for a native session that supports image input", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-attachment-support-"));
	const { port, readInput, revalidate } = fileBridge();
	const select = vi.fn(async () => {});
	const prompt = vi.fn(async () => ({ stopReason: "completed" }));
	const runtime = await driver(path, async () => ({
		nativeId: "native-a",
		supportsImagePrompt: true,
		select,
		prompt,
		cancel: async () => {},
		close: async () => {},
	}));
	try {
		const record = await runtime.execute(command(["file-1"]), {
			fileBridge: port,
		});
		expect(record.result).toMatchObject({ outcome: "accepted" });
		expect(readInput).toHaveBeenCalledWith("file-1");
		// After acquisition, before Turn admission, and at the native boundary.
		expect(revalidate).toHaveBeenCalledTimes(3);
		expect(select).toHaveBeenCalledWith("configured/model", "high");
		expect(prompt).toHaveBeenCalledWith([
			{ type: "text", text: "describe this image" },
			{
				type: "image",
				data: Buffer.from(imageBytes).toString("base64"),
				mimeType: "image/png",
			},
		]);
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it.each([
	{
		label: "after the bytes are acquired",
		revokeAt: 1,
		selected: false,
		opened: false,
		code: "RUNTIME_AUTHORIZATION_DENIED",
	},
	{
		label: "before Turn admission",
		revokeAt: 2,
		selected: true,
		opened: true,
		code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
	},
	{
		label: "at the native boundary",
		revokeAt: 3,
		selected: true,
		opened: true,
		code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
	},
])(
	"keeps an attachment Turn undispatched when authority lapses $label",
	async ({ revokeAt, selected, opened, code }) => {
		const path = await mkdtemp(join(tmpdir(), "session-attachment-authority-"));
		const { port, readInput } = fileBridge((call) => {
			if (call === revokeAt)
				throw new RuntimeHostError(
					"RUNTIME_AUTHORIZATION_DENIED",
					"Runtime authorization was denied",
					403,
					false,
				);
		});
		const select = vi.fn(async () => {});
		const prompt = vi.fn(async () => ({ stopReason: "completed" }));
		const openSession = vi.fn(async () => ({
			nativeId: "native-a",
			supportsImagePrompt: true,
			select,
			prompt,
			cancel: async () => {},
			close: async () => {},
		}));
		const runtime = await driver(path, openSession);
		try {
			const execution = runtime.execute(command(["file-1"]), {
				fileBridge: port,
			});
			// A pre-dispatch authorization failure is definite: no prompt ran, so
			// the request must not be retained as a possibly accepted Turn.
			await expect(execution).rejects.toMatchObject({ code });
			expect(readInput).toHaveBeenCalledTimes(1);
			expect(openSession.mock.calls.length > 0).toBe(opened);
			expect(prompt).not.toHaveBeenCalled();
			expect(select.mock.calls.length > 0).toBe(selected);
			expect(await runtime.lookupOperation(command(["file-1"]))).toEqual({
				state: "missing",
			});
		} finally {
			await runtime.close();
			await rm(path, { recursive: true, force: true });
		}
	},
);

it("keeps text-only turns working without a file bridge", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-attachment-text-"));
	const prompt = vi.fn(async () => ({ stopReason: "completed" }));
	const runtime = await driver(path, async () => ({
		nativeId: "native-a",
		supportsImagePrompt: false,
		select: async () => {},
		prompt,
		cancel: async () => {},
		close: async () => {},
	}));
	try {
		const record = await runtime.execute(command([]));
		expect(record.result).toMatchObject({ outcome: "accepted" });
		expect(prompt).toHaveBeenCalledWith("describe this image");
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("durably acknowledges non-Codex operation facts with ordered phase transitions", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-operation-facts-"));
	let sessionOptions: NativeSessionOptions | undefined;
	let releasePrompt!: () => void;
	const runtime = await driver(path, async (options) => {
		sessionOptions = options;
		return {
			nativeId: "native-a",
			select: async () => {},
			prompt: async () => {
				await options.admit();
				await new Promise<void>((resolve) => {
					releasePrompt = resolve;
				});
				return { stopReason: "completed" };
			},
			cancel: async () => {},
			close: async () => {},
		};
	});
	const execution = runtime.execute(command([]));
	try {
		await vi.waitFor(() => expect(sessionOptions).toBeDefined());
		expect(sessionOptions?.recordOperationFact).toBeTypeOf("function");
		const record = await execution;
		const input = {
			nativeSessionRef: record.nativeSessionRef,
			executionId: "execution-a",
		};
		const requestIdentity = {
			rpcRequestId: 7,
			requestDigest: "a".repeat(64),
		};
		await sessionOptions?.recordOperationFact?.({
			kind: "tool",
			operationRef: "11111111-1111-4111-8111-111111111111",
			attemptRef: "22222222-2222-4222-8222-222222222222",
			phase: "intent",
			toolId: "filesystem.read",
			...requestIdentity,
		});
		await sessionOptions?.recordOperationFact?.({
			kind: "tool",
			operationRef: "11111111-1111-4111-8111-111111111111",
			attemptRef: "22222222-2222-4222-8222-222222222222",
			phase: "started",
			startedAt: new Date().toISOString(),
			toolId: "filesystem.read",
			...requestIdentity,
		});
		await runtime.recordOperationFact({
			...input,
			fact: {
				kind: "tool",
				operationRef: "33333333-3333-4333-8333-333333333333",
				attemptRef: "44444444-4444-4444-8444-444444444444",
				phase: "intent",
				toolId: "filesystem.write",
			},
		});
		await expect(
			runtime.recordOperationFact({
				...input,
				fact: {
					kind: "tool",
					operationRef: "33333333-3333-4333-8333-333333333333",
					attemptRef: "44444444-4444-4444-8444-444444444444",
					phase: "started",
					startedAt: new Date().toISOString(),
					toolId: "filesystem.write",
				},
			}),
		).resolves.toBeUndefined();
		let rejected = false;
		for (let index = 0; index < 200; index++) {
			const operationRef = `${String(index + 10).padStart(8, "0")}-1111-4111-8111-111111111111`;
			const attemptRef = `${String(index + 10).padStart(8, "0")}-2222-4222-8222-222222222222`;
			try {
				await runtime.recordOperationFact({
					...input,
					fact: {
						kind: "tool",
						operationRef,
						attemptRef,
						phase: "intent",
						toolId: "filesystem.read",
					},
				});
				await runtime.recordOperationFact({
					...input,
					fact: {
						kind: "tool",
						operationRef,
						attemptRef,
						phase: "started",
						startedAt: new Date().toISOString(),
						toolId: "filesystem.read",
					},
				});
			} catch (error) {
				expect(error).toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
				rejected = true;
				break;
			}
		}
		expect(rejected).toBe(true);
		releasePrompt();
		await runtime.close();
		const state = JSON.parse(
			await readFile(join(path, record.nativeSessionRef, "state.json"), "utf8"),
		) as {
			turns: {
				operationFacts?: {
					phase: string;
					rpcRequestId?: string | number;
					requestDigest?: string;
				}[];
			}[];
		};
		const facts = state.turns[0]?.operationFacts ?? [];
		expect(facts.length).toBeLessThanOrEqual(256);
		expect(facts.slice(0, 4).map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"intent",
			"started",
		]);
		expect(facts.at(-1)?.phase).toBe("started");
		expect(
			facts.slice(0, 2).map((fact) => ({
				rpcRequestId: fact.rpcRequestId,
				requestDigest: fact.requestDigest,
			})),
		).toEqual([requestIdentity, requestIdentity]);
	} finally {
		releasePrompt?.();
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("keeps a protected cancellation as an unknown Turn hold after a persistence retry", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-protected-unknown-"));
	let sessionOptions: NativeSessionOptions | undefined;
	let entered!: () => void;
	const enteredPrompt = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const releasePrompt = new Promise<void>((resolve) => {
		release = resolve;
	});
	const runtime = await driver(path, async (options) => {
		sessionOptions = options;
		return {
			nativeId: "native-protected",
			select: async () => {},
			prompt: async () => {
				entered();
				await releasePrompt;
				return { stopReason: "cancelled" };
			},
			cancel: async () => {},
			close: async () => {},
		};
	});
	const originalPersist = (
		DurableJsonFile.prototype as unknown as {
			persist: (serialized: string) => Promise<void>;
		}
	).persist;
	let failNextPersist = false;
	const persistFailure = vi
		.spyOn(
			DurableJsonFile.prototype as unknown as {
				persist: (serialized: string) => Promise<void>;
			},
			"persist",
		)
		.mockImplementation(function (this: DurableJsonFile<unknown>, serialized) {
			if (failNextPersist) {
				failNextPersist = false;
				return Promise.reject(new Error("synthetic persistence failure"));
			}
			return originalPersist.call(this, serialized);
		});
	const pending = runtime.execute(command([]));
	try {
		await vi.waitFor(() => expect(sessionOptions).toBeDefined());
		await enteredPrompt;
		failNextPersist = true;
		await sessionOptions?.markUnknown?.();
		await sessionOptions?.recordOperationFact?.({
			kind: "tool",
			operationRef: "11111111-1111-4111-8111-111111111111",
			attemptRef: "22222222-2222-4222-8222-222222222222",
			phase: "intent",
			toolId: "filesystem.read",
		});
		release();
		await pending;
		const state = JSON.parse(
			await readFile(join(path, "index.json"), "utf8"),
		) as { sessions: { ref: string }[] };
		const ref = state.sessions[0]?.ref;
		if (!ref) throw new Error("missing session ref");
		const persisted = JSON.parse(
			await readFile(join(path, ref, "state.json"), "utf8"),
		) as {
			turns: {
				status: string;
				events: { type: string }[];
				operationFacts?: { phase: string }[];
			}[];
		};
		expect(persisted.turns[0]?.status).toBe("unknown");
		expect(persisted.turns[0]?.operationFacts?.at(-1)?.phase).toBe("intent");
		expect(
			persisted.turns[0]?.events.some((event) => event.type === "completed"),
		).toBe(false);
	} finally {
		release();
		persistFailure.mockRestore();
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("lets a protected unknown hold supersede a racing terminal status", async () => {
	const path = await mkdtemp(
		join(tmpdir(), "session-protected-terminal-race-"),
	);
	let sessionOptions: NativeSessionOptions | undefined;
	const runtime = await driver(path, async (options) => {
		sessionOptions = options;
		return {
			nativeId: "native-protected",
			select: async () => {},
			prompt: async () => ({ stopReason: "completed" }),
			cancel: async () => {},
			close: async () => {},
		};
	});
	try {
		const record = await runtime.execute(command([]));
		await sessionOptions?.markUnknown?.();
		const persisted = JSON.parse(
			await readFile(join(path, record.nativeSessionRef, "state.json"), "utf8"),
		) as { turns: { status: string; events: { type: string }[] }[] };
		expect(persisted.turns[0]?.status).toBe("unknown");
		expect(
			persisted.turns[0]?.events.some((event) => event.type === "completed"),
		).toBe(true);
		expect(persisted.turns[0]?.events.at(-1)?.type).toBe("status");
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("normalizes an interrupted Turn into an unknown hold before recovery", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-recovery-unknown-hold-"));
	let sessionOptions: NativeSessionOptions | undefined;
	let release!: () => void;
	const releasePrompt = new Promise<void>((resolve) => {
		release = resolve;
	});
	const runtime = await driver(path, async (options) => {
		sessionOptions = options;
		return {
			nativeId: "native-interrupted",
			select: async () => {},
			prompt: async () => {
				await options.admit();
				await releasePrompt;
				return { stopReason: "completed" };
			},
			cancel: async () => {},
			close: async () => {},
		};
	});
	const pending = runtime.execute(command([]));
	try {
		await vi.waitFor(() => expect(sessionOptions).toBeDefined());
		const record = await pending;
		const recoveredOpen = vi.fn(async () => {
			throw new Error("unknown hold must not reopen native recovery");
		});
		const recovered = await driver(path, recoveredOpen);
		try {
			expect(
				await recovered.getStatus(record.nativeSessionRef, "execution-a"),
			).toBe("unknown");
			expect(recoveredOpen).not.toHaveBeenCalled();
			const persisted = JSON.parse(
				await readFile(
					join(path, record.nativeSessionRef, "state.json"),
					"utf8",
				),
			) as {
				turns: {
					status: string;
					unknownHold?: true;
					events: { type: string; payload?: { status?: string } }[];
				}[];
			};
			expect(persisted.turns[0]?.unknownHold).toBe(true);
			expect(persisted.turns[0]?.events.at(-1)).toMatchObject({
				type: "status",
				payload: { status: "unknown" },
			});
		} finally {
			await recovered.close();
		}
	} finally {
		release();
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});
