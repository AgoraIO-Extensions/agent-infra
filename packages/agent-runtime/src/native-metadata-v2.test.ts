import { NativeMetadataCommandsProjectionV2Schema } from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import { projectNativeMetadataCommandsV2 } from "./native-metadata-projection.js";

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
