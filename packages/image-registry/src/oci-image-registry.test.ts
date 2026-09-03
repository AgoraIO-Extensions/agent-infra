import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createFakeImageRegistryAdapterV1 } from "../../test-support/src/workload/registry.js";
import {
	createOciImageRegistryAdapterV1,
	type ImageRegistryAdapterV1,
} from "./oci-image-registry.js";

const runtimeManifestLabel = JSON.stringify({
	schemaVersion: 1,
	interactionMode: "platform-adapter",
	protocol: "acp",
	service: { port: 8080 },
	health: { path: "/healthz" },
	capabilities: { modelSelection: true },
});
const registryConfigBody = JSON.stringify({
	os: "linux",
	architecture: "amd64",
	config: {
		Entrypoint: ["node"],
		Cmd: ["dist/host.mjs"],
		WorkingDir: "/workspace",
		User: "10001",
		Env: ["MODEL_ENDPOINT=https://models.example", "DEBUG=1"],
		Labels: { "io.agora.agent.runtime.manifest": runtimeManifestLabel },
	},
});
const configDigest = digestText(registryConfigBody);
const registryManifestBody = JSON.stringify({
	schemaVersion: 2,
	config: { digest: configDigest },
});
const manifestDigest = digestText(registryManifestBody);

const request = {
	schemaVersion: 1,
	requestId: "request_registry_01",
	traceId: "trace_registry_01",
	subjectRef: "subject_01",
	agentId: "agent_01",
	imageReference: "registry.example/agents/codex:pilot",
	usage: "custom-agent",
	admissionPolicyRef: "policy_01",
} as const;

const admittedPolicy = {
	status: "admitted" as const,
	decisionRef: "decision_01",
	evaluatedAt: "2026-09-03T00:00:00Z",
};

function response(
	body: string,
	init: ConstructorParameters<typeof Response>[1] = {},
) {
	return new Response(body, init);
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
	return input instanceof Request ? input.url : input.toString();
}

describe("OCI ImageRegistryAdapter V1", () => {
	it("resolves an approved Tag to an immutable Digest and sanitized candidate", async () => {
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch(input) {
				const url = requestUrl(input);
				if (url.endsWith("/v2/codex/manifests/pilot")) {
					return response(registryManifestBody, {
						status: 200,
						headers: { "docker-content-digest": manifestDigest },
					});
				}
				if (
					url.endsWith(`/v2/codex/blobs/${encodeURIComponent(configDigest)}`)
				) {
					return response(registryConfigBody, { status: 200 });
				}
				throw new Error(`Unexpected OCI request ${url}`);
			},
			policy: {
				async authorize(input) {
					expect(input).toEqual({
						...request,
						immutableDigest: manifestDigest,
					});
					return {
						status: "admitted",
						decisionRef: "decision_01",
						evaluatedAt: "2026-09-03T00:00:00Z",
					};
				},
			},
		});

		const result = await adapter.admit(request);

		expect(result).toEqual({
			schemaVersion: 1,
			status: "admitted",
			requestId: request.requestId,
			traceId: request.traceId,
			immutableDigest: manifestDigest,
			ociConfig: {
				schemaVersion: 1,
				configDigest,
				operatingSystem: "linux",
				architecture: "amd64",
				entrypoint: ["node"],
				command: ["dist/host.mjs"],
				workingDirectory: "/workspace",
				user: "10001",
				declaredEnvKeys: ["MODEL_ENDPOINT", "DEBUG"],
			},
			runtimeManifestLabel,
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
					connection: false,
					supplementaryInstruction: false,
				},
			},
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
				subjectRef: request.subjectRef,
				agentId: request.agentId,
				imageDigest: manifestDigest,
				evaluatedAt: "2026-09-03T00:00:00Z",
			},
		});
		expect(JSON.stringify(result)).not.toContain("models.example");
	});

	it("resolves equivalent Tag and Digest references to the same immutable candidate", async () => {
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch(input) {
				const url = requestUrl(input);
				return url.includes("/manifests/")
					? response(registryManifestBody, {
							status: 200,
							headers: { "docker-content-digest": manifestDigest },
						})
					: response(registryConfigBody, { status: 200 });
			},
			policy: {
				async authorize() {
					return admittedPolicy;
				},
			},
		});

		const tag = await adapter.admit(request);
		const digest = await adapter.admit({
			...request,
			requestId: "request_registry_02",
			imageReference: `registry.example/agents/codex@${manifestDigest}`,
		});

		expect([tag, digest]).toMatchObject([
			{ status: "admitted", immutableDigest: manifestDigest },
			{ status: "admitted", immutableDigest: manifestDigest },
		]);
	});

	it("uses native fetch when no test seam is configured", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			return new URL(input.toString()).pathname.includes("/manifests/")
				? new Response(registryManifestBody, {
						status: 200,
						headers: { "docker-content-digest": manifestDigest },
					})
				: new Response(registryConfigBody, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const adapter = createOciImageRegistryAdapterV1({
				imageReferencePrefix: "registry.example/agents",
				endpoint: "https://registry.example",
				policy: {
					async authorize() {
						return admittedPolicy;
					},
				},
			});

			expect(await adapter.admit(request)).toMatchObject({
				status: "admitted",
				immutableDigest: manifestDigest,
			});
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("uses the canonical repository when an image reference contains both a Tag and Digest", async () => {
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch(input) {
				const url = requestUrl(input);
				if (url.includes("/manifests/")) {
					expect(new URL(url).pathname).toBe(
						`/v2/codex/manifests/${encodeURIComponent(manifestDigest)}`,
					);
					return response(registryManifestBody, {
						status: 200,
						headers: { "docker-content-digest": manifestDigest },
					});
				}
				return response(registryConfigBody, { status: 200 });
			},
			policy: {
				async authorize() {
					return admittedPolicy;
				},
			},
		});

		expect(
			await adapter.admit({
				...request,
				imageReference: `registry.example/agents/codex:pilot@${manifestDigest}`,
			}),
		).toMatchObject({ status: "admitted", immutableDigest: manifestDigest });
	});

	it("stops before config retrieval when deployment policy rejects another subject", async () => {
		let configReads = 0;
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch(input) {
				const url = requestUrl(input);
				if (url.includes("/blobs/")) {
					configReads += 1;
					throw new Error("config must not be requested");
				}
				return response(registryManifestBody, {
					status: 200,
					headers: { "docker-content-digest": manifestDigest },
				});
			},
			policy: {
				async authorize(input) {
					expect(input.subjectRef).toBe("subject_other");
					return { status: "rejected" };
				},
			},
		});

		const result = await adapter.admit({
			...request,
			subjectRef: "subject_other",
		});

		expect(result).toMatchObject({
			status: "rejected",
			error: { code: "IMAGE_NOT_ADMITTED", retryable: false },
		});
		expect(configReads).toBe(0);
	});

	it("rejects a requested Digest that does not match the resolved OCI Digest", async () => {
		let policyCalls = 0;
		let configReads = 0;
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch(input) {
				const url = requestUrl(input);
				if (url.includes("/blobs/")) configReads += 1;
				return response(registryManifestBody, {
					status: 200,
					headers: { "docker-content-digest": manifestDigest },
				});
			},
			policy: {
				async authorize() {
					policyCalls += 1;
					return admittedPolicy;
				},
			},
		});
		const mismatchedDigest = `sha256:${"c".repeat(64)}`;

		const result = await adapter.admit({
			...request,
			imageReference: `registry.example/agents/codex@${mismatchedDigest}`,
		});

		expect(result).toMatchObject({
			status: "rejected",
			error: { code: "OCI_CONFIG_INVALID", retryable: false },
		});
		expect(policyCalls).toBe(0);
		expect(configReads).toBe(0);
	});

	it("rejects OCI response bytes that do not match their advertised Digest", async () => {
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch() {
				return response(JSON.stringify({ config: { digest: configDigest } }), {
					status: 200,
					headers: { "docker-content-digest": manifestDigest },
				});
			},
			policy: {
				async authorize() {
					throw new Error("policy must not be called");
				},
			},
		});

		expect(await adapter.admit(request)).toMatchObject({
			status: "rejected",
			error: { code: "OCI_CONFIG_INVALID", retryable: false },
		});
	});

	it("fails closed when a Distribution client returns a malformed outcome", async () => {
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch() {
				return { status: "corrupted" } as never;
			},
			policy: {
				async authorize() {
					throw new Error("policy must not be called");
				},
			},
		});

		expect(await adapter.admit(request)).toMatchObject({
			status: "rejected",
			error: { code: "OCI_CONFIG_INVALID", retryable: false },
		});
	});

	it.each([
		[
			"missing Runtime Manifest label",
			{
				os: "linux",
				architecture: "amd64",
				config: { Env: ["MODEL_ENDPOINT=https://models.example"] },
			},
			"RUNTIME_MANIFEST_MISSING",
		],
		[
			"duplicate Runtime Manifest key",
			{
				os: "linux",
				architecture: "amd64",
				config: {
					Labels: {
						"io.agora.agent.runtime.manifest": runtimeManifestLabel.replace(
							'"schemaVersion":1',
							'"schemaVersion":1,"schemaVersion":1',
						),
					},
				},
			},
			"RUNTIME_MANIFEST_INVALID",
		],
		[
			"malformed OCI config",
			{ os: "linux", architecture: 64, config: {} },
			"OCI_CONFIG_INVALID",
		],
	] as const)(
		"returns a stable rejection for %s",
		async (_name, config, code) => {
			const configBody = JSON.stringify(config);
			const expectedConfigDigest = digestText(configBody);
			const manifestBody = JSON.stringify({
				config: { digest: expectedConfigDigest },
			});
			const expectedManifestDigest = digestText(manifestBody);
			const adapter = createOciImageRegistryAdapterV1({
				imageReferencePrefix: "registry.example/agents",
				endpoint: "https://registry.example",
				async fetch(input) {
					const url = requestUrl(input);
					return url.includes("/manifests/")
						? response(manifestBody, {
								status: 200,
								headers: {
									"docker-content-digest": expectedManifestDigest,
								},
							})
						: response(configBody, { status: 200 });
				},
				policy: {
					async authorize() {
						return admittedPolicy;
					},
				},
			});

			const result = await adapter.admit(request);

			expect(result).toMatchObject({
				status: "rejected",
				error: { code, retryable: false, traceId: request.traceId },
			});
			expect(JSON.stringify(result)).not.toContain("models.example");
		},
	);
});

type AdapterScenarioV1 = "admitted" | "not-admitted" | "unavailable";

const conformanceManifestLabel = JSON.stringify({
	schemaVersion: 1,
	interactionMode: "platform-adapter",
	protocol: "acp",
	service: { port: 8080 },
	health: { path: "/healthz" },
});
const conformanceConfigBody = JSON.stringify({
	os: "linux",
	architecture: "amd64",
	config: {
		Env: ["MODEL_ENDPOINT=registry-secret"],
		Labels: {
			"io.agora.agent.runtime.manifest": conformanceManifestLabel,
		},
	},
});
const conformanceConfigDigest = digestText(conformanceConfigBody);
const conformanceManifestBody = JSON.stringify({
	config: { digest: conformanceConfigDigest },
});
const conformanceManifestDigest = digestText(conformanceManifestBody);

const conformanceAdmittedOutcome = {
	status: "admitted",
	immutableDigest: conformanceManifestDigest,
	ociConfig: {
		schemaVersion: 1,
		configDigest: conformanceConfigDigest,
		operatingSystem: "linux",
		architecture: "amd64",
		declaredEnvKeys: ["MODEL_ENDPOINT"],
	},
	runtimeManifestLabel: conformanceManifestLabel,
	runtimeManifest: {
		schemaVersion: 1,
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 8080 },
		health: { path: "/healthz" },
	},
	runtimeManifestParsingEvidence: {
		schemaVersion: 1,
		labelName: "io.agora.agent.runtime.manifest",
		utf8ByteLength: Buffer.byteLength(conformanceManifestLabel, "utf8"),
		maxDepth: 3,
		duplicateKeysDetected: false,
		unknownFieldsDetected: false,
	},
	policyEvidence: {
		schemaVersion: 1,
		policyRef: request.admissionPolicyRef,
		decisionRef: "decision_01",
		subjectRef: request.subjectRef,
		agentId: request.agentId,
		imageDigest: conformanceManifestDigest,
		evaluatedAt: "2026-09-03T00:00:00Z",
	},
} as const;

const adapterFactories: readonly {
	readonly name: string;
	readonly create: (scenario: AdapterScenarioV1) => ImageRegistryAdapterV1;
}[] = [
	{
		name: "Fake",
		create(scenario) {
			return createFakeImageRegistryAdapterV1(
				scenario === "admitted"
					? { [request.imageReference]: conformanceAdmittedOutcome }
					: scenario === "unavailable"
						? {
								[request.imageReference]: {
									status: "rejected",
									error: {
										schemaVersion: 1,
										code: "IMAGE_REGISTRY_UNAVAILABLE",
										message: "Image registry is unavailable",
										retryable: true,
										traceId: request.traceId,
									},
								},
							}
						: {},
			);
		},
	},
	{
		name: "OCI",
		create(scenario) {
			return createOciImageRegistryAdapterV1({
				imageReferencePrefix: "registry.example/agents",
				endpoint: "https://registry.example",
				async fetch(input) {
					const url = requestUrl(input);
					if (scenario === "unavailable") {
						throw new Error("Bearer registry-secret");
					}
					if (scenario === "not-admitted") {
						return response("registry-secret", { status: 403 });
					}
					if (url.endsWith("/v2/codex/manifests/pilot")) {
						return response(conformanceManifestBody, {
							status: 200,
							headers: { "docker-content-digest": conformanceManifestDigest },
						});
					}
					return response(conformanceConfigBody, { status: 200 });
				},
				policy: {
					async authorize() {
						return {
							status: "admitted",
							decisionRef: "decision_01",
							evaluatedAt: "2026-09-03T00:00:00Z",
						};
					},
				},
			});
		},
	},
];

describe.each(adapterFactories)(
	"$name ImageRegistryAdapter V1 conformance",
	({ create }) => {
		it("returns an immutable, sanitized admitted candidate", async () => {
			const result = await create("admitted").admit(request);

			expect(result).toMatchObject({
				status: "admitted",
				immutableDigest: conformanceManifestDigest,
				runtimeManifest: {
					capabilities: {
						modelSelection: false,
						attachments: false,
						resultFiles: false,
						connection: false,
						supplementaryInstruction: false,
					},
				},
			});
			expect(JSON.stringify(result)).not.toContain("registry-secret");
		});

		it("rejects an unauthorized image with the stable policy result", async () => {
			const result = await create("not-admitted").admit(request);

			expect(result).toMatchObject({
				status: "rejected",
				error: {
					code: "IMAGE_NOT_ADMITTED",
					retryable: false,
					traceId: request.traceId,
				},
			});
		});

		it("redacts retryable registry failures", async () => {
			const result = await create("unavailable").admit(request);

			expect(result).toMatchObject({
				status: "rejected",
				error: {
					code: "IMAGE_REGISTRY_UNAVAILABLE",
					retryable: true,
					traceId: request.traceId,
				},
			});
			expect(JSON.stringify(result)).not.toContain("registry-secret");
		});

		it("returns a stable rejection for a credential-bearing image reference", async () => {
			const result = await create("admitted").admit({
				...request,
				imageReference:
					"https://user:registry-secret@registry.example/agents/codex:pilot",
			});

			expect(result).toMatchObject({
				status: "rejected",
				error: {
					code: "IMAGE_REFERENCE_INVALID",
					retryable: false,
					traceId: request.traceId,
				},
			});
			expect(JSON.stringify(result)).not.toContain("registry-secret");
		});
	},
);

function digestText(input: string): string {
	return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}
