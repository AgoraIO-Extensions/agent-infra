import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RuntimeDriverCommand } from "./driver.js";
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
