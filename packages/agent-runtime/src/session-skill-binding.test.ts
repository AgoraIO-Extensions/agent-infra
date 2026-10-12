import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { GenericAcpRuntimeDriver } from "./acp-runtime-driver.js";
import type { RuntimeDriverCommand } from "./driver.js";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";
import {
	boundedRuntimeSkillRead,
	type RuntimeFilesystemSkillDirectoryV1,
} from "./skill-hub-directory.js";

it("passes the deployment-owned Skill Hub directory to newly opened sessions", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-skill-binding-"));
	const skillDirectory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		findSkills: () => [],
		readSkill: async () => new Uint8Array(),
	};
	const observed: { skillDirectory?: RuntimeFilesystemSkillDirectoryV1 }[] = [];
	const replacement: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "b".repeat(64),
		findSkills: () => [],
		readSkill: async () => new Uint8Array([1]),
	};
	const driver = await SessionRuntimeDriver.open({
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
		cursorPrefix: "test",
		skillDirectory,
		retireSession: async () => {},
		completionStatus: () => "completed",
		openSession: async (options) => {
			observed.push({ skillDirectory: options.skillDirectory });
			return {
				nativeId: "native-a",
				select: async () => {},
				prompt: async () => ({ stopReason: "completed" }),
				cancel: async () => {},
				close: async () => {},
			};
		},
	});
	try {
		const input: RuntimeDriverCommand = {
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			input: { text: "hello", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		};
		const result = await driver.execute(input);
		expect(result.result.outcome).toBe("accepted");
		expect(observed).toHaveLength(1);
		expect(observed[0]?.skillDirectory).toBe(skillDirectory);
		const untrustedInput = { ...input, skillDirectory: replacement };
		await expect(
			driver.execute(untrustedInput as Parameters<typeof driver.execute>[0]),
		).rejects.toThrow();
		expect(observed).toHaveLength(1);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("forwards the deployment Skill Hub directory through Pi and ACP driver seams", async () => {
	const skillDirectory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "c".repeat(64),
		findSkills: () => [],
		readSkill: async () => new Uint8Array(),
	};
	const open = vi
		.spyOn(SessionRuntimeDriver, "open")
		.mockResolvedValue({} as SessionRuntimeDriver);
	try {
		const shared = {
			path: "/tmp/runtime-driver-test",
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
			skillDirectory,
		};
		await PiRuntimeDriver.open({
			...shared,
			launch: async () => ({ command: process.execPath, args: [], env: {} }),
		});
		expect(open.mock.calls[0]?.[0].skillDirectory).toBe(skillDirectory);
		open.mockClear();
		await GenericAcpRuntimeDriver.open({
			...shared,
			launch: async () => ({ command: process.execPath, args: [], env: {} }),
		});
		expect(open.mock.calls[0]?.[0].skillDirectory).toBe(skillDirectory);
	} finally {
		open.mockRestore();
	}
});

it("discovers and reads the bound Skill projection with generation revalidation", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-skill-reader-"));
	let generationId = "d".repeat(64);
	const entry = {
		schemaVersion: 1 as const,
		name: "workspace-summary",
		version: "1.0.0",
		packageDigest: "e".repeat(64),
		manifestDigest: "f".repeat(64),
		targetPath: ".agents/skills/workspace-summary",
		readOnly: true as const,
	};
	const readGate = Promise.withResolvers<void>();
	const directory: RuntimeFilesystemSkillDirectoryV1 = {
		get generationId() {
			return generationId;
		},
		findSkills: () => [entry],
		readSkill: async () => {
			await readGate.promise;
			return new Uint8Array([7, 8, 9]);
		},
	};
	const driver = await SessionRuntimeDriver.open({
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
		cursorPrefix: "test",
		skillDirectory: directory,
		retireSession: async () => {},
		completionStatus: () => "completed",
		openSession: async () => ({
			nativeId: "native-a",
			select: async () => {},
			prompt: async () => ({ stopReason: "completed" }),
			cancel: async () => {},
			close: async () => {},
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
			input: { text: "hello", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		const read = {
			nativeSessionRef: accepted.nativeSessionRef,
			signal: new AbortController().signal,
			expiresAt: Date.now() + 10_000,
			assertCurrent: () => {},
			revalidate: async () => {},
		};
		expect(await driver.discoverNativeSkills(read)).toEqual({
			generationId,
			entries: [entry],
		});
		await expect(
			driver.discoverNativeSkills({
				...read,
				expiresAt: Date.now() - 1,
			}),
		).rejects.toMatchObject({
			code: "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE",
		});
		const held = Promise.withResolvers<void>();
		await expect(
			driver.discoverNativeSkills({
				...read,
				expiresAt: Date.now() + 10,
				revalidate: () => held.promise,
			}),
		).rejects.toMatchObject({
			code: "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE",
		});
		held.resolve();
		const cancelledController = new AbortController();
		const cancelledGate = Promise.withResolvers<void>();
		const cancelled = driver.discoverNativeSkills({
			...read,
			signal: cancelledController.signal,
			revalidate: () => cancelledGate.promise,
		});
		cancelledController.abort();
		await expect(cancelled).rejects.toMatchObject({
			code: "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE",
		});
		cancelledGate.resolve();
		const pending = driver.readNativeSkill(read, entry.name, "SKILL.md");
		await Promise.resolve();
		generationId = "0".repeat(64);
		readGate.resolve();
		await expect(pending).rejects.toMatchObject({
			code: "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE",
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("observes an already-started expired Skill read without an unhandled rejection", async () => {
	const pending = Promise.reject(new Error("late read failure"));
	await expect(
		boundedRuntimeSkillRead({
			pending,
			signal: new AbortController().signal,
			expiresAt: Date.now() - 1,
		}),
	).rejects.toMatchObject({
		code: "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE",
	});
});

it("keeps the Skill Hub directory unavailable when no binding is configured", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-skill-binding-absent-"));
	const observed: { skillDirectory?: RuntimeFilesystemSkillDirectoryV1 }[] = [];
	const driver = await SessionRuntimeDriver.open({
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
		cursorPrefix: "test",
		retireSession: async () => {},
		completionStatus: () => "completed",
		openSession: async (options) => {
			observed.push({ skillDirectory: options.skillDirectory });
			return {
				nativeId: "native-a",
				select: async () => {},
				prompt: async () => ({ stopReason: "completed" }),
				cancel: async () => {},
				close: async () => {},
			};
		},
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
			input: { text: "hello", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		expect(observed).toHaveLength(1);
		expect(observed[0]?.skillDirectory).toBeUndefined();
		await expect(
			driver.discoverNativeSkills({
				nativeSessionRef: accepted.nativeSessionRef,
				signal: new AbortController().signal,
				expiresAt: Date.now() + 10_000,
				assertCurrent: () => {},
				revalidate: async () => {},
			}),
		).rejects.toMatchObject({
			code: "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE",
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});
