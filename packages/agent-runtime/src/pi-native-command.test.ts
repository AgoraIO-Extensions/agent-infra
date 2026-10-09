import { expect, it } from "vitest";
import {
	parsePiGetCommandsV1,
	readPiNativeCommandsV1,
} from "./pi-native-command.js";

const valid = {
	commands: [
		{
			name: "compact",
			description: "Compact the current session",
			source: "extension",
		},
		{
			name: "workspace-summary",
			description: "Read the approved workspace summary",
			source: "skill",
			location: "user",
			path: "/runtime/skills/workspace-summary/SKILL.md",
		},
	],
};

it("strictly parses and sorts the fixed Pi get_commands projection", () => {
	expect(
		parsePiGetCommandsV1(valid, {
			allowedRoots: ["/runtime/skills"],
		}),
	).toEqual([valid.commands[0], valid.commands[1]]);
});

it.each([
	["unknown response field", { ...valid, extra: true }],
	["duplicate command", { commands: [valid.commands[0], valid.commands[0]] }],
	["skill without path", { commands: [{ name: "skill", source: "skill" }] }],
	[
		"path escape",
		{
			commands: [
				{
					name: "skill",
					source: "skill",
					path: "/runtime/skills/../secret/SKILL.md",
				},
			],
		},
	],
	[
		"relative path",
		{
			commands: [
				{
					name: "skill",
					source: "skill",
					path: "secret/SKILL.md",
				},
			],
		},
	],
	[
		"approved path without a root",
		{
			commands: [
				{
					name: "skill",
					source: "skill",
					path: "/runtime/skills/SKILL.md",
				},
			],
		},
	],
	[
		"oversized UTF-8 description",
		{
			commands: [
				{
					name: "compact",
					source: "extension",
					description: "你".repeat(1024),
				},
			],
		},
	],
])("rejects %s", (_name, value) => {
	expect(() => parsePiGetCommandsV1(value)).toThrow(
		"RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE",
	);
});

it("binds the parsed directory to the native session and deadline", async () => {
	const controller = new AbortController();
	const result = await readPiNativeCommandsV1({
		nativeId: "pi-session-a",
		expiresAt: Date.now() + 1000,
		signal: controller.signal,
		request: async () => valid,
		allowedRoots: ["/runtime/skills"],
	});
	expect(result.nativeId).toBe("pi-session-a");
	expect(result.commands).toHaveLength(2);
	expect(result.readAt).toBeGreaterThan(0);
});

it("cancels a pending read and closes the native session", async () => {
	const controller = new AbortController();
	let closed = false;
	const pending = readPiNativeCommandsV1({
		nativeId: "pi-session-a",
		expiresAt: Date.now() + 10_000,
		signal: controller.signal,
		request: () => new Promise(() => {}),
		close: async () => {
			closed = true;
		},
	});
	controller.abort();
	await expect(pending).rejects.toThrow(
		"RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE",
	);
	expect(closed).toBe(true);
});
