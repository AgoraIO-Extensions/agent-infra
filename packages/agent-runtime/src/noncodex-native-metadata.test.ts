import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	RuntimeNativeMetadataReadContextV1,
	RuntimeOriginalEvidenceBinding,
} from "./driver.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

const directories: string[] = [];
const authority: RuntimeOriginalEvidenceBinding = {
	principal: { kind: "user", id: "reader-1" },
	scope: {
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		sessionGeneration: 1,
	},
};

function metadataRead(
	nativeSessionRef: string,
	overrides: Partial<RuntimeNativeMetadataReadContextV1> = {},
): RuntimeNativeMetadataReadContextV1 {
	return {
		nativeSessionRef,
		signal: new AbortController().signal,
		expiresAt: Date.now() + 10_000,
		assertCurrent: () => authority,
		revalidate: async () => authority,
		...overrides,
	};
}

async function openFixture(
	skillDirectory: RuntimeFilesystemSkillDirectoryV1,
	discoverCommands = true,
) {
	const path = await mkdtemp(join(tmpdir(), "noncodex-native-metadata-"));
	directories.push(path);
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
		cursorPrefix: "acp",
		skillDirectory,
		retireSession: async () => {},
		completionStatus: () => "completed",
		openSession: async () => ({
			nativeId: "native-a",
			select: async () => {},
			prompt: async () => ({ stopReason: "completed" }),
			...(discoverCommands
				? {
						discoverCommands: async () => ({
							nativeId: "native-a",
							commands: [
								{
									name: "compact",
									description: "Compact the current session",
									input: { hint: "" },
								},
							],
							readAt: Date.now(),
						}),
					}
				: {}),
			cancel: async () => {},
			close: async () => {},
		}),
	});
	const accepted = await driver.execute({
		schemaVersion: 2,
		kind: "submit-turn",
		agentId: "agent-1",
		conversationId: "conversation-1",
		sessionGeneration: 1,
		executionId: "execution-1",
		turnId: "turn-1",
		operationId: "operation-1",
		input: { text: "hello", attachments: [] },
		selection: {
			schemaVersion: 1,
			modelOptionId: "primary",
			reasoningLevel: "high",
		},
	});
	return { driver, nativeSessionRef: accepted.nativeSessionRef };
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

describe("SessionRuntimeDriver native metadata selectors", () => {
	it("projects commands and Skills while rejecting unsupported status", async () => {
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
		const fixture = await openFixture(skillDirectory);
		const read = metadataRead(fixture.nativeSessionRef);
		try {
			expect(
				await fixture.driver.readNativeMetadataV1("commands", read),
			).toMatchObject({
				selector: "commands",
				capabilities: [{ name: "compact" }],
			});
			expect(
				await fixture.driver.readNativeMetadataV1("skills", read),
			).toMatchObject({
				selector: "skills",
				capabilities: [{ name: "workspace-summary" }],
			});
			await expect(
				fixture.driver.readNativeMetadataV1("status", read),
			).rejects.toMatchObject({ code: "RUNTIME_NATIVE_METADATA_UNSUPPORTED" });
		} finally {
			await fixture.driver.close();
		}
	});

	it("fails closed when the read is cancelled, retired, or the Skill generation drifts", async () => {
		let generationId = "d".repeat(64);
		const skillDirectory: RuntimeFilesystemSkillDirectoryV1 = {
			get generationId() {
				return generationId;
			},
			findSkills: () => [],
			readSkill: async () => new Uint8Array(),
		};
		const fixture = await openFixture(skillDirectory, false);
		try {
			const cancelledController = new AbortController();
			const cancelledRead = metadataRead(fixture.nativeSessionRef, {
				signal: cancelledController.signal,
			});
			cancelledController.abort();
			await expect(
				fixture.driver.readNativeMetadataV1("skills", cancelledRead),
			).rejects.toMatchObject({ code: "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE" });

			let revalidations = 0;
			await expect(
				fixture.driver.readNativeMetadataV1(
					"skills",
					metadataRead(fixture.nativeSessionRef, {
						revalidate: async () => {
							revalidations++;
							if (revalidations === 2) generationId = "e".repeat(64);
							return authority;
						},
					}),
				),
			).rejects.toMatchObject({ code: "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE" });

			await fixture.driver.close();
			await expect(
				fixture.driver.readNativeMetadataV1(
					"skills",
					metadataRead(fixture.nativeSessionRef),
				),
			).rejects.toMatchObject({ code: "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE" });
		} finally {
			await fixture.driver.close();
		}
	});
});
