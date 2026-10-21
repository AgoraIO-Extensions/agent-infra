import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

async function readArtifact(path: string) {
	return JSON.parse(
		await readFile(new URL(`../../artifacts/${path}`, import.meta.url), "utf8"),
	);
}

const attachment = {
	attachmentId: "file-a",
	sha256: "d".repeat(64),
	byteLength: 12,
	mediaType: "text/plain",
};

const request = {
	schemaVersion: 5,
	requestId: "request-1",
	traceId: "trace-1",
	principal: { kind: "user", id: "alice" },
	executionSource: "web",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	hostSessionRef: "session-1",
	operation: {
		kind: "execution",
		id: "execution-1",
		deliveryFence: 2,
		executionDeliveryFence: 2,
	},
	grant: { schemaVersion: 4, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
	capabilityKind: "skill",
	capabilityId: "a".repeat(64),
	directoryRevision: "b".repeat(64),
	parameters: "summarize the control files",
	parametersDigest: "c".repeat(64),
	capabilitySourceVersion: "source-version-1",
	attachments: [attachment],
};

describe("RuntimeHost V5 published artifacts", () => {
	it("publishes the Native V5 and Restore V5 paths with private Key delivery", async () => {
		const openapi = await readArtifact("openapi/runtime-host.v5.openapi.json");
		for (const [path, requestSchema, responseSchema, requiredField] of [
			[
				"native-capability",
				"RuntimeNativeCapabilityTransportV5",
				"RuntimeOperationResponseV5",
				"businessRequest",
			],
			[
				"execution-key/restore",
				"RuntimeRestoreExecutionKeyTransportV5",
				"RuntimeRestoreExecutionKeyResponseV5",
				"recoveryRequest",
			],
		] as const) {
			const operation = openapi.paths[`/internal/runtime/v5/${path}`].post;
			expect(
				operation.requestBody.content["application/json"].schema.$ref,
			).toBe(`#/components/schemas/${requestSchema}`);
			expect(
				operation.responses["200"].content["application/json"].schema.$ref,
			).toBe(`#/components/schemas/${responseSchema}`);
			expect(openapi.components.schemas[requestSchema].required).toEqual([
				requiredField,
				"privateKeyField",
			]);
		}
	});

	it("publishes the bounded text attachment contract and both versions", async () => {
		const openapi = await readArtifact("openapi/runtime-host.v5.openapi.json");
		const jsonSchema = await readArtifact("json-schema/runtime.v5.schema.json");
		const attachment =
			openapi.components.schemas.RuntimeReadOnlyTextAttachmentV5;
		expect(attachment.additionalProperties).toBe(false);
		expect(attachment.required).toEqual([
			"attachmentId",
			"sha256",
			"byteLength",
			"mediaType",
		]);
		expect(attachment.properties.mediaType.const).toBe("text/plain");
		expect(attachment.properties.byteLength.maximum).toBe(4096);
		const request = openapi.components.schemas.RuntimeNativeCapabilityRequestV5;
		expect(request.properties.capabilityKind.const).toBe("skill");
		expect(request.properties.schemaVersion.const).toBe(5);
		expect(request.properties.attachments.minItems).toBe(1);
		expect(request.properties.attachments.maxItems).toBe(4);
		expect(request.properties.attachments.items.$ref).toBe(
			"#/components/schemas/RuntimeReadOnlyTextAttachmentV5",
		);
		for (const name of [
			"RuntimeNativeCapabilityRequestV5",
			"RuntimeReadOnlyTextAttachmentV5",
			"RuntimeRestoreExecutionKeyRequestV5",
			"RuntimeRestoreExecutionKeyGrantClaimsV5",
		]) {
			expect(jsonSchema.$defs[name]).toBeDefined();
		}
	});

	it("validates Native V5 with the published JSON Schema", async () => {
		const jsonSchema = await readArtifact("json-schema/runtime.v5.schema.json");
		const validate = new Ajv2020({
			strictSchema: false,
			strictTuples: false,
			validateFormats: false,
		}).compile({
			$defs: jsonSchema.$defs,
			$ref: "#/$defs/RuntimeNativeCapabilityRequestV5",
		});
		expect(validate(request)).toBe(true);
		for (const changed of [
			{ capabilityKind: "command" },
			{ schemaVersion: 4 },
			{ attachments: [] },
			{ attachments: [{ ...attachment, mediaType: "text/markdown" }] },
			{ attachments: [{ ...attachment, byteLength: 4097 }] },
			{ attachments: Array.from({ length: 5 }, () => attachment) },
		]) {
			expect(validate({ ...request, ...changed })).toBe(false);
		}
	});
});
