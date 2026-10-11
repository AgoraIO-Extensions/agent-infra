import { describe, expect, it } from "vitest";
import {
	createAcpNativeCommandDirectoryV1,
	parseAcpAvailableCommandsV1,
} from "./acp-native-command.js";

describe("ACP native command parser", () => {
	it("bounds, normalizes and sorts available commands", () => {
		expect(
			parseAcpAvailableCommandsV1([
				{
					name: "zeta",
					description: "Z",
				},
				{
					name: "alpha",
					description: "A",
					input: { hint: "topic" },
				},
			]),
		).toEqual([
			{
				name: "alpha",
				description: "A",
				argumentHint: "topic",
				source: "acp",
			},
			{ name: "zeta", description: "Z", source: "acp" },
		]);
	});

	it.each([
		[
			"duplicate names",
			[
				{ name: "same", description: "one" },
				{ name: "same", description: "two" },
			],
		],
		["unknown fields", [{ name: "known", description: "ok", extra: true }]],
		[
			"malformed input hint",
			[{ name: "known", description: "ok", input: { hint: 1 } }],
		],
	] as const)("rejects %s", (_name, value) => {
		expect(() => parseAcpAvailableCommandsV1(value)).toThrow(
			"RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE",
		);
	});

	it("binds the parsed directory to the native session id", () => {
		expect(
			createAcpNativeCommandDirectoryV1({
				nativeId: "session-1",
				commands: [{ name: "compact", description: "Compact" }],
				readAt: 123,
			}),
		).toEqual({
			nativeId: "session-1",
			commands: [{ name: "compact", description: "Compact", source: "acp" }],
			readAt: 123,
		});
	});
});
