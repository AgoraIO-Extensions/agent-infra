import { describe, expect, it } from "vitest";
import {
	NativeCapabilityInvocationRequestV1Schema,
	NativeCapabilityInvocationRequestV2Schema,
} from "./native-capability.ts";

const original = {
	capabilityId: "a".repeat(64),
	directoryRevision: "b".repeat(64),
	parameters: "Summarize the authorized text inputs.",
	idempotencyKey: "controlled-native-files-request",
	requestId: "controlled-native-files-request",
	traceId: "controlled-native-files-trace",
};
const withFiles = {
	...original,
	schemaVersion: 2,
	attachments: ["controlled-file-a", "controlled-file-b"],
};

describe("versioned native Skill file inputs", () => {
	it("keeps the old strict request exact and requires the explicit new version", () => {
		expect(NativeCapabilityInvocationRequestV1Schema.parse(original)).toEqual(
			original,
		);
		expect(
			NativeCapabilityInvocationRequestV1Schema.safeParse(withFiles).success,
		).toBe(false);
		expect(NativeCapabilityInvocationRequestV2Schema.parse(withFiles)).toEqual(
			withFiles,
		);
		expect(
			NativeCapabilityInvocationRequestV2Schema.safeParse(original).success,
		).toBe(false);
	});

	it.each([
		{ attachments: [] },
		{
			attachments: Array.from({ length: 5 }, (_, i) => `controlled-file-${i}`),
		},
		{ attachments: ["controlled-file-a", "controlled-file-a"] },
		{ attachments: [""] },
		{ attachments: [null] },
		{ schemaVersion: 1 },
		{ actorId: "caller-selected-subject" },
		{ root: "/caller-selected-workspace" },
		{ grant: "caller-selected-grant" },
	])("rejects invalid or caller-selected file authority %j", (change) => {
		expect(
			NativeCapabilityInvocationRequestV2Schema.safeParse({
				...withFiles,
				...change,
			}).success,
		).toBe(false);
	});
});
