import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createFakeImageRegistryAdapterV1 } from "../../test-support/src/workload/registry.js";
import {
	createOciImageRegistryAdapterV1,
	type ImageRegistryAdapterV1,
} from "./oci-image-registry.js";

const ociManifestMediaType = "application/vnd.oci.image.manifest.v1+json";
const ociConfigMediaType = "application/vnd.oci.image.config.v1+json";

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
const registryManifestBody = ociManifestBody({
	configDigest,
	configSize: Buffer.byteLength(registryConfigBody),
});
const manifestDigest = digestText(registryManifestBody);
const malformedManifest = Buffer.concat([
	Buffer.from(
		`{"schemaVersion":2,"mediaType":"${ociManifestMediaType}","config":{"mediaType":"${ociConfigMediaType}","digest":"${configDigest}","size":${Buffer.byteLength(registryConfigBody)}},"layers":[],"note":"`,
		"utf8",
	),
	Buffer.from([0x80]),
	Buffer.from('"}', "utf8"),
]);
const decodedMalformedManifestDigest = digestText(
	new TextDecoder("utf-8").decode(malformedManifest),
);
const rawMalformedManifestDigest = digestBytes(malformedManifest);

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
	body: ConstructorParameters<typeof Response>[0],
	init: ConstructorParameters<typeof Response>[1] = {},
) {
	return new Response(body, init);
}

function ociManifestBody(input: {
	readonly configDigest: string;
	readonly configSize: number;
	readonly layers?: readonly unknown[];
}): string {
	return JSON.stringify({
		schemaVersion: 2,
		mediaType: ociManifestMediaType,
		config: {
			mediaType: ociConfigMediaType,
			digest: input.configDigest,
			size: input.configSize,
		},
		layers: input.layers ?? [],
	});
}

function ociManifestResponse(
	body: ConstructorParameters<typeof Response>[0],
	digest: string,
	init: ConstructorParameters<typeof Response>[1] = {},
): Response {
	const headers = new Headers(init.headers);
	if (!headers.has("content-type"))
		headers.set("content-type", ociManifestMediaType);
	headers.set("docker-content-digest", digest);
	return response(body, { ...init, status: init.status ?? 200, headers });
}

function ociConfigResponse(
	body: ConstructorParameters<typeof Response>[0],
	init: ConstructorParameters<typeof Response>[1] = {},
): Response {
	const headers = new Headers(init.headers);
	if (!headers.has("content-type"))
		headers.set("content-type", ociConfigMediaType);
	return response(body, { ...init, status: init.status ?? 200, headers });
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
					return ociManifestResponse(registryManifestBody, manifestDigest);
				}
				if (
					url.endsWith(`/v2/codex/blobs/${encodeURIComponent(configDigest)}`)
				) {
					return ociConfigResponse(registryConfigBody);
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
					? ociManifestResponse(registryManifestBody, manifestDigest)
					: ociConfigResponse(registryConfigBody);
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
				? ociManifestResponse(registryManifestBody, manifestDigest)
				: ociConfigResponse(registryConfigBody);
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
					return ociManifestResponse(registryManifestBody, manifestDigest);
				}
				return ociConfigResponse(registryConfigBody);
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
				return ociManifestResponse(registryManifestBody, manifestDigest);
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
				return ociManifestResponse(registryManifestBody, manifestDigest);
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
				return ociManifestResponse(
					registryManifestBody,
					`sha256:${"f".repeat(64)}`,
				);
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

	it("uses received bytes for Digest verification before decoding a valid BOM", async () => {
		const rawConfig = Buffer.from(`\uFEFF${registryConfigBody}`, "utf8");
		const rawConfigDigest = digestBytes(rawConfig);
		const rawManifest = Buffer.from(
			`\uFEFF${ociManifestBody({
				configDigest: rawConfigDigest,
				configSize: rawConfig.byteLength,
			})}`,
			"utf8",
		);
		const rawManifestDigest = digestBytes(rawManifest);
		const policy = vi.fn(async () => admittedPolicy);
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch(input) {
				return requestUrl(input).includes("/manifests/")
					? ociManifestResponse(rawManifest, rawManifestDigest)
					: ociConfigResponse(rawConfig);
			},
			policy: { authorize: policy },
		});

		expect(await adapter.admit(request)).toMatchObject({
			status: "admitted",
			immutableDigest: rawManifestDigest,
			ociConfig: { configDigest: rawConfigDigest },
		});
		expect(policy).toHaveBeenCalledOnce();
	});

	it.each([
		["a Digest derived from decoded text", decodedMalformedManifestDigest],
		["its matching raw Digest", rawMalformedManifestDigest],
	] as const)("rejects malformed UTF-8 with %s", async (_name, digest) => {
		const policy = vi.fn(async () => admittedPolicy);
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch() {
				return ociManifestResponse(malformedManifest, digest);
			},
			policy: { authorize: policy },
		});

		expect(await adapter.admit(request)).toMatchObject({
			status: "rejected",
			error: { code: "OCI_CONFIG_INVALID", retryable: false },
		});
		expect(policy).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a non-image manifest Content-Type",
			"application/vnd.oci.image.index.v1+json",
			ociManifestBody({
				configDigest,
				configSize: Buffer.byteLength(registryConfigBody),
			}),
		],
		[
			"an incomplete OCI config descriptor",
			ociManifestMediaType,
			JSON.stringify({
				schemaVersion: 2,
				mediaType: ociManifestMediaType,
				config: { digest: configDigest },
				layers: [],
			}),
		],
	] as const)(
		"rejects %s before policy evaluation",
		async (_name, contentType, body) => {
			const policy = vi.fn(async () => admittedPolicy);
			const adapter = createOciImageRegistryAdapterV1({
				imageReferencePrefix: "registry.example/agents",
				endpoint: "https://registry.example",
				async fetch() {
					return ociManifestResponse(body, digestText(body), {
						headers: { "content-type": contentType },
					});
				},
				policy: { authorize: policy },
			});

			const result = await adapter.admit(request);

			expect(result).toMatchObject({
				status: "rejected",
				error: { code: "OCI_CONFIG_INVALID", retryable: false },
			});
			expect(policy).not.toHaveBeenCalled();
		},
	);

	it("rejects a transformed Content-Encoding without exposing response content", async () => {
		const encodedManifest = JSON.stringify({
			...JSON.parse(registryManifestBody),
			annotation: "registry-secret",
		});
		const policy = vi.fn(async () => admittedPolicy);
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch() {
				return ociManifestResponse(
					encodedManifest,
					digestText(encodedManifest),
					{ headers: { "content-encoding": "gzip" } },
				);
			},
			policy: { authorize: policy },
		});

		const result = await adapter.admit(request);

		expect(result).toMatchObject({
			status: "rejected",
			error: {
				code: "OCI_CONFIG_INVALID",
				message: "OCI image config is invalid",
				retryable: false,
				traceId: request.traceId,
			},
		});
		expect(policy).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain("registry-secret");
	});

	it.each([
		[
			"a duplicate manifest key",
			registryManifestBody.replace(
				'"schemaVersion":2',
				'"schemaVersion":2,"schemaVersion":2',
			),
		],
		[
			"a nested duplicate manifest key",
			registryManifestBody.replace(
				`"mediaType":"${ociConfigMediaType}"`,
				`"mediaType":"${ociConfigMediaType}","mediaType":"${ociConfigMediaType}"`,
			),
		],
		[
			"artifactType presence",
			JSON.stringify({ ...JSON.parse(registryManifestBody), artifactType: "" }),
		],
		[
			"an OCI artifact layer media type",
			ociManifestBody({
				configDigest,
				configSize: Buffer.byteLength(registryConfigBody),
				layers: [
					{
						mediaType: "application/vnd.oci.empty.v1+json",
						digest: `sha256:${"a".repeat(64)}`,
						size: 2,
					},
				],
			}),
		],
	] as const)("rejects %s before policy evaluation", async (_name, body) => {
		const policy = vi.fn(async () => admittedPolicy);
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch() {
				return ociManifestResponse(body, digestText(body));
			},
			policy: { authorize: policy },
		});

		expect(await adapter.admit(request)).toMatchObject({
			status: "rejected",
			error: { code: "OCI_CONFIG_INVALID", retryable: false },
		});
		expect(policy).not.toHaveBeenCalled();
	});

	it("accepts an OCI image layer descriptor", async () => {
		const manifestBody = ociManifestBody({
			configDigest,
			configSize: Buffer.byteLength(registryConfigBody),
			layers: [
				{
					mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
					digest: `sha256:${"b".repeat(64)}`,
					size: 2,
				},
			],
		});
		const manifestDigest = digestText(manifestBody);
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch(input) {
				return requestUrl(input).includes("/manifests/")
					? ociManifestResponse(manifestBody, manifestDigest)
					: ociConfigResponse(registryConfigBody);
			},
			policy: { authorize: async () => admittedPolicy },
		});

		expect(await adapter.admit(request)).toMatchObject({
			status: "admitted",
			immutableDigest: manifestDigest,
		});
	});

	it("rejects an OCI config response with a non-config Content-Type", async () => {
		const policy = vi.fn(async () => admittedPolicy);
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch(input) {
				return requestUrl(input).includes("/manifests/")
					? ociManifestResponse(registryManifestBody, manifestDigest)
					: ociConfigResponse(registryConfigBody, {
							status: 200,
							headers: { "content-type": "application/json" },
						});
			},
			policy: { authorize: policy },
		});

		expect(await adapter.admit(request)).toMatchObject({
			status: "rejected",
			error: { code: "OCI_CONFIG_INVALID", retryable: false },
		});
		expect(policy).toHaveBeenCalledOnce();
	});

	it("bounds oversized OCI responses before policy and redacts their content", async () => {
		const oversizedManifest = JSON.stringify({
			...JSON.parse(registryManifestBody),
			annotation: `registry-secret-${"x".repeat(2 * 1024 * 1024)}`,
		});
		const policy = vi.fn(async () => admittedPolicy);
		const adapter = createOciImageRegistryAdapterV1({
			imageReferencePrefix: "registry.example/agents",
			endpoint: "https://registry.example",
			async fetch() {
				return ociManifestResponse(
					oversizedManifest,
					digestText(oversizedManifest),
				);
			},
			policy: { authorize: policy },
		});

		const result = await adapter.admit(request);

		expect(result).toMatchObject({
			status: "rejected",
			error: { code: "OCI_CONFIG_INVALID", retryable: false },
		});
		expect(policy).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain("registry-secret");
	});

	it("aborts a stalled OCI fetch by the fixed transport deadline", async () => {
		vi.useFakeTimers();
		try {
			const fetch = vi.fn(
				(
					_input: Parameters<typeof globalThis.fetch>[0],
					init?: Parameters<typeof globalThis.fetch>[1],
				) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new Error("registry-secret timeout")),
							{ once: true },
						);
					}),
			);
			const policy = vi.fn(async () => admittedPolicy);
			const adapter = createOciImageRegistryAdapterV1({
				imageReferencePrefix: "registry.example/agents",
				endpoint: "https://registry.example",
				fetch,
				policy: { authorize: policy },
			});
			const pending = adapter.admit(request);
			const deadline = new Promise<"deadline">((resolve) => {
				setTimeout(() => resolve("deadline"), 60_000);
			});

			await vi.advanceTimersByTimeAsync(60_000);
			const result = await Promise.race([
				pending,
				deadline.then(() => ({ status: "deadline" }) as const),
			]);

			expect(result).toMatchObject({
				status: "rejected",
				error: {
					code: "IMAGE_REGISTRY_UNAVAILABLE",
					retryable: true,
				},
			});
			expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
			expect(policy).not.toHaveBeenCalled();
			expect(JSON.stringify(result)).not.toContain("registry-secret");
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts a stalled OCI response body by the fixed transport deadline", async () => {
		vi.useFakeTimers();
		try {
			const fetch = vi.fn(
				(
					_input: Parameters<typeof globalThis.fetch>[0],
					init?: Parameters<typeof globalThis.fetch>[1],
				) =>
					Promise.resolve(
						ociManifestResponse(
							new ReadableStream<Uint8Array>({
								start(controller) {
									init?.signal?.addEventListener(
										"abort",
										() => controller.error(new Error("registry-secret body")),
										{ once: true },
									);
								},
							}),
							manifestDigest,
						),
					),
			);
			const policy = vi.fn(async () => admittedPolicy);
			const adapter = createOciImageRegistryAdapterV1({
				imageReferencePrefix: "registry.example/agents",
				endpoint: "https://registry.example",
				fetch,
				policy: { authorize: policy },
			});
			const pending = adapter.admit(request);
			const deadline = new Promise<"deadline">((resolve) => {
				setTimeout(() => resolve("deadline"), 60_000);
			});

			await vi.advanceTimersByTimeAsync(60_000);
			const result = await Promise.race([
				pending,
				deadline.then(() => ({ status: "deadline" }) as const),
			]);

			expect(result).toMatchObject({
				status: "rejected",
				error: {
					code: "IMAGE_REGISTRY_UNAVAILABLE",
					retryable: true,
				},
			});
			expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
			expect(policy).not.toHaveBeenCalled();
			expect(JSON.stringify(result)).not.toContain("registry-secret");
		} finally {
			vi.useRealTimers();
		}
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
			const manifestBody = ociManifestBody({
				configDigest: expectedConfigDigest,
				configSize: Buffer.byteLength(configBody),
			});
			const expectedManifestDigest = digestText(manifestBody);
			const adapter = createOciImageRegistryAdapterV1({
				imageReferencePrefix: "registry.example/agents",
				endpoint: "https://registry.example",
				async fetch(input) {
					const url = requestUrl(input);
					return url.includes("/manifests/")
						? ociManifestResponse(manifestBody, expectedManifestDigest)
						: ociConfigResponse(configBody);
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
const conformanceManifestBody = ociManifestBody({
	configDigest: conformanceConfigDigest,
	configSize: Buffer.byteLength(conformanceConfigBody),
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
						return ociManifestResponse(
							conformanceManifestBody,
							conformanceManifestDigest,
						);
					}
					return ociConfigResponse(conformanceConfigBody);
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

function digestBytes(input: Uint8Array): string {
	return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
