import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
		const result = await driver.execute({
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
		expect(result.result.outcome).toBe("accepted");
		expect(observed).toHaveLength(1);
		expect(observed[0]?.skillDirectory).toBe(skillDirectory);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
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
