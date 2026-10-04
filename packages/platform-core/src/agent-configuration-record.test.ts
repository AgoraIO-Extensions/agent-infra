import { describe, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "./agent-configuration.conformance.ts";
import {
	decodeAgentConfigurationRecord,
	decodeAgentConfigurationRecordV2,
	decodeAgentConfigurationRecordV3,
} from "./agent-configuration-record.ts";

function keylessRecord() {
	const old = structuredClone(agentConfigurationConformanceRecordV1);
	const model = old.modelConfiguration;
	if (!model) throw new Error("missing model fixture");
	return {
		...old,
		schemaVersion: 3,
		modelConfiguration: {
			...model,
			options: model.options.map(
				({ credential: _credential, ...option }) => option,
			),
		},
	};
}

describe("Versioned Agent model configuration", () => {
	it("reads credential-free V3 and refuses silent downgrade through the V2 decoder", () => {
		const record = keylessRecord();
		expect(decodeAgentConfigurationRecordV3(record)).toEqual(record);
		expect(decodeAgentConfigurationRecord(record)).toEqual(record);
		expect(() => decodeAgentConfigurationRecordV2(record)).toThrow();
	});
	it("retains V2 credentials and refuses to reinterpret them as V3", () => {
		expect(
			decodeAgentConfigurationRecordV2(agentConfigurationConformanceRecordV1),
		).toEqual(agentConfigurationConformanceRecordV1);
		expect(() =>
			decodeAgentConfigurationRecordV3({
				...agentConfigurationConformanceRecordV1,
				schemaVersion: 3,
			}),
		).toThrow();
	});
	it.each(["credential", "keyReference", "credentialValue"])(
		"rejects unexpected V3 option %s",
		(field) => {
			const record = keylessRecord();
			const option = record.modelConfiguration.options[0];
			if (!option) throw new Error("missing option");
			Object.assign(option, { [field]: "forbidden" });
			expect(() => decodeAgentConfigurationRecordV3(record)).toThrow();
		},
	);
	it("preserves the legacy canonical property order used by Store integrity checks", () => {
		expect(
			JSON.stringify(
				decodeAgentConfigurationRecordV2(agentConfigurationConformanceRecordV1),
			),
		).toBe(JSON.stringify(agentConfigurationConformanceRecordV1));
	});

	it("rejects V3 custom sources and missing model selection", () => {
		const record = keylessRecord();
		expect(() =>
			decodeAgentConfigurationRecordV3({ ...record, modelConfiguration: null }),
		).toThrow();
		expect(() =>
			decodeAgentConfigurationRecordV3({
				...record,
				source: {
					kind: "custom",
					imageDigest: `sha256:${"a".repeat(64)}`,
					admissionRevision: "image-1",
					interactionMode: "platform-adapter",
					connectionEnabled: false,
				},
				modelConfiguration: null,
			}),
		).toThrow();
	});

	it("rejects duplicate option ids and invalid default reasoning", () => {
		const record = keylessRecord();
		expect(() =>
			decodeAgentConfigurationRecordV3({
				...record,
				modelConfiguration: {
					...record.modelConfiguration,
					options: [
						...record.modelConfiguration.options,
						...record.modelConfiguration.options,
					],
				},
			}),
		).toThrow();
		expect(() =>
			decodeAgentConfigurationRecordV3({
				...record,
				modelConfiguration: {
					...record.modelConfiguration,
					defaultReasoningLevel: "invalid",
				},
			}),
		).toThrow();
	});
});
