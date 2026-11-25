import { NativeMetadataCommandsProjectionV2Schema } from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import {
	projectDiscoveredPaseoCommands,
	projectNativeMetadataCommandsV2,
} from "./native-metadata-projection.js";

const input = {
	nativeSessionRef: "native-session-1",
	configVersion: "configuration-a",
	source: { name: "Claude", version: "0.3.246" },
	directory: {
		nativeId: "native-directory-1",
		commands: [
			{
				name: "compact",
				description: "Compact the current session",
				argumentHint: "optional instructions",
			},
		],
	},
};

describe("native metadata command V2", () => {
	it.each([
		["pi", { autoCompactionVersion: "1" }, "autocompact", 1],
		["codex", { compactVersion: "1" }, "compact", 0],
		["acp", { openCodeReviewVersion: "1" }, "review", 0],
	] as const)(
		"keeps %s callable commands scoped to its provider",
		(provider, version, name, parameters) => {
			const projection = projectDiscoveredPaseoCommands({
				nativeSessionRef: "original-session",
				nativeId: "paseo:original-session",
				configVersion: "configuration-a",
				...version,
				directory: {
					nativeId: "paseo:original-session",
					commands: ["autocompact", "compact", "review", "goal"].map(
						(name) => ({
							name,
							description: name,
							argumentHint: "",
							kind: "command",
						}),
					),
				},
			});
			expect(projection.capabilities).toHaveLength(1);
			expect(projection.capabilities[0]).toMatchObject({
				name,
				source: { name: provider, version: "1" },
				effect: "state_changing",
			});
			expect(projection.capabilities[0]?.parameters).toHaveLength(parameters);
			expect(
				projection.discoveredCommands?.map((row) => row.name),
			).not.toContain(name);
		},
	);
	it("exposes SDK Codex compact while goal remains discovery only", () => {
		const projection = projectDiscoveredPaseoCommands({
			nativeSessionRef: "original-session",
			nativeId: "paseo:original-session",
			configVersion: "configuration-a",
			compactVersion: "0.153.0",
			directory: {
				nativeId: "paseo:original-session",
				commands: [
					{
						name: "compact",
						description: "Compact",
						argumentHint: "",
						kind: "command",
					},
					{
						name: "goal",
						description: "Goal",
						argumentHint: "objective",
						kind: "command",
					},
				],
			},
		});
		expect(projection.capabilities).toEqual([
			expect.objectContaining({
				name: "compact",
				source: { name: "codex", version: "0.153.0" },
				effect: "state_changing",
				parameters: [],
			}),
		]);
		expect(projection.discoveredCommands?.map((row) => row.name)).toEqual([
			"goal",
		]);
	});
	it("keeps state-changing effect and bounded argument hints", () => {
		const projection = projectNativeMetadataCommandsV2({
			...input,
			effect: "state_changing",
		});
		expect(
			NativeMetadataCommandsProjectionV2Schema.safeParse(projection).success,
		).toBe(true);
		expect(projection.capabilities[0]).toMatchObject({
			schemaVersion: 2,
			effect: "state_changing",
			parameters: [
				{ kind: "text", required: false, hint: "optional instructions" },
			],
		});
	});

	it("does not let V1 represent the new effect", () => {
		const projection = projectNativeMetadataCommandsV2({
			...input,
			effect: "state_changing",
		});
		const capability = projection.capabilities[0];
		if (!capability) throw new Error("Missing command capability");
		expect(capability.schemaVersion).toBe(2);
		expect(capability.effect).not.toBe("read_only");
	});
});
