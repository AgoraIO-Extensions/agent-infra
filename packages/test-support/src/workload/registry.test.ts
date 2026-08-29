import {
	type ImageRegistryAdmissionResultV1,
	ImageRegistryAdmissionResultV1Schema,
} from "@agent-infra/contracts/workload";
import { describe, expect, it } from "vitest";

import { createFakeImageRegistryAdapterV1 } from "./registry.js";

const request = {
	schemaVersion: 1,
	requestId: "request_registry_01",
	traceId: "trace_registry_01",
	subjectRef: "subject_01",
	agentId: "agent_01",
	imageReference: "registry.example/agents/codex:pilot",
	usage: "standard-template",
	admissionPolicyRef: "policy/pilot-v1",
} as const;

const runtimeManifestLabel = JSON.stringify({
	schemaVersion: 1,
	interactionMode: "platform-adapter",
	protocol: "acp",
	service: { port: 8080 },
	health: { path: "/healthz" },
});

const admittedOutcome = {
	status: "admitted",
	immutableDigest: `sha256:${"a".repeat(64)}`,
	ociConfig: {
		schemaVersion: 1,
		configDigest: `sha256:${"b".repeat(64)}`,
		operatingSystem: "linux",
		architecture: "amd64",
	},
	runtimeManifest: {
		schemaVersion: 1,
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 8080 },
		health: { path: "/healthz" },
	},
	runtimeManifestLabel,
	runtimeManifestParsingEvidence: {
		schemaVersion: 1,
		labelName: "io.agora.agent.runtime.manifest",
		utf8ByteLength: Buffer.byteLength(runtimeManifestLabel, "utf8"),
		maxDepth: 3,
		duplicateKeysDetected: false,
		unknownFieldsDetected: false,
	},
	policyEvidence: {
		schemaVersion: 1,
		policyRef: request.admissionPolicyRef,
		decisionRef: "decision_01",
		evaluatedAt: "2026-08-28T10:00:00Z",
	},
} as const;

describe("Fake ImageRegistryAdapter V1", () => {
	it("returns a schema-valid admitted result correlated to the request", async () => {
		const adapter = createFakeImageRegistryAdapterV1({
			[request.imageReference]: admittedOutcome,
		});

		const result = await adapter.admit(request);
		expect(ImageRegistryAdmissionResultV1Schema.parse(result)).toEqual(result);
		expect(result).toMatchObject({
			status: "admitted",
			requestId: request.requestId,
			traceId: request.traceId,
			imageReference: request.imageReference,
		});
	});

	it("returns a stable fail-closed rejection for an unknown image", async () => {
		const adapter = createFakeImageRegistryAdapterV1({});
		const result: ImageRegistryAdmissionResultV1 = await adapter.admit(request);

		expect(result.status).toBe("rejected");
		if (result.status === "rejected") {
			expect(result.error).toMatchObject({
				code: "IMAGE_NOT_ADMITTED",
				retryable: false,
				traceId: request.traceId,
			});
		}
	});

	it("rejects malformed configured outcomes instead of bypassing the schema", async () => {
		const adapter = createFakeImageRegistryAdapterV1({
			[request.imageReference]: {
				...admittedOutcome,
				immutableDigest: "mutable:tag",
			},
		});

		await expect(adapter.admit(request)).rejects.toThrow();
	});
});
