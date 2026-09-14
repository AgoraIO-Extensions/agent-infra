import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { GenericAcpRuntimeDriver } from "./acp-runtime-driver.js";

it("persists a confirmed ACP result and events, then resumes the same session without resubmitting", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-driver-"));
	const options = {
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: {},
		}),
	};
	let driver = await GenericAcpRuntimeDriver.open(options);
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
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		};
		const result = await driver.execute(command);
		expect(result.result.outcome).toBe("accepted");
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("completed"),
		);
		const events = await driver.replayEvents(
			result.nativeSessionRef,
			command.executionId,
		);
		expect(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.payload.delta)
				.join(""),
		).toBe("synthetic result 1");
		await driver.close();
		driver = await GenericAcpRuntimeDriver.open(options);
		expect(await driver.execute(command)).toEqual(result);
		expect(
			await driver.getStatus(result.nativeSessionRef, command.executionId),
		).toBe("completed");
		expect(
			await driver.replayEvents(result.nativeSessionRef, command.executionId),
		).toEqual(events);
		const next = await driver.execute({
			...command,
			nativeSessionRef: result.nativeSessionRef,
			operationId: "operation-b",
			executionId: "execution-b",
			turnId: "turn-b",
		});
		await vi.waitFor(async () =>
			expect(await driver.getStatus(next.nativeSessionRef, "execution-b")).toBe(
				"completed",
			),
		);
		expect(
			(await driver.replayEvents(next.nativeSessionRef, "execution-b"))
				.filter((event) => event.type === "text")
				.map((event) => event.payload.delta)
				.join(""),
		).toBe("synthetic result 2");
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("keeps a lost active turn unknown after restart and blocks another turn without quarantining its session", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-unknown-"));
	const options = {
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "hold" },
		}),
	};
	let driver = await GenericAcpRuntimeDriver.open(options);
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
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		};
		const accepted = await driver.execute(command);
		expect(accepted.result.outcome).toBe("accepted");
		expect(
			await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
		).toBe("running");
		await driver.close();
		driver = await GenericAcpRuntimeDriver.open(options);
		expect(
			await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
		).toBe("unknown");
		expect(await driver.execute(command)).toEqual(accepted);
		expect(await driver.lookupOperation(command)).toEqual({
			state: "found",
			record: accepted,
		});
		const next = {
			...command,
			nativeSessionRef: accepted.nativeSessionRef,
			executionId: "execution-b",
			turnId: "turn-b",
			operationId: "operation-b",
		};
		expect((await driver.execute(next)).result.outcome).toBe("busy");
		expect(
			(
				await driver.replayEvents(accepted.nativeSessionRef, "execution-a")
			).filter((e) => e.type === "completed"),
		).toEqual([]);
		const other = await driver.execute({
			...command,
			conversationId: "conversation-b",
		});
		expect(other.result.outcome).toBe("accepted");
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("does not log raw malformed frames, notification parameters or unsolicited response IDs", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-redaction-"));
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "malformed" },
		}),
	});
	try {
		const accepted = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
			).toBe("completed"),
		);
		expect(logged).not.toHaveBeenCalled();
	} finally {
		await driver.close();
		logged.mockRestore();
		await rm(path, { recursive: true, force: true });
	}
});

it("rejects a model changed by the peer while setting effort before any prompt", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-selection-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "changed-model" },
		}),
	});
	try {
		const rejected = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		expect(rejected.result).toMatchObject({
			outcome: "rejected",
			code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it.each(["ignore-cancel", "delayed-cancel"])(
	"keeps %s unknown until a reliable stop result arrives",
	async (mode) => {
		const path = await mkdtemp(join(tmpdir(), "acp-cancel-unknown-"));
		const driver = await GenericAcpRuntimeDriver.open({
			path,
			configVersion: "configuration-a",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					nativeModelId: "provider/model",
					reasoningLevels: ["high"],
				},
			],
			launch: async () => ({
				command: process.execPath,
				args: [
					fileURLToPath(
						new URL("./acp-peer.test-support.mjs", import.meta.url),
					),
				],
				env: { ACP_TEST_MODE: mode },
			}),
		});
		try {
			const accepted = await driver.execute({
				schemaVersion: 2,
				kind: "submit-turn",
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-a",
				turnId: "turn-a",
				operationId: "operation-a",
				input: { text: "synthetic input", attachments: [] },
				selection: {
					schemaVersion: 1,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
			});
			const stopCommand = {
				schemaVersion: 1,
				kind: "stop",
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-a",
				turnId: "turn-a",
				operationId: "stop-a",
				nativeSessionRef: accepted.nativeSessionRef,
			} as const;
			const stop = await driver.execute(stopCommand);
			expect(stop.result.outcome).toBe("unknown");
			expect(
				(
					await driver.replayEvents(accepted.nativeSessionRef, "execution-a")
				).some((e) => e.type === "completed"),
			).toBe(false);
			if (mode === "delayed-cancel") {
				await vi.waitFor(async () =>
					expect(
						await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
					).toBe("cancelled"),
				);
				expect(await driver.lookupOperation(stopCommand)).toMatchObject({
					state: "found",
					record: { result: { outcome: "accepted", status: "cancelled" } },
				});
			}
		} finally {
			await driver.close();
			await rm(path, { recursive: true, force: true });
		}
	},
);

it("retires the owned orphan after a Host crash before resuming the original session", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-host-crash-"));
	const host = spawn(
		process.execPath,
		[
			fileURLToPath(
				new URL("./acp-host-crash.test-support.mjs", import.meta.url),
			),
			path,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	host.stderr.resume();
	let driver: GenericAcpRuntimeDriver | undefined;
	try {
		const [output] = await once(host.stdout, "data");
		const accepted = JSON.parse(output.toString());
		const owner = JSON.parse(
			await readFile(
				join(path, accepted.nativeSessionRef, "process.json"),
				"utf8",
			),
		).owner;
		expect(() => process.kill(owner.pid, 0)).not.toThrow();
		const exited = once(host, "exit");
		host.kill("SIGKILL");
		await exited;
		driver = await GenericAcpRuntimeDriver.open({
			path,
			configVersion: "configuration-a",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					nativeModelId: "provider/model",
					reasoningLevels: ["high"],
				},
			],
			launch: async () => ({
				command: process.execPath,
				args: [
					fileURLToPath(
						new URL("./acp-peer.test-support.mjs", import.meta.url),
					),
				],
				env: {},
			}),
		});
		expect(
			await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
		).toBe("completed");
		const next = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			nativeSessionRef: accepted.nativeSessionRef,
			executionId: "execution-b",
			turnId: "turn-b",
			operationId: "operation-b",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		await vi.waitFor(async () =>
			expect(
				await driver?.getStatus(next.nativeSessionRef, "execution-b"),
			).toBe("completed"),
		);
		expect(
			(await driver.replayEvents(next.nativeSessionRef, "execution-b"))
				.filter((e) => e.type === "text")
				.map((e) => e.payload.delta)
				.join(""),
		).toBe("synthetic result 2");
		expect(() => process.kill(-owner.pid, 0)).toThrow();
	} finally {
		host.kill("SIGKILL");
		await driver?.close();
		await rm(path, { recursive: true, force: true });
	}
}, 15_000);

it("normalizes a native execution limit to a redacted error and failed terminal event", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-limit-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "limit" },
		}),
	});
	try {
		const accepted = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
			).toBe("failed"),
		);
		expect(
			(await driver.replayEvents(accepted.nativeSessionRef, "execution-a"))
				.filter((e) => e.type === "error")
				.map((e) => e.payload),
		).toEqual([
			{
				code: "RUNTIME_EXECUTION_FAILED",
				message: "Runtime execution failed",
				retryable: false,
			},
		]);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it.each(["native-session", "durable-state"])(
	"isolates %s recovery failure and durably cancels the generation",
	async (damage) => {
		const path = await mkdtemp(join(tmpdir(), "acp-session-loss-"));
		const options = {
			path,
			configVersion: "configuration-a",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					nativeModelId: "provider/model",
					reasoningLevels: ["high"],
				},
			],
			launch: async () => ({
				command: process.execPath,
				args: [
					fileURLToPath(
						new URL("./acp-peer.test-support.mjs", import.meta.url),
					),
				],
				env: { ACP_TEST_MODE: "hold" },
			}),
		};
		let driver = await GenericAcpRuntimeDriver.open(options);
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
				input: { text: "synthetic input", attachments: [] },
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
			};
			const accepted = await driver.execute(command);
			await driver.close();
			if (damage === "native-session")
				await rm(
					join(path, accepted.nativeSessionRef, "workspace/session.json"),
				);
			else
				await writeFile(
					join(path, accepted.nativeSessionRef, "state.json"),
					"{broken",
				);
			driver = await GenericAcpRuntimeDriver.open(options);
			await expect(
				driver.getStatus(accepted.nativeSessionRef, "execution-a"),
			).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
			const cancellation = {
				schemaVersion: 1 as const,
				kind: "generation-cancel" as const,
				agentId: command.agentId,
				conversationId: command.conversationId,
				sessionGeneration: 1,
				nativeSessionRef: accepted.nativeSessionRef,
				executionId: command.executionId,
				turnId: command.turnId,
				operationId: "tombstone-a",
			};
			expect(await driver.lookupOperation(cancellation)).toEqual({
				state: "missing",
			});
			const cancelled = await driver.execute(cancellation);
			expect(cancelled.result).toEqual({
				outcome: "accepted",
				status: "cancelled",
			});
			await driver.close();
			driver = await GenericAcpRuntimeDriver.open(options);
			expect(await driver.execute(cancellation)).toEqual(cancelled);
			expect(await driver.lookupOperation(cancellation)).toEqual({
				state: "found",
				record: cancelled,
			});
			await expect(
				driver.execute({ ...cancellation, executionId: "different" }),
			).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
			await expect(
				driver.execute({
					...command,
					nativeSessionRef: accepted.nativeSessionRef,
					executionId: "next",
					turnId: "next",
					operationId: "next",
				}),
			).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
			if (damage === "native-session") {
				expect(
					await driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("unknown");
				expect(
					(
						await driver.replayEvents(
							accepted.nativeSessionRef,
							command.executionId,
						)
					).filter((e) => e.type === "completed"),
				).toEqual([]);
			}
			const other = await driver.execute({
				...command,
				conversationId: "conversation-b",
			});
			expect(other.result.outcome).toBe("accepted");
		} finally {
			await driver.close();
			await rm(path, { recursive: true, force: true });
		}
	},
);

it("rejects cross-Agent, Conversation, generation, native-reference and execution commands", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-binding-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "hold" },
		}),
	});
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
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		};
		const accepted = await driver.execute(command);
		for (const mismatch of [
			{ agentId: "agent-b" },
			{ conversationId: "conversation-b" },
			{ sessionGeneration: 2 },
			{ nativeSessionRef: "unknown" },
		]) {
			const forged = {
				...command,
				nativeSessionRef: accepted.nativeSessionRef,
				...mismatch,
			};
			await expect(driver.execute(forged)).rejects.toMatchObject({
				code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			});
			await expect(driver.lookupOperation(forged)).rejects.toMatchObject({
				code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			});
			const cancellation = {
				schemaVersion: 1 as const,
				kind: "generation-cancel" as const,
				operationId: "forged-cancel",
				agentId: forged.agentId,
				conversationId: forged.conversationId,
				sessionGeneration: forged.sessionGeneration,
				nativeSessionRef: forged.nativeSessionRef,
				executionId: command.executionId,
				turnId: command.turnId,
			};
			await expect(driver.execute(cancellation)).rejects.toMatchObject({
				code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			});
		}
		await expect(
			driver.getStatus(accepted.nativeSessionRef, "execution-b"),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		await expect(
			driver.replayEvents(accepted.nativeSessionRef, "execution-b"),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(await driver.execute(command)).toEqual(accepted);
		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("running");
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});
