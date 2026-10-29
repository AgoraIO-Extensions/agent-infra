import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type {
	RuntimeDriverCommand,
	RuntimeExternalActionAuthorization,
	RuntimeNativeCommandCommandV1,
	RuntimeNativeMetadataReadContextV1,
	RuntimeNativeSkillCommandV1,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";
import type {
	RuntimeMessagesDiagnosticReceipt,
	RuntimeMessagesTransportDiagnostic,
} from "./messages-model-transport.js";
import {
	createRuntimeFileResultReceiptV1,
	type RuntimeFileBridgePortV1,
} from "./runtime-file-bridge.js";
import {
	type NativeSession,
	type NativeSessionOptions,
	SessionRuntimeDriver,
	type SessionRuntimeDriverOptions,
} from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

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

const pngBytes = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
		"1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
	"hex",
);
const pdfBytes = Buffer.from(
	"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n",
);
const resultBinding = {
	actorId: "actor-a",
	channelId: "web",
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: "execution-a",
	sessionGeneration: 1,
	grantId: "grant-a",
	expiresAt: Date.now() + 60_000,
	inputFileIds: [],
};
function resultWriter(onWrite?: () => Promise<void>) {
	let count = 0;
	return vi.fn(
		async (
			descriptor: Parameters<RuntimeFileBridgePortV1["writeResult"]>[0],
			body: Parameters<RuntimeFileBridgePortV1["writeResult"]>[1],
			options?: Parameters<RuntimeFileBridgePortV1["writeResult"]>[2],
		) => {
			for await (const _chunk of body);
			await onWrite?.();
			count += 1;
			return createRuntimeFileResultReceiptV1(
				resultBinding,
				{
					schemaVersion: 1,
					fileId: `result-file-${count}`,
					kind: "result",
					descriptor,
					status: "available",
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
				options,
			);
		},
	);
}
function referenceSession(answer: string, stopReason = "completed") {
	return vi.fn(async (options: NativeSessionOptions) => ({
		nativeId: "native-a",
		select: async () => {},
		prompt: async () => {
			await mkdir(join(options.cwd, "out"), { recursive: true });
			await writeFile(join(options.cwd, "out", "chart.png"), pngBytes);
			await writeFile(join(options.cwd, "out", "report.pdf"), pdfBytes);
			await options.update({ type: "text", payload: { delta: answer } });
			return { stopReason };
		},
		cancel: async () => {},
		close: async () => {},
	}));
}
async function turnState(path: string) {
	const index = JSON.parse(
		await readFile(join(path, "index.json"), "utf8"),
	) as {
		sessions: { ref: string }[];
	};
	const ref = index.sessions[0]?.ref ?? "";
	const state = JSON.parse(
		await readFile(join(path, ref, "state.json"), "utf8"),
	) as {
		turns: {
			status: string;
			operationFacts?: {
				toolId?: string;
				phase: string;
				failureCode?: string;
				resultRef?: string;
			}[];
			resultPublication?: {
				plan: { settled?: true; entries: { phase: string }[] };
			};
		}[];
	};
	return state.turns[0];
}
const referenceAnswer = [
	"Report: [report](sandbox:out/report.pdf) and ![chart](sandbox:/out/chart.png).",
	"",
	"```",
	"[code](sandbox:out/code.png)",
	"```",
	"",
	"Source `[x](sandbox:out/inline.png)` and [app.ts](src/app.ts).",
].join("\n");

it("publishes sandbox: references from the final answer before the terminal event (#3226)", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-result-file-"));
	const writeResult = resultWriter();
	const runtime = await driver(path, referenceSession(referenceAnswer), {
		sandboxReferences: true,
	});
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
		await vi.waitFor(
			async () =>
				expect(
					await runtime.getStatus(accepted.nativeSessionRef, "execution-a"),
				).toBe("completed"),
			{ timeout: 10_000 },
		);
		expect(writeResult.mock.calls.map((call) => call[2])).toEqual([
			{ workspaceReference: "out/report.pdf" },
			{ workspaceReference: "out/chart.png" },
		]);
		expect(writeResult.mock.calls.map((call) => call[0].mediaType)).toEqual([
			"application/pdf",
			"image/png",
		]);
		const events = await runtime.replayEvents(
			accepted.nativeSessionRef,
			"execution-a",
		);
		const files = events.filter((event) => event.type === "file");
		expect(files.map((event) => [event.schemaVersion, event.payload])).toEqual([
			[
				2,
				{
					fileId: "result-file-1",
					name: "report.pdf",
					mimeType: "application/pdf",
					sizeBytes: pdfBytes.byteLength,
					workspaceReference: "out/report.pdf",
				},
			],
			[
				2,
				{
					fileId: "result-file-2",
					name: "chart.png",
					mimeType: "image/png",
					sizeBytes: pngBytes.byteLength,
					workspaceReference: "out/chart.png",
				},
			],
		]);
		// 结果文件事件都在终态事件之前。
		expect(events.at(-1)?.type).toBe("completed");
		const turn = await turnState(path);
		const facts = turn?.operationFacts?.filter(
			(fact) => fact.toolId === "workspace.publish_result_file",
		);
		expect(facts?.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"completed",
			"intent",
			"started",
			"completed",
		]);
		expect(
			events
				.filter((event) => event.type === "operation")
				.map((event) => event.payload),
		).toEqual(turn?.operationFacts);
		expect(turn?.resultPublication?.plan.settled).toBe(true);
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("does not publish for failed Turns or for adapters without the reference protocol (#3226)", async () => {
	for (const [stopReason, sandboxReferences] of [
		["failed", true],
		["completed", false],
	] as const) {
		const path = await mkdtemp(join(tmpdir(), "session-result-skip-"));
		const writeResult = resultWriter();
		const runtime = await driver(
			path,
			referenceSession(referenceAnswer, stopReason),
			{
				sandboxReferences,
				completionStatus: (reason) =>
					reason === "completed" ? "completed" : "failed",
			},
		);
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
			await vi.waitFor(
				async () =>
					expect(
						await runtime.getStatus(accepted.nativeSessionRef, "execution-a"),
					).toBe(stopReason === "completed" ? "completed" : "failed"),
				{ timeout: 10_000 },
			);
			expect(writeResult).not.toHaveBeenCalled();
			expect((await turnState(path))?.resultPublication).toBeUndefined();
		} finally {
			await runtime.close();
			await rm(path, { recursive: true, force: true });
		}
	}
});

it("settles an interrupted publication on restart without republishing (#3226)", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-result-restart-"));
	const restarted = await mkdtemp(join(tmpdir(), "session-result-restored-"));
	const writing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const writeResult = resultWriter(async () => {
		writing.resolve();
		await release.promise;
	});
	const runtime = await driver(path, referenceSession(referenceAnswer), {
		sandboxReferences: true,
	});
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
		await writing.promise;
		// 第一份 writeResult 已开始时的持久状态，相当于此刻 Driver 崩溃。
		await cp(path, restarted, { recursive: true });
		const recovered = await driver(
			restarted,
			vi.fn(async () => {
				throw new Error("native recovery is not needed");
			}),
			{ sandboxReferences: true },
		);
		try {
			expect(
				await recovered.getStatus(accepted.nativeSessionRef, "execution-a"),
			).toBe("completed");
			const events = await recovered.replayEvents(
				accepted.nativeSessionRef,
				"execution-a",
			);
			expect(events.some((event) => event.type === "file")).toBe(false);
			expect(
				events
					.filter((event) => event.type === "operation")
					.map((event) => event.payload),
			).toEqual((await turnState(restarted))?.operationFacts);
			const facts = (await turnState(restarted))?.operationFacts?.filter(
				(fact) => fact.toolId === "workspace.publish_result_file",
			);
			expect(
				facts
					?.filter((fact) => !["intent", "started"].includes(fact.phase))
					.map((fact) => [fact.phase, fact.failureCode]),
			).toEqual([
				["unknown", "recovery_unconfirmed"],
				["failed", "dependency_unavailable"],
			]);
		} finally {
			await recovered.close();
		}
		expect(writeResult).toHaveBeenCalledOnce();
	} finally {
		release.resolve();
		await runtime.close();
		await rm(path, { recursive: true, force: true });
		await rm(restarted, { recursive: true, force: true });
	}
});

async function driver(
	path: string,
	openSession: (options: NativeSessionOptions) => Promise<NativeSession>,
	options: {
		supportsAttachments?: boolean;
		attachmentsNegotiated?: () => boolean;
		skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
		nativeSkillPrompt?: (name: string, parameters: string) => string;
		authorizeModelAction?: SessionRuntimeDriverOptions["authorizeModelAction"];
		sandboxReferences?: boolean;
		completionStatus?: SessionRuntimeDriverOptions["completionStatus"];
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
		...(options.skillDirectory
			? { skillDirectory: options.skillDirectory }
			: {}),
		...(options.nativeSkillPrompt
			? { nativeSkillPrompt: options.nativeSkillPrompt }
			: {}),
		cursorPrefix: "test",
		retireSession: async () => {},
		completionStatus: options.completionStatus ?? (() => "completed"),
		...(options.sandboxReferences ? { sandboxReferences: true } : {}),
		...(options.authorizeModelAction
			? { authorizeModelAction: options.authorizeModelAction }
			: {}),
		openSession,
	});
}

it("binds first and reused model Key delivery to the Driver Session and durable native attempt", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-model-authority-"));
	const outcomes: unknown[] = [];
	const attempts = new Map<
		string,
		{ operationRef: string; attemptRef: string }
	>();
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let runtime: SessionRuntimeDriver;
	let firstSessionRef: string | undefined;
	const authorizeModelAction = vi.fn(
		async (action: RuntimeExternalActionAuthorization) => {
			await runtime.validateExternalAction(action);
			for (const override of [
				{ nativeSessionRef: "vendor-session-a" },
				...(firstSessionRef && firstSessionRef !== action.nativeSessionRef
					? [{ nativeSessionRef: firstSessionRef }]
					: []),
				{ executionId: "other-execution" },
				{ runtimeOperationId: "other-operation" },
				{ attemptRef: randomUUID() },
			])
				await expect(
					runtime.validateExternalAction({ ...action, ...override }),
				).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			return { relayKey: "synthetic-execution-key" };
		},
	);
	runtime = await driver(
		path,
		async (opened) => {
			let current = opened;
			return {
				nativeId: "vendor-session-a",
				select: async () => {},
				startTurn: (next: NativeSessionOptions) => {
					current = next;
				},
				reusable: () => true,
				prompt: async () => {
					const options = current;
					const identity = {
						operationRef: randomUUID(),
						attemptRef: randomUUID(),
					};
					attempts.set(options.executionId ?? "", identity);
					const model = options.modelFact?.();
					if (!model) throw new Error("Missing model fixture");
					await options.recordOperationFact?.({
						kind: "model",
						...identity,
						phase: "intent",
						model,
					});
					await options.recordOperationFact?.({
						kind: "model",
						...identity,
						phase: "started",
						startedAt: new Date().toISOString(),
						model,
					});
					await options.admit();
					try {
						outcomes.push(await options.resolveModelCredential?.());
					} catch (error) {
						outcomes.push(error);
					}
					await released;
					await options.recordOperationFact?.({
						kind: "model",
						...identity,
						phase: "completed",
						finishedAt: new Date().toISOString(),
						durationMs: 1,
						model,
					});
					return { stopReason: "completed" };
				},
				cancel: async () => {},
				close: async () => {},
			};
		},
		{ authorizeModelAction },
	);
	try {
		const first = await runtime.execute(command([]));
		firstSessionRef = first.nativeSessionRef;
		await vi.waitFor(() => expect(outcomes).toHaveLength(1));
		expect(outcomes).toEqual(["synthetic-execution-key"]);
		const firstAction = authorizeModelAction.mock.calls[0]?.[0];
		expect(firstAction).toMatchObject({
			nativeSessionRef: first.nativeSessionRef,
			...attempts.get("execution-a"),
		});
		release();
		for await (const _event of await runtime.subscribeEvents(
			first.nativeSessionRef,
			"execution-a",
			undefined,
			AbortSignal.timeout(1000),
		)) {
			/* Wait for its durable terminal. */
		}
		await expect(
			runtime.validateExternalAction(
				firstAction as RuntimeExternalActionAuthorization,
			),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		const second = await runtime.execute({
			...command([]),
			nativeSessionRef: first.nativeSessionRef,
			executionId: "execution-b",
			operationId: "operation-b",
			turnId: "turn-b",
		} as RuntimeDriverCommand);
		await vi.waitFor(() => expect(outcomes).toHaveLength(2));
		expect(outcomes).toEqual([
			"synthetic-execution-key",
			"synthetic-execution-key",
		]);
		expect(second.nativeSessionRef).toBe(first.nativeSessionRef);
		expect(authorizeModelAction.mock.calls[1]?.[0]).toMatchObject({
			nativeSessionRef: second.nativeSessionRef,
			...attempts.get("execution-b"),
		});
		const other = await runtime.execute({
			...command([]),
			conversationId: "conversation-b",
			executionId: "execution-c",
			operationId: "operation-c",
			turnId: "turn-c",
		} as RuntimeDriverCommand);
		await vi.waitFor(() => expect(outcomes).toHaveLength(3));
		expect(outcomes[2]).toBe("synthetic-execution-key");
		expect(other.nativeSessionRef).not.toBe(first.nativeSessionRef);
	} finally {
		release();
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it.each(["missing", "ambiguous", "completed"] as const)(
	"refuses model Key delivery with %s native attempt evidence",
	async (state) => {
		const path = await mkdtemp(join(tmpdir(), "session-model-evidence-"));
		const authorizeModelAction = vi.fn(async () => ({
			relayKey: "synthetic-execution-key",
		}));
		const outcomes: unknown[] = [];
		const runtime = await driver(
			path,
			async (options) => ({
				nativeId: "vendor-session-a",
				select: async () => {},
				prompt: async () => {
					const model = options.modelFact?.();
					if (!model) throw new Error("Missing model fixture");
					if (state !== "missing")
						for (
							let index = 0;
							index < (state === "ambiguous" ? 2 : 1);
							index++
						) {
							const identity = {
								operationRef: randomUUID(),
								attemptRef: randomUUID(),
							};
							await options.recordOperationFact?.({
								kind: "model",
								...identity,
								phase: "intent",
								model,
							});
							await options.recordOperationFact?.({
								kind: "model",
								...identity,
								phase: "started",
								startedAt: new Date().toISOString(),
								model,
							});
							if (state === "completed")
								await options.recordOperationFact?.({
									kind: "model",
									...identity,
									phase: "completed",
									finishedAt: new Date().toISOString(),
									durationMs: 1,
									model,
								});
						}
					await options.admit();
					try {
						outcomes.push(await options.resolveModelCredential?.());
					} catch (error) {
						outcomes.push(error);
					}
					return { stopReason: "completed" };
				},
				cancel: async () => {},
				close: async () => {},
			}),
			{ authorizeModelAction },
		);
		try {
			await runtime.execute(command([]));
			await vi.waitFor(() => expect(outcomes).toHaveLength(1));
			expect(outcomes[0]).toBeInstanceOf(Error);
			expect(authorizeModelAction).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
			await rm(path, { recursive: true, force: true });
		}
	},
);

it("builds the bounded Pi native Skill command from the mounted directory", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-native-skill-command-"));
	const skillDirectory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		findSkills: () => [
			{
				schemaVersion: 1,
				name: "workspace-summary",
				version: "1.0.0",
				packageDigest: "b".repeat(64),
				manifestDigest: "c".repeat(64),
				targetPath: ".agents/skills/workspace-summary",
				readOnly: true,
			},
		],
		readSkill: async () => new Uint8Array(),
	};
	const runtime = await driver(
		path,
		async () => ({
			nativeId: "native-a",
			select: async () => {},
			prompt: async () => ({ stopReason: "completed" }),
			cancel: async () => {},
			close: async () => {},
		}),
		{
			skillDirectory,
			nativeSkillPrompt: (name, parameters) => `/skill:${name} ${parameters}`,
		},
	);
	try {
		const command = runtime.createNativeSkillCommand({
			schemaVersion: 1,
			kind: "native-capability",
			operationId: "execution-a",
			agentId: "agent-a",
			conversationId: "conversation-a",
			executionId: "execution-a",
			turnId: "turn-a",
			sessionGeneration: 1,
			nativeSessionRef: "native-a",
			capabilityId: "d".repeat(64),
			directoryRevision: "e".repeat(64),
			packageDigest: "b".repeat(64),
			manifestDigest: "c".repeat(64),
			parameters: "summarize files",
			parametersDigest: "f".repeat(64),
			capabilityName: "workspace-summary",
			capabilitySourceVersion: "1.0.0",
		} satisfies RuntimeNativeSkillCommandV1);
		expect(command).toMatchObject({
			kind: "submit-turn",
			operationId: "execution-a",
			input: {
				text: "/skill:workspace-summary summarize files",
				attachments: [],
			},
		});
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("executes a bound native command once and rejects directory drift", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-native-command-"));
	const executeNativeCommand = vi.fn(async () => ({ stopReason: "completed" }));
	const runtime = await driver(path, async () => ({
		nativeId: "native-a",
		select: async () => {},
		prompt: async () => ({ stopReason: "completed" }),
		discoverCommands: async () => ({
			nativeId: "native-a",
			commands: [{ name: "compact", description: "Compact", source: "acp" }],
			readAt: Date.now(),
		}),
		executeNativeCommand,
		cancel: async () => {},
		close: async () => {},
	}));
	try {
		const turn = await runtime.execute(command([]));
		const binding: RuntimeNativeMetadataReadContextV1 = {
			nativeSessionRef: turn.nativeSessionRef,
			signal: new AbortController().signal,
			expiresAt: Date.now() + 30_000,
			assertCurrent: () => ({
				principal: { kind: "user", id: "user-a" },
				scope: {
					agentId: "agent-a",
					conversationId: "conversation-a",
					executionId: "metadata-a",
					sessionGeneration: 1,
				},
			}),
			revalidate: async () => ({
				principal: { kind: "user", id: "user-a" },
				scope: {
					agentId: "agent-a",
					conversationId: "conversation-a",
					executionId: "metadata-a",
					sessionGeneration: 1,
				},
			}),
		};
		const projection = await runtime.readNativeMetadataV1("commands", binding);
		expect(projection.selector).toBe("commands");
		if (projection.selector !== "commands") throw new Error("wrong selector");
		const capability = projection.capabilities[0];
		if (!capability) throw new Error("missing compact command");
		const native = {
			schemaVersion: 1 as const,
			kind: "native-command" as const,
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "native-execution-a",
			turnId: "native-turn-a",
			operationId: "native-execution-a",
			nativeSessionRef: turn.nativeSessionRef,
			capabilityId: capability.id,
			directoryRevision: projection.revision,
			capabilityName: capability.name,
			capabilitySourceVersion: capability.source.version,
			parameters: "",
			parametersDigest: createHash("sha256").update("").digest("hex"),
		} satisfies RuntimeNativeCommandCommandV1;
		expect(runtime.createNativeCommandCommand(native)).toEqual(native);
		const accepted = await runtime.execute(native);
		expect(accepted.result).toEqual({
			outcome: "accepted",
			status: "completed",
		});
		expect(executeNativeCommand).toHaveBeenCalledOnce();
		expect(await runtime.execute(native)).toEqual(accepted);
		expect(executeNativeCommand).toHaveBeenCalledOnce();
		const stale = {
			...native,
			executionId: "native-execution-stale",
			turnId: "native-turn-stale",
			operationId: "native-execution-stale",
			directoryRevision: "f".repeat(64),
		};
		await expect(runtime.execute(stale)).rejects.toMatchObject({
			code: "RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
		});
		expect(executeNativeCommand).toHaveBeenCalledOnce();
	} finally {
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

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
	},
	{
		label: "before Turn admission",
		revokeAt: 2,
		selected: true,
		opened: true,
	},
	{
		label: "at the native boundary",
		revokeAt: 3,
		selected: true,
		opened: true,
	},
])(
	"keeps an attachment Turn undispatched when authority lapses $label",
	async ({ revokeAt, selected, opened }) => {
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
			// the request must not be retained as a possibly accepted Turn. #3373:
			// the Driver declares it not submitted; the lapsed authority is the cause.
			await expect(execution).rejects.toMatchObject({
				code: "RUNTIME_TURN_NOT_SUBMITTED",
				driverFailureKind: "not_submitted",
				reason: "session_preparation_failed",
				cause: expect.objectContaining({
					code: "RUNTIME_AUTHORIZATION_DENIED",
				}),
			});
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

it("replays committed operation facts with stable cursors across restart", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-fact-replay-"));
	let release = () => {};
	const openSession = vi.fn(async (options: NativeSessionOptions) => ({
		nativeId: "native-facts",
		select: async () => {},
		prompt: async () => {
			await options.admit();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { stopReason: "completed" };
		},
		cancel: async () => {},
		close: async () => {},
	}));
	let runtime = await driver(path, openSession);
	try {
		const accepted = await runtime.execute(command([]));
		const input = {
			nativeSessionRef: accepted.nativeSessionRef,
			executionId: "execution-a",
		};
		const model = {
			kind: "model" as const,
			operationRef: "model-operation",
			attemptRef: "model-attempt",
			model: {
				configVersion: "configuration-a",
				modelOptionId: "primary",
				modelId: "fixture-model",
			},
		};
		const facts = [
			{ ...model, phase: "intent" as const },
			{
				...model,
				phase: "started" as const,
				startedAt: "2026-01-01T00:00:00.000Z",
			},
			{
				...model,
				phase: "completed" as const,
				startedAt: "2026-01-01T00:00:00.000Z",
				finishedAt: "2026-01-01T00:00:01.000Z",
				durationMs: 1000,
			},
		] as const;
		for (const fact of facts)
			await runtime.recordOperationFact({ ...input, fact });
		await runtime.recordOperationFact({ ...input, fact: facts[2] });
		const replay = await runtime.replayEvents(
			input.nativeSessionRef,
			input.executionId,
		);
		const operations = replay.filter((event) => event.type === "operation");
		expect(operations.map((event) => event.payload)).toEqual(facts);
		const firstOperation = operations[0];
		if (!firstOperation) throw new Error("missing operation event");
		expect(new Set(replay.map((event) => event.cursor)).size).toBe(
			replay.length,
		);
		expect(new Set(replay.map((event) => event.adapterEventKey)).size).toBe(
			replay.length,
		);
		const journal = JSON.parse(
			await readFile(join(path, input.nativeSessionRef, "state.json"), "utf8"),
		);
		expect(journal.turns[0].operationFacts).toEqual(facts);
		expect(journal.turns[0].events).toEqual(replay);
		release();
		await vi.waitFor(async () =>
			expect(
				await runtime.getStatus(input.nativeSessionRef, input.executionId),
			).toBe("completed"),
		);
		const completedReplay = await runtime.replayEvents(
			input.nativeSessionRef,
			input.executionId,
		);
		await runtime.close();
		runtime = await driver(path, openSession);
		expect(
			await runtime.replayEvents(input.nativeSessionRef, input.executionId),
		).toEqual(completedReplay);
		expect(
			await runtime.replayEvents(
				input.nativeSessionRef,
				input.executionId,
				firstOperation.cursor,
			),
		).toEqual(
			completedReplay.slice(
				completedReplay.findIndex(
					(event) => event.cursor === firstOperation.cursor,
				) + 1,
			),
		);
		await expect(
			runtime.recordOperationFact({ ...input, fact: facts[2] }),
		).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
		expect(openSession).toHaveBeenCalledTimes(1);
		const secondCommand = {
			...command([]),
			nativeSessionRef: input.nativeSessionRef,
			executionId: "execution-b",
			turnId: "turn-b",
			operationId: "operation-b",
		};
		await runtime.execute(secondCommand);
		for (const fact of facts)
			await runtime.recordOperationFact({
				...input,
				executionId: secondCommand.executionId,
				fact,
			});
		release();
		await vi.waitFor(async () =>
			expect(
				await runtime.getStatus(
					input.nativeSessionRef,
					secondCommand.executionId,
				),
			).toBe("completed"),
		);
		const secondReplay = await runtime.replayEvents(
			input.nativeSessionRef,
			secondCommand.executionId,
		);
		await runtime.close();
		runtime = await driver(path, openSession);
		expect(
			await runtime.replayEvents(input.nativeSessionRef, input.executionId),
		).toEqual(completedReplay);
		expect(
			await runtime.replayEvents(
				input.nativeSessionRef,
				secondCommand.executionId,
			),
		).toEqual(secondReplay);
		const file = join(path, input.nativeSessionRef, "state.json");
		await runtime.close();
		const legacy = JSON.parse(await readFile(file, "utf8"));
		let sequence = 0;
		for (const turn of legacy.turns) {
			turn.events = turn.events.filter(
				(event: { type: string }) => event.type !== "operation",
			);
			for (const event of turn.events) event.cursor = `test-${++sequence}`;
		}
		legacy.sequence = sequence;
		await writeFile(file, `${JSON.stringify(legacy)}\n`);
		const legacyBytes = await readFile(file, "utf8");
		runtime = await driver(path, openSession);
		expect(
			(
				await runtime.replayEvents(input.nativeSessionRef, input.executionId)
			).every((event) => event.type !== "operation"),
		).toBe(true);
		expect(await readFile(file, "utf8")).toBe(legacyBytes);
		await runtime.close();
		// A previous unsealed Turn cannot precede an already accepted later Turn.
		legacy.turns[0].events.pop();
		legacy.turns[0].status = "running";
		delete legacy.turns[0].nativeStopReason;
		sequence = 0;
		for (const turn of legacy.turns)
			for (const event of turn.events) event.cursor = `test-${++sequence}`;
		legacy.sequence = sequence;
		await writeFile(file, `${JSON.stringify(legacy)}\n`);
		const invalidBytes = await readFile(file, "utf8");
		runtime = await driver(path, openSession);
		await expect(
			runtime.replayEvents(input.nativeSessionRef, input.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(await readFile(file, "utf8")).toBe(invalidBytes);
	} finally {
		release();
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("wakes a fact subscriber only after the same journal commit is acknowledged", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-fact-subscription-"));
	let releasePrompt = () => {};
	const runtime = await driver(path, async (options) => ({
		nativeId: "native-subscription",
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
	}));
	const persistence = DurableJsonFile.prototype as unknown as {
		persist: (serialized: string) => Promise<void>;
	};
	const original = persistence.persist;
	let enterCommit = () => {};
	const commitEntered = new Promise<void>((resolve) => {
		enterCommit = resolve;
	});
	let releaseCommit = () => {};
	const commitGate = new Promise<void>((resolve) => {
		releaseCommit = resolve;
	});
	const controller = new AbortController();
	let persist: ReturnType<typeof vi.spyOn> | undefined;
	try {
		const accepted = await runtime.execute(command([]));
		const before = await runtime.replayEvents(
			accepted.nativeSessionRef,
			"execution-a",
		);
		const subscription = await runtime.subscribeEvents(
			accepted.nativeSessionRef,
			"execution-a",
			before.at(-1)?.cursor,
			controller.signal,
		);
		const iterator = subscription[Symbol.asyncIterator]();
		let visible = false;
		const next = iterator.next().then((value) => {
			visible = true;
			return value;
		});
		persist = vi
			.spyOn(persistence, "persist")
			.mockImplementation(async function (
				this: DurableJsonFile<unknown>,
				serialized,
			) {
				if (serialized.includes("model-pending-commit")) {
					enterCommit();
					await commitGate;
				}
				return original.call(this, serialized);
			});
		const write = runtime.recordOperationFact({
			nativeSessionRef: accepted.nativeSessionRef,
			executionId: "execution-a",
			fact: {
				kind: "model",
				operationRef: "model-pending-commit",
				attemptRef: "attempt",
				phase: "intent",
				model: {
					configVersion: "configuration-a",
					modelOptionId: "primary",
					modelId: "fixture",
				},
			},
		});
		await commitEntered;
		expect(
			await runtime.replayEvents(accepted.nativeSessionRef, "execution-a"),
		).toEqual(before);
		expect(visible).toBe(false);
		releaseCommit();
		await write;
		await vi.waitFor(() => expect(visible).toBe(true));
		expect((await next).value).toMatchObject({
			schemaVersion: 2,
			type: "operation",
			payload: { operationRef: "model-pending-commit" },
		});
		controller.abort();
		await iterator.return?.();
	} finally {
		controller.abort();
		releaseCommit();
		releasePrompt();
		persist?.mockRestore();
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("does not expose a fact or consume a cursor when its durable commit fails", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-fact-persistence-"));
	let releasePrompt = () => {};
	const runtime = await driver(path, async (options) => ({
		nativeId: "native-persistence",
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
	}));
	const persistence = DurableJsonFile.prototype as unknown as {
		persist: (serialized: string) => Promise<void>;
	};
	const original = persistence.persist;
	let persist: ReturnType<typeof vi.spyOn> | undefined;
	try {
		const accepted = await runtime.execute(command([]));
		const file = join(path, accepted.nativeSessionRef, "state.json");
		const before = await readFile(file, "utf8");
		persist = vi.spyOn(persistence, "persist").mockImplementation(function (
			this: DurableJsonFile<unknown>,
			serialized,
		) {
			if (serialized.includes("model-failed-commit"))
				return Promise.reject(new Error("synthetic commit failure"));
			return original.call(this, serialized);
		});
		await expect(
			runtime.recordOperationFact({
				nativeSessionRef: accepted.nativeSessionRef,
				executionId: "execution-a",
				fact: {
					kind: "model",
					operationRef: "model-failed-commit",
					attemptRef: "attempt",
					phase: "intent",
					model: {
						configVersion: "configuration-a",
						modelOptionId: "primary",
						modelId: "fixture",
					},
				},
			}),
		).rejects.toThrow("synthetic commit failure");
		expect(await readFile(file, "utf8")).toBe(before);
		await expect(
			runtime.replayEvents(accepted.nativeSessionRef, "execution-a"),
		).rejects.toThrow("requires recovery");
	} finally {
		releasePrompt();
		persist?.mockRestore();
		await runtime.close().catch(() => {});
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
		await sessionOptions?.recordOperationFact?.({
			kind: "tool",
			operationRef: "11111111-1111-4111-8111-111111111111",
			attemptRef: "22222222-2222-4222-8222-222222222222",
			phase: "intent",
			toolId: "filesystem.read",
		});
		failNextPersist = true;
		await sessionOptions?.markUnknown?.();
		await expect(
			sessionOptions?.recordOperationFact?.({
				kind: "tool",
				operationRef: "33333333-3333-4333-8333-333333333333",
				attemptRef: "44444444-4444-4444-8444-444444444444",
				phase: "intent",
				toolId: "filesystem.write",
			}),
		).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
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
				operationFacts?: { phase: string; failureCode?: string }[];
			}[];
		};
		expect(persisted.turns[0]?.status).toBe("unknown");
		expect(persisted.turns[0]?.operationFacts?.at(-1)).toMatchObject({
			phase: "unknown",
			failureCode: "recovery_unconfirmed",
		});
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

it("preserves sealed legacy event cursors while retaining a recovered unknown hold", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-sealed-legacy-hold-"));
	let options: NativeSessionOptions | undefined;
	let runtime = await driver(path, async (input) => {
		options = input;
		return {
			nativeId: "native-legacy",
			select: async () => {},
			prompt: async () => ({ stopReason: "completed" }),
			cancel: async () => {},
			close: async () => {},
		};
	});
	try {
		const accepted = await runtime.execute(command([]));
		await vi.waitFor(async () =>
			expect(
				await runtime.getStatus(accepted.nativeSessionRef, "execution-a"),
			).toBe("completed"),
		);
		await options?.markUnknown?.();
		await runtime.close();
		const file = join(path, accepted.nativeSessionRef, "state.json");
		const legacy = JSON.parse(await readFile(file, "utf8"));
		legacy.turns[0].operationFacts = [
			{
				kind: "tool",
				operationRef: "legacy-tool",
				attemptRef: "legacy-attempt",
				phase: "intent",
				toolId: "filesystem.write",
			},
		];
		await writeFile(file, `${JSON.stringify(legacy)}\n`);
		const events = structuredClone(legacy.turns[0].events);
		const openSession = vi.fn(async (input: NativeSessionOptions) => {
			await expect(input.admit()).rejects.toThrow();
			return {
				nativeId: "native-legacy",
				select: async () => {},
				prompt: async () => {
					throw new Error("must not replay a protected operation");
				},
				cancel: async () => {},
				close: async () => {},
			};
		});
		runtime = await driver(path, openSession);
		expect(
			await runtime.getStatus(accepted.nativeSessionRef, "execution-a"),
		).toBe("unknown");
		expect(
			await runtime.replayEvents(accepted.nativeSessionRef, "execution-a"),
		).toEqual(events);
		const recovered = JSON.parse(await readFile(file, "utf8"));
		expect(recovered.turns[0].unknownHold).toBe(true);
		expect(recovered.turns[0].operationFacts.at(-1)).toMatchObject({
			phase: "unknown",
			failureCode: "recovery_unconfirmed",
		});
		expect(recovered.sequence).toBe(legacy.sequence);
		await runtime.close();
		runtime = await driver(path, openSession);
		expect(
			await runtime.replayEvents(accepted.nativeSessionRef, "execution-a"),
		).toEqual(events);
		expect(
			await runtime.getStatus(accepted.nativeSessionRef, "execution-a"),
		).toBe("unknown");
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
		await sessionOptions?.recordOperationFact?.({
			kind: "tool",
			operationRef: "11111111-1111-4111-8111-111111111111",
			attemptRef: "22222222-2222-4222-8222-222222222222",
			phase: "intent",
			toolId: "filesystem.write",
		});
		const recoverCall = vi.fn(async () => undefined);
		const recoveredOpen = vi.fn(async (options: NativeSessionOptions) => {
			await expect(options.admit()).rejects.toThrow();
			expect(options.resolveModelCredential).toBeTypeOf("function");
			await expect(options.resolveModelCredential?.()).rejects.toThrow();
			return {
				nativeId: "native-reopened",
				select: async () => {},
				prompt: async () => ({ stopReason: "completed" }),
				recover: recoverCall,
				cancel: async () => {},
				close: async () => {},
			};
		});
		const recovered = await driver(path, recoveredOpen);
		try {
			expect(
				await recovered.getStatus(record.nativeSessionRef, "execution-a"),
			).toBe("unknown");
			expect(recoveredOpen).toHaveBeenCalledOnce();
			expect(recoverCall).not.toHaveBeenCalled();
			const persisted = JSON.parse(
				await readFile(
					join(path, record.nativeSessionRef, "state.json"),
					"utf8",
				),
			) as {
				sequence: number;
				turns: {
					status: string;
					unknownHold?: true;
					events: { type: string; payload?: { status?: string } }[];
					operationFacts?: { phase: string; failureCode?: string }[];
				}[];
			};
			expect(persisted.turns[0]?.unknownHold).toBe(true);
			expect(persisted.turns[0]?.events.at(-1)).toMatchObject({
				type: "status",
				payload: { status: "unknown" },
			});
			expect(persisted.turns[0]?.operationFacts?.at(-1)).toMatchObject({
				phase: "unknown",
				failureCode: "recovery_unconfirmed",
			});
			expect(
				(await recovered.replayEvents(record.nativeSessionRef, "execution-a"))
					.filter((event) => event.type === "operation")
					.map((event) => event.payload.phase),
			).toEqual(["intent", "unknown"]);

			await recovered.close();
			const legacyUnknown = persisted;
			if (!legacyUnknown.turns[0]) throw new Error("missing recovered turn");
			legacyUnknown.turns[0].status = "unknown";
			delete legacyUnknown.turns[0].unknownHold;
			const legacyFact = legacyUnknown.turns[0].operationFacts?.at(-1);
			if (!legacyFact) throw new Error("missing recovered operation fact");
			legacyFact.phase = "started";
			delete legacyFact.failureCode;
			legacyUnknown.turns[0].events.pop();
			// Legacy facts were journal-only; remove the new projection as well.
			legacyUnknown.turns[0].events = legacyUnknown.turns[0].events.filter(
				(event) => event.type !== "operation",
			);
			legacyUnknown.sequence = legacyUnknown.turns[0].events.length;
			await writeFile(
				join(path, record.nativeSessionRef, "state.json"),
				JSON.stringify(legacyUnknown),
			);
			const recoveredLegacy = await driver(path, recoveredOpen);
			try {
				expect(
					await recoveredLegacy.getStatus(
						record.nativeSessionRef,
						"execution-a",
					),
				).toBe("unknown");
				expect(recoverCall).not.toHaveBeenCalled();
				const legacyPersisted = JSON.parse(
					await readFile(
						join(path, record.nativeSessionRef, "state.json"),
						"utf8",
					),
				) as { turns: { operationFacts?: { phase: string }[] }[] };
				expect(legacyPersisted.turns[0]?.operationFacts?.at(-1)?.phase).toBe(
					"unknown",
				);
			} finally {
				await recoveredLegacy.close();
			}
			const beforeRepeat = JSON.parse(
				await readFile(
					join(path, record.nativeSessionRef, "state.json"),
					"utf8",
				),
			) as { sequence: number };
			const recoveredAgain = await driver(path, recoveredOpen);
			try {
				expect(
					await recoveredAgain.getStatus(
						record.nativeSessionRef,
						"execution-a",
					),
				).toBe("unknown");
				const afterRepeat = JSON.parse(
					await readFile(
						join(path, record.nativeSessionRef, "state.json"),
						"utf8",
					),
				) as { sequence: number };
				expect(afterRepeat.sequence).toBe(beforeRepeat.sequence);
			} finally {
				await recoveredAgain.close();
			}
		} finally {
			await recovered.close();
		}
	} finally {
		release();
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("converges an ordinary interrupted Turn to unknown without recovery evidence", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-recovery-no-evidence-"));
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
		const recoveredOpen = vi.fn(async () => ({
			nativeId: "native-reopened",
			select: async () => {},
			prompt: async () => ({ stopReason: "completed" }),
			cancel: async () => {},
			close: async () => {},
		}));
		const recovered = await driver(path, recoveredOpen);
		try {
			expect(
				await recovered.getStatus(record.nativeSessionRef, "execution-a"),
			).toBe("unknown");
			expect(recoveredOpen).toHaveBeenCalledOnce();
		} finally {
			await recovered.close();
		}
	} finally {
		release();
		await runtime.close();
		await rm(path, { recursive: true, force: true });
	}
});

const transportDiagnostic: RuntimeMessagesTransportDiagnostic = {
	stage: "upstream_http",
	sent: true,
	statusCode: 502,
	statusClass: "5xx",
	durationMs: 12,
};
async function diagnosticFixture() {
	const path = await mkdtemp(join(tmpdir(), "session-messages-diagnostic-"));
	const receipts: {
		executionId: string;
		operationRef: string;
		attemptRef: string;
		receipt: RuntimeMessagesDiagnosticReceipt;
		options: NativeSessionOptions;
	}[] = [];
	let prompts = 0;
	const openSession = async (
		initial: NativeSessionOptions,
	): Promise<NativeSession> => {
		let current = initial;
		return {
			nativeId: "diagnostic-native",
			select: async () => {},
			cancel: async () => {},
			close: async () => {},
			reusable: () => true,
			startTurn: (next) => {
				current = next;
			},
			prompt: async () => {
				const options = current;
				expect(options.openDiagnosticReceipt?.()).toBeUndefined();
				const model = options.modelFact?.();
				if (!model) throw Error("missing trusted model");
				const operationRef = randomUUID();
				const attemptRef = randomUUID();
				await options.recordOperationFact?.({
					kind: "model",
					operationRef,
					attemptRef,
					phase: "intent",
					model,
				});
				await options.recordOperationFact?.({
					kind: "model",
					operationRef,
					attemptRef,
					phase: "started",
					model,
				});
				const receipt = options.openDiagnosticReceipt?.();
				if (!receipt || !options.executionId)
					throw Error("missing diagnostic binding");
				receipts.push({
					executionId: options.executionId,
					operationRef,
					attemptRef,
					receipt,
					options,
				});
				await options.admit();
				prompts++;
				await options.recordOperationFact?.({
					kind: "model",
					operationRef,
					attemptRef,
					phase: "completed",
					model,
				});
				expect(options.openDiagnosticReceipt?.()).toBeUndefined();
				return { stopReason: "completed" };
			},
		};
	};
	let runtime = await driver(path, openSession);
	let ref: string | undefined;
	return {
		path,
		receipts,
		get runtime() {
			return runtime;
		},
		get prompts() {
			return prompts;
		},
		async turn(index: number) {
			const request = command([]);
			if (request.kind !== "submit-turn") throw Error();
			const result = await runtime.execute({
				...request,
				...(ref ? { nativeSessionRef: ref } : {}),
				executionId: `execution-${index}`,
				turnId: `turn-${index}`,
				operationId: `operation-${index}`,
			});
			ref = result.nativeSessionRef;
			await vi.waitFor(async () =>
				expect(await runtime.getStatus(ref ?? "", `execution-${index}`)).toBe(
					"completed",
				),
			);
			return {
				state: join(path, ref, "state.json"),
				diagnostics: join(path, ref, "messages-diagnostics.json"),
			};
		},
		async restart() {
			await runtime.close();
			runtime = await driver(path, openSession);
		},
		async close() {
			await runtime.close();
			await rm(path, { recursive: true, force: true });
		},
	};
}

it("keeps late Messages diagnostics bound to the original Turn across reuse and restart", async () => {
	const fixture = await diagnosticFixture();
	try {
		const files = await fixture.turn(1);
		await fixture.turn(2);
		const before = await readFile(files.state, "utf8");
		const first = fixture.receipts[0];
		const second = fixture.receipts[1];
		if (!first || !second) throw Error();
		await second.receipt("unknown", false, transportDiagnostic);
		await first.receipt("unknown", false, transportDiagnostic);
		await first.receipt("sent", false, {
			stage: "upstream_http",
			sent: false,
			durationMs: 0,
		});
		let saved = JSON.parse(await readFile(files.diagnostics, "utf8"));
		expect(
			saved.entries.map((entry: { executionId: string }) => entry.executionId),
		).toEqual(["execution-2", "execution-1"]);
		expect(saved.entries[1]).toMatchObject({
			operationRef: first.operationRef,
			attemptRef: first.attemptRef,
		});
		expect(saved.entries[0]).toMatchObject({
			operationRef: second.operationRef,
			attemptRef: second.attemptRef,
		});
		expect((await lstat(files.diagnostics)).mode & 0o077).toBe(0);
		expect(await readFile(files.state, "utf8")).toBe(before);
		await fixture.restart();
		await fixture.turn(3);
		await fixture.receipts[2]?.receipt("unknown", false, transportDiagnostic);
		saved = JSON.parse(await readFile(files.diagnostics, "utf8"));
		expect(
			saved.entries.map((entry: { executionId: string }) => entry.executionId),
		).toEqual(["execution-2", "execution-1", "execution-3"]);
		expect(fixture.prompts).toBe(3);
	} finally {
		await fixture.close();
	}
});

it("rejects arbitrary Messages diagnostic fields while preserving authoritative facts", async () => {
	const fixture = await diagnosticFixture();
	try {
		const files = await fixture.turn(1);
		const captured = fixture.receipts[0];
		if (!captured) throw Error();
		const before = await readFile(files.state, "utf8");
		for (const invalid of [
			{
				...transportDiagnostic,
				headers: { Authorization: "synthetic-secret" },
			},
			{ ...transportDiagnostic, stage: "https://key@private.invalid" },
			{ ...transportDiagnostic, statusClass: "2xx" },
			{ ...transportDiagnostic, durationMs: Number.POSITIVE_INFINITY },
		])
			await captured.receipt(
				"unknown",
				false,
				invalid as RuntimeMessagesTransportDiagnostic,
			);
		await captured.receipt("unknown", false, {
			...transportDiagnostic,
			usage: { inputTokens: 1 },
		});
		const raw = await readFile(files.diagnostics, "utf8");
		expect(raw).not.toMatch(/synthetic-secret|private\.invalid|headers|usage/);
		expect(JSON.parse(raw).entries).toHaveLength(1);
		expect(await readFile(files.state, "utf8")).toBe(before);
	} finally {
		await fixture.close();
	}
});

it.each([
	"symlink",
	"malformed",
	"oversized",
	"foreign-binding",
	"too-many",
	"public-mode",
	"read-only-mode",
	"writable-directory",
] as const)(
	"disables the %s Messages sidecar without blocking the next Turn",
	async (mode) => {
		const fixture = await diagnosticFixture();
		try {
			const files = await fixture.turn(1);
			const captured = fixture.receipts[0];
			if (!captured) throw Error();
			const before = await readFile(files.state, "utf8");
			const foreign = join(fixture.path, "foreign.json");
			const entry = {
				requestRef: randomUUID(),
				executionId: captured.executionId,
				operationRef: captured.operationRef,
				attemptRef: captured.attemptRef,
				state: "unknown",
				diagnostic: transportDiagnostic,
			};
			if (mode === "symlink") {
				await writeFile(foreign, "unchanged", { mode: 0o600 });
				await symlink(foreign, files.diagnostics);
			} else
				await writeFile(
					files.diagnostics,
					mode === "malformed"
						? "{}"
						: mode === "oversized"
							? "界".repeat(90_000)
							: JSON.stringify({
									schemaVersion: 1,
									entries:
										mode === "too-many"
											? Array.from({ length: 129 }, () => ({
													...entry,
													requestRef: randomUUID(),
												}))
											: [
													{
														...entry,
														...(mode === "foreign-binding"
															? { executionId: "other-execution" }
															: {}),
													},
												],
								}),
					{ mode: 0o600 },
				);
			if (mode === "public-mode") await chmod(files.diagnostics, 0o644);
			if (mode === "read-only-mode") await chmod(files.diagnostics, 0o400);
			if (mode === "writable-directory")
				await chmod(captured.options.directory, 0o777);
			const original = await readFile(files.diagnostics, "utf8");
			await captured.receipt("unknown", false, transportDiagnostic);
			expect(await readFile(files.diagnostics, "utf8")).toBe(original);
			expect(await readFile(files.state, "utf8")).toBe(before);
			await fixture.turn(2);
			await fixture.receipts[1]?.receipt("unknown", false, transportDiagnostic);
			expect(await readFile(files.diagnostics, "utf8")).toBe(original);
			expect(fixture.prompts).toBe(2);
		} finally {
			await fixture.close();
		}
	},
);

it("contains a poisoned Messages sidecar without poisoning the execution journal", async () => {
	const fixture = await diagnosticFixture();
	try {
		const files = await fixture.turn(1);
		const captured = fixture.receipts[0];
		if (!captured) throw Error();
		await captured.receipt("sent", false, {
			stage: "upstream_http",
			sent: false,
			durationMs: 0,
		});
		const prototype = DurableJsonFile.prototype as unknown as {
			path: string;
			persist(serialized: string): Promise<void>;
		};
		const persist = prototype.persist;
		const failing = vi.spyOn(prototype, "persist").mockImplementation(function (
			this: typeof prototype,
			serialized,
		) {
			if (this.path.endsWith("messages-diagnostics.json"))
				return Promise.reject(
					Error("synthetic-secret https://private.invalid"),
				);
			return persist.call(this, serialized);
		});
		try {
			await captured.receipt("unknown", false, transportDiagnostic);
			await fixture.turn(2);
			await fixture.receipts[1]?.receipt("unknown", false, transportDiagnostic);
			expect(fixture.prompts).toBe(2);
			expect(
				await fixture.runtime.getStatus(
					captured.options.runtimeSessionRef,
					"execution-1",
				),
			).toBe("completed");
			expect(await readFile(files.diagnostics, "utf8")).not.toMatch(
				/synthetic-secret|private.invalid/,
			);
		} finally {
			failing.mockRestore();
		}
	} finally {
		await fixture.close();
	}
});

it("bounds queued Messages diagnostics and leaves close independent of a hung sidecar", async () => {
	const fixture = await diagnosticFixture();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const files = await fixture.turn(1);
		const captured = fixture.receipts[0];
		if (!captured) throw Error();
		await captured.receipt("sent", false, {
			stage: "upstream_http",
			sent: false,
			durationMs: 0,
		});
		let updates = 0;
		const prototype = DurableJsonFile.prototype as unknown as {
			path: string;
			update(change: unknown): Promise<void>;
		};
		const update = prototype.update;
		const blocked = vi.spyOn(prototype, "update").mockImplementation(function (
			this: typeof prototype,
			change,
		) {
			if (this.path.endsWith("messages-diagnostics.json")) {
				updates++;
				return held;
			}
			return update.call(this, change);
		});
		const receipts = Array.from({ length: 40 }, () =>
			captured.receipt("unknown", false, transportDiagnostic),
		);
		try {
			await vi.waitFor(() => expect(updates).toBe(16));
			await fixture.turn(2);
			await fixture.runtime.close();
			expect(captured.options.openDiagnosticReceipt?.()).toBeUndefined();
			await captured.receipt("unknown", false, transportDiagnostic);
			expect(updates).toBe(16);
		} finally {
			release();
			await Promise.all(receipts);
			blocked.mockRestore();
		}
		expect(
			JSON.parse(await readFile(files.diagnostics, "utf8")).entries,
		).toHaveLength(1);
	} finally {
		release?.();
		await fixture.close();
	}
});

it("bounds Messages sidecar records across restart without rewriting the main journal", async () => {
	const fixture = await diagnosticFixture();
	try {
		const files = await fixture.turn(1);
		const captured = fixture.receipts[0];
		if (!captured) throw Error();
		const original = await readFile(files.state, "utf8");
		await captured.receipt("unknown", false, transportDiagnostic);
		const saved = JSON.parse(await readFile(files.diagnostics, "utf8"));
		const entries = Array.from({ length: 128 }, () => ({
			...saved.entries[0],
			requestRef: randomUUID(),
		}));
		await fixture.restart();
		await writeFile(
			files.diagnostics,
			JSON.stringify({ schemaVersion: 1, entries }),
			{ mode: 0o600 },
		);
		await fixture.turn(2);
		await fixture.receipts[1]?.receipt("unknown", false, transportDiagnostic);
		const next = JSON.parse(await readFile(files.diagnostics, "utf8"));
		expect(next.entries).toHaveLength(128);
		expect(next.entries[0].requestRef).toBe(entries[1].requestRef);
		expect(next.entries.at(-1).executionId).toBe("execution-2");
		expect((await lstat(files.diagnostics)).size).toBeLessThanOrEqual(262_144);
		const after = JSON.parse(await readFile(files.state, "utf8"));
		expect(after.turns[0]).toEqual(JSON.parse(original).turns[0]);
	} finally {
		await fixture.close();
	}
});

it.each(["initialization", "persist"] as const)(
	"does not overwrite a reopened Session diagnostic with older detached %s",
	async (stage) => {
		const fixture = await diagnosticFixture();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			entered = resolve;
		});
		try {
			const files = await fixture.turn(1);
			const first = fixture.receipts[0];
			if (!first) throw Error();
			if (stage === "persist")
				await first.receipt("sent", false, {
					stage: "upstream_http",
					sent: false,
					durationMs: 0,
				});
			const prototype = DurableJsonFile.prototype as unknown as {
				path: string;
				persist(serialized: string): Promise<void>;
			};
			const persist = prototype.persist;
			let oldWrite = true;
			const pending = vi
				.spyOn(prototype, "persist")
				.mockImplementation(async function (
					this: typeof prototype,
					serialized,
				) {
					if (this.path.endsWith("messages-diagnostics.json") && oldWrite) {
						oldWrite = false;
						entered();
						await held;
					}
					await persist.call(this, serialized);
				});
			let late: Promise<void> | undefined;
			try {
				late = first.receipt("unknown", false, transportDiagnostic);
				await blocked;
				await fixture.restart();
				await fixture.turn(2);
				await fixture.receipts[1]?.receipt(
					"unknown",
					false,
					transportDiagnostic,
				);
				if (stage === "initialization")
					await expect(
						readFile(files.diagnostics, "utf8"),
					).rejects.toMatchObject({ code: "ENOENT" });
				else
					expect(
						JSON.parse(await readFile(files.diagnostics, "utf8")).entries.map(
							(entry: { executionId: string }) => entry.executionId,
						),
					).toEqual(["execution-1"]);
				expect(fixture.prompts).toBe(2);
				release();
				await late;
				await vi.waitFor(async () => {
					await fixture.receipts[1]?.receipt(
						"unknown",
						false,
						transportDiagnostic,
					);
					expect(
						JSON.parse(await readFile(files.diagnostics, "utf8")).entries.map(
							(entry: { executionId: string }) => entry.executionId,
						),
					).toContain("execution-2");
				});
				expect(
					JSON.parse(await readFile(files.diagnostics, "utf8")).entries.map(
						(entry: { executionId: string }) => entry.executionId,
					),
				).toContain("execution-2");
			} finally {
				release();
				await late;
				pending.mockRestore();
			}
		} finally {
			release?.();
			await fixture.close();
		}
	},
);
