import { describe, expect, it } from "vitest";

import {
	ImageRegistryAdmissionRequestV1Schema,
	ImageRegistryAdmissionResultV1Schema,
	validateImageRegistryAdmissionResultV1,
} from "../../src/workload/registry.js";

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
	capabilities: { modelSelection: true, connection: true },
});

const admitted = {
	schemaVersion: 1,
	status: "admitted",
	requestId: request.requestId,
	traceId: request.traceId,
	imageReference: request.imageReference,
	immutableDigest: `sha256:${"a".repeat(64)}`,
	ociConfig: {
		schemaVersion: 1,
		configDigest: `sha256:${"b".repeat(64)}`,
		operatingSystem: "linux",
		architecture: "amd64",
		entrypoint: ["node"],
		command: ["dist/index.mjs"],
		declaredEnvKeys: ["MODEL_ENDPOINT"],
	},
	runtimeManifest: {
		schemaVersion: 1,
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 8080 },
		health: { path: "/healthz" },
		capabilities: {
			modelSelection: true,
			attachments: false,
			resultFiles: false,
			connection: true,
			supplementaryInstruction: false,
		},
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
		imageDigest: `sha256:${"a".repeat(64)}`,
		evaluatedAt: "2026-08-28T10:00:00Z",
	},
} as const;

describe("ImageRegistryAdapter V1 contract", () => {
	it("accepts an admitted immutable image without leaking deployment details", () => {
		expect(ImageRegistryAdmissionRequestV1Schema.parse(request)).toEqual(
			request,
		);
		expect(ImageRegistryAdmissionResultV1Schema.parse(admitted)).toEqual(
			admitted,
		);
		expect(validateImageRegistryAdmissionResultV1(request, admitted)).toEqual(
			admitted,
		);
	});

	it("fails closed when a result returns a mutable image reference or extra secrets", () => {
		expect(
			ImageRegistryAdmissionResultV1Schema.safeParse({
				...admitted,
				runtimeManifestParsingEvidence: {
					...admitted.runtimeManifestParsingEvidence,
					duplicateKeysDetected: true,
				},
			}).success,
		).toBe(false);
		expect(
			ImageRegistryAdmissionResultV1Schema.safeParse({
				...admitted,
				immutableDigest: "registry.example/agents/codex:pilot",
			}).success,
		).toBe(false);
		expect(
			ImageRegistryAdmissionResultV1Schema.safeParse({
				...admitted,
				registryCredential: "must-not-cross-the-port",
			}).success,
		).toBe(false);
		expect(
			ImageRegistryAdmissionResultV1Schema.safeParse({
				...admitted,
				registryProduct: "vendor-specific-registry",
			}).success,
		).toBe(false);
	});

	it("rejects a result correlated to another request or image", () => {
		expect(() =>
			validateImageRegistryAdmissionResultV1(request, {
				...admitted,
				requestId: "request_registry_02",
			}),
		).toThrow("Image registry result correlation mismatch");
		expect(() =>
			validateImageRegistryAdmissionResultV1(request, {
				...admitted,
				runtimeManifestParsingEvidence: {
					...admitted.runtimeManifestParsingEvidence,
					utf8ByteLength:
						admitted.runtimeManifestParsingEvidence.utf8ByteLength + 1,
				},
			}),
		).toThrow("Image registry result correlation mismatch");
		expect(() =>
			validateImageRegistryAdmissionResultV1(request, {
				...admitted,
				imageReference: "registry.example/agents/other:pilot",
			}),
		).toThrow("Image registry result correlation mismatch");
		expect(() =>
			validateImageRegistryAdmissionResultV1(request, {
				...admitted,
				policyEvidence: {
					...admitted.policyEvidence,
					policyRef: "policy/other",
				},
			}),
		).toThrow("Image registry result correlation mismatch");
		expect(() =>
			validateImageRegistryAdmissionResultV1(request, {
				...admitted,
				policyEvidence: {
					...admitted.policyEvidence,
					imageDigest: `sha256:${"c".repeat(64)}`,
				},
			}),
		).toThrow("Image registry result correlation mismatch");
	});

	it("rejects invalid or semantically mismatched Runtime Manifest labels", () => {
		const invalidJson = "{";
		expect(() =>
			validateImageRegistryAdmissionResultV1(request, {
				...admitted,
				runtimeManifestLabel: invalidJson,
				runtimeManifestParsingEvidence: {
					...admitted.runtimeManifestParsingEvidence,
					utf8ByteLength: Buffer.byteLength(invalidJson, "utf8"),
				},
			}),
		).toThrow("Image registry Runtime Manifest mismatch");

		const mismatchedLabel = JSON.stringify({
			...admitted.runtimeManifest,
			health: { path: "/ready" },
		});
		expect(() =>
			validateImageRegistryAdmissionResultV1(request, {
				...admitted,
				runtimeManifestLabel: mismatchedLabel,
				runtimeManifestParsingEvidence: {
					...admitted.runtimeManifestParsingEvidence,
					utf8ByteLength: Buffer.byteLength(mismatchedLabel, "utf8"),
				},
			}),
		).toThrow("Image registry Runtime Manifest mismatch");
	});

	it("accepts stable redacted rejection errors and rejects expanded error payloads", () => {
		const rejected = {
			schemaVersion: 1,
			status: "rejected",
			requestId: request.requestId,
			traceId: request.traceId,
			imageReference: request.imageReference,
			error: {
				schemaVersion: 1,
				code: "IMAGE_NOT_ADMITTED",
				message: "The image is not admitted by deployment policy",
				retryable: false,
				traceId: request.traceId,
			},
		} as const;

		expect(validateImageRegistryAdmissionResultV1(request, rejected)).toEqual(
			rejected,
		);
		expect(() =>
			validateImageRegistryAdmissionResultV1(request, {
				...rejected,
				error: { ...rejected.error, traceId: "trace_registry_02" },
			}),
		).toThrow("Image registry result correlation mismatch");
		expect(
			ImageRegistryAdmissionResultV1Schema.safeParse({
				...rejected,
				error: { ...rejected.error, providerResponse: "sensitive" },
			}).success,
		).toBe(false);
		expect(
			ImageRegistryAdmissionResultV1Schema.safeParse({
				...rejected,
				error: { ...rejected.error, code: "PROVIDER_SPECIFIC_FAILURE" },
			}).success,
		).toBe(false);
		expect(
			ImageRegistryAdmissionResultV1Schema.safeParse({
				...rejected,
				error: {
					...rejected.error,
					code: "IMAGE_REGISTRY_UNAVAILABLE",
					retryable: true,
				},
			}).success,
		).toBe(true);
	});
});
