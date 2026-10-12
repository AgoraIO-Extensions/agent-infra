import { describe, expect, it } from "vitest";
import {
	projectNativeMetadataCommandsV1,
	projectNativeMetadataSkillsV1,
} from "./native-metadata-projection.js";

const nativeSessionRef = "native-session-1";
const commandDirectory = [
	{
		name: "compact",
		description: "Compact the current session",
		argumentHint: "",
		aliases: ["shrink"],
	},
];
const skillEntry = {
	schemaVersion: 1,
	name: "workspace-summary",
	version: "1.0.0",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	targetPath: ".agents/skills/workspace-summary",
	readOnly: true,
};

const projectCommands = (directory: unknown = commandDirectory) =>
	projectNativeMetadataCommandsV1({
		nativeSessionRef,
		configVersion: "configuration-a",
		source: { name: "acp", version: "1" },
		directory,
	});

const projectSkills = (
	directory: unknown = {
		generationId: "c".repeat(64),
		entries: [skillEntry],
	},
) =>
	projectNativeMetadataSkillsV1({
		nativeSessionRef,
		configVersion: "configuration-a",
		sourceName: "agent-infra-skill-hub",
		directory,
	});

describe("non-Codex native metadata projection", () => {
	it("projects bounded command metadata with stable identity", () => {
		const first = projectCommands({
			nativeId: nativeSessionRef,
			commands: [
				{
					...commandDirectory[0],
					description: "Compact\n the\tcurrent session",
				},
			],
			readAt: 1,
		});
		const second = projectCommands({
			nativeId: nativeSessionRef,
			commands: [
				{
					...commandDirectory[0],
					description: "Compact\n the\tcurrent session",
				},
			],
			readAt: Date.now(),
		});
		expect(first).toEqual(second);
		expect(first).toMatchObject({
			selector: "commands",
			revision: expect.stringMatching(/^[a-f0-9]{64}$/),
			capabilities: [
				{
					kind: "command",
					name: "compact",
					description: "Compact  the current session",
					source: { name: "acp", version: "1" },
					parameters: [],
					effect: "read_only",
					availability: "available",
				},
			],
		});
	});

	it("rejects malformed or duplicate command records", () => {
		for (const value of [
			[{ name: "compact", description: "ok", aliases: ["compact"] }],
			[
				{ name: "compact", description: "one" },
				{ name: "compact", description: "two" },
			],
			{ nativeId: "\u0000", commands: commandDirectory },
		])
			expect(() => projectCommands(value)).toThrow(
				"Native metadata projection is unavailable",
			);
	});

	it("binds Skill capability identity to the mounted generation", () => {
		const first = projectSkills();
		const second = projectSkills({
			generationId: "d".repeat(64),
			entries: [skillEntry],
		});
		if (first.selector !== "skills" || second.selector !== "skills")
			throw new Error("unexpected projection selector");
		expect(first.revision).not.toBe(second.revision);
		expect(first).toMatchObject({
			selector: "skills",
			capabilities: [
				{
					kind: "skill",
					name: "workspace-summary",
					source: { name: "agent-infra-skill-hub", version: "1.0.0" },
					availability: "discovered",
				},
			],
		});
	});

	it("rejects malformed Skill entries and unbounded generations", () => {
		expect(() =>
			projectSkills({ generationId: "not-a-digest", entries: [] }),
		).toThrow("Native metadata projection is unavailable");
		expect(() =>
			projectSkills({
				generationId: "c".repeat(64),
				entries: [{ ...skillEntry, readOnly: false }],
			}),
		).toThrow("Native metadata projection is unavailable");
	});
});
