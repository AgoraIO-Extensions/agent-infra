import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { GenericAcpRuntimeDriver } from "./acp-runtime-driver.js";
import type { RuntimeDriverCommand } from "./driver.js";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

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
		await driver.execute({
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
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});
