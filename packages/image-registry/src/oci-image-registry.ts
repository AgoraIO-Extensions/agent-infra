import { createHash } from "node:crypto";

import {
	type ImageAdmissionPolicyEvidenceV1,
	ImageAdmissionPolicyEvidenceV1Schema,
	type ImageRegistryAdmissionRequestV1,
	type ImageRegistryAdmissionResultV1,
	ImageRegistryAdmissionResultV1Schema,
	ImmutableOciDigestV1Schema,
	type OciImageConfigV1,
	OciImageConfigV1Schema,
	OciImageReferenceV1Schema,
	parseImageRegistryAdmissionRequestV1,
	parseRuntimeManifestLabelV1,
	validateImageRegistryAdmissionResultV1,
} from "@agent-infra/contracts/workload";

const runtimeManifestLabelName = "io.agora.agent.runtime.manifest";
const manifestMediaType = "application/vnd.oci.image.manifest.v1+json";
const configMediaType = "application/vnd.oci.image.config.v1+json";
const maxOciResponseBytes = 1024 * 1024;
const ociRequestTimeoutMs = 30_000;

type OciDistributionFailureV1 =
	| "not-found"
	| "not-admitted"
	| "invalid"
	| "unavailable";

type OciManifestResolutionV1 =
	| {
			readonly status: "resolved";
			readonly immutableDigest: string;
			readonly configDigest: string;
			readonly configSize: number;
	  }
	| { readonly status: OciDistributionFailureV1 };

type OciConfigResolutionV1 =
	| { readonly status: "resolved"; readonly config: unknown }
	| { readonly status: OciDistributionFailureV1 };

type OciDistributionClientV1 = {
	readonly resolveManifest: (input: {
		readonly imageReference: string;
	}) => Promise<OciManifestResolutionV1>;
	readonly readConfig: (input: {
		readonly imageReference: string;
		readonly configDigest: string;
		readonly configSize: number;
	}) => Promise<OciConfigResolutionV1>;
};

export interface OciImageAdmissionPolicyV1 {
	authorize(
		input: ImageRegistryAdmissionRequestV1 & {
			readonly immutableDigest: string;
		},
	): Promise<
		| {
				readonly status: "admitted";
				readonly decisionRef: string;
				readonly evaluatedAt: string;
		  }
		| { readonly status: "rejected" }
	>;
}

export interface ImageRegistryAdapterV1 {
	admit(
		request: ImageRegistryAdmissionRequestV1,
	): Promise<ImageRegistryAdmissionResultV1>;
}

function createOciDistributionClientV1(options: {
	readonly imageReferencePrefix: string;
	readonly endpoint: string;
	readonly fetch: typeof globalThis.fetch;
}): OciDistributionClientV1 {
	const binding = parseBinding(options);

	return {
		async resolveManifest(input) {
			const location = resolveImageLocation(input.imageReference, binding);
			if (!location) return { status: "not-admitted" };
			const response = await requestOci(
				binding,
				`${encodeRepository(location.repository)}/manifests/${encodeURIComponent(location.reference)}`,
				manifestMediaType,
			);
			if (response.status !== "ok") return response;
			try {
				const immutableDigest = headerValue(
					response.headers,
					"docker-content-digest",
				);
				if (
					!hasMediaType(response.headers, manifestMediaType) ||
					typeof immutableDigest !== "string" ||
					!ImmutableOciDigestV1Schema.safeParse(immutableDigest).success ||
					digestBytes(response.body) !== immutableDigest ||
					(location.reference.startsWith("sha256:") &&
						location.reference !== immutableDigest)
				) {
					return { status: "invalid" };
				}
				const manifest = parseOciImageManifest(response.body);
				return manifest
					? { status: "resolved", immutableDigest, ...manifest }
					: { status: "invalid" };
			} catch {
				return { status: "invalid" };
			}
		},
		async readConfig(input) {
			const location = resolveImageLocation(input.imageReference, binding);
			if (!location) return { status: "not-admitted" };
			if (!ImmutableOciDigestV1Schema.safeParse(input.configDigest).success) {
				return { status: "invalid" };
			}
			const response = await requestOci(
				binding,
				`${encodeRepository(location.repository)}/blobs/${encodeURIComponent(input.configDigest)}`,
				configMediaType,
			);
			if (response.status !== "ok") return response;
			try {
				if (
					!hasMediaType(response.headers, configMediaType) ||
					response.body.byteLength !== input.configSize ||
					digestBytes(response.body) !== input.configDigest
				) {
					return { status: "invalid" };
				}
				return {
					status: "resolved",
					config: JSON.parse(decodeUtf8(response.body)),
				};
			} catch {
				return { status: "invalid" };
			}
		},
	};
}

export function createOciImageRegistryAdapterV1(options: {
	readonly imageReferencePrefix: string;
	readonly endpoint: string;
	readonly fetch?: typeof globalThis.fetch;
	readonly policy: OciImageAdmissionPolicyV1;
}): ImageRegistryAdapterV1 {
	const distribution = createOciDistributionClientV1({
		imageReferencePrefix: options.imageReferencePrefix,
		endpoint: options.endpoint,
		fetch: options.fetch ?? globalThis.fetch,
	});
	return {
		async admit(
			requestInput: unknown,
		): Promise<ImageRegistryAdmissionResultV1> {
			const parsedRequest = parseImageRegistryAdmissionRequestV1(requestInput);
			if (parsedRequest.status === "invalid-image-reference") {
				return rejected(parsedRequest.correlation, "IMAGE_REFERENCE_INVALID");
			}
			if (parsedRequest.status === "invalid") {
				throw new TypeError("Image registry request is invalid");
			}
			const request = parsedRequest.request;
			const manifest = await resolveManifest(distribution, request);
			if (manifest.status !== "resolved") {
				return rejected(request, distributionFailureCode(manifest.status));
			}

			const policy = await authorizePolicy(options.policy, request, manifest);
			if (policy.status !== "admitted") {
				return rejected(request, policy.code);
			}

			const config = await resolveConfig(distribution, request, manifest);
			if (config.status !== "resolved") {
				return rejected(request, config.code);
			}
			if (config.runtimeManifestLabel === undefined) {
				return rejected(request, "RUNTIME_MANIFEST_MISSING");
			}
			if (config.runtimeManifestLabel === null) {
				return rejected(request, "RUNTIME_MANIFEST_INVALID");
			}

			try {
				const parsedManifest = parseRuntimeManifestLabelV1(
					config.runtimeManifestLabel,
				);
				return validateImageRegistryAdmissionResultV1(request, {
					schemaVersion: 1,
					status: "admitted",
					requestId: request.requestId,
					traceId: request.traceId,
					immutableDigest: manifest.immutableDigest,
					ociConfig: config.ociConfig,
					runtimeManifestLabel: config.runtimeManifestLabel,
					runtimeManifest: parsedManifest.runtimeManifest,
					runtimeManifestParsingEvidence:
						parsedManifest.runtimeManifestParsingEvidence,
					policyEvidence: policy.evidence,
				});
			} catch {
				return rejected(request, "RUNTIME_MANIFEST_INVALID");
			}
		},
	};
}

function parseBinding(options: {
	readonly imageReferencePrefix: string;
	readonly endpoint: string;
	readonly fetch: typeof globalThis.fetch;
}): {
	readonly imageReferencePrefix: string;
	readonly endpoint: URL;
	readonly fetch: typeof globalThis.fetch;
} {
	if (
		typeof options.imageReferencePrefix !== "string" ||
		!OciImageReferenceV1Schema.safeParse(
			`${options.imageReferencePrefix}/probe:tag`,
		).success ||
		typeof options.fetch !== "function"
	) {
		throw new TypeError("OCI Distribution configuration is invalid");
	}
	let endpoint: URL;
	try {
		endpoint = new URL(options.endpoint);
	} catch {
		throw new TypeError("OCI Distribution configuration is invalid");
	}
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		(endpoint.pathname !== "/" &&
			endpoint.pathname !== "/v2" &&
			endpoint.pathname !== "/v2/")
	) {
		throw new TypeError("OCI Distribution configuration is invalid");
	}
	endpoint.pathname = endpoint.pathname === "/" ? "" : "/v2";
	return {
		imageReferencePrefix: options.imageReferencePrefix,
		endpoint,
		fetch: options.fetch,
	};
}

function resolveImageLocation(
	imageReference: string,
	binding: { readonly imageReferencePrefix: string },
): { readonly repository: string; readonly reference: string } | undefined {
	if (!OciImageReferenceV1Schema.safeParse(imageReference).success) {
		return undefined;
	}
	const prefix = `${binding.imageReferencePrefix}/`;
	if (!imageReference.startsWith(prefix)) return undefined;
	const remainder = imageReference.slice(prefix.length);
	if (!remainder) return undefined;
	const digestIndex = remainder.lastIndexOf("@");
	if (digestIndex >= 0) {
		const namedRepository = remainder.slice(0, digestIndex);
		const separator = namedRepository.lastIndexOf(":");
		const slash = namedRepository.lastIndexOf("/");
		const repository =
			separator > slash ? namedRepository.slice(0, separator) : namedRepository;
		const reference = remainder.slice(digestIndex + 1);
		return repository && reference ? { repository, reference } : undefined;
	}
	const separator = remainder.lastIndexOf(":");
	const slash = remainder.lastIndexOf("/");
	return separator > slash
		? {
				repository: remainder.slice(0, separator),
				reference: remainder.slice(separator + 1),
			}
		: { repository: remainder, reference: "latest" };
}

function encodeRepository(repository: string): string {
	return repository.split("/").map(encodeURIComponent).join("/");
}

function digestBytes(input: Uint8Array): string {
	return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

async function requestOci(
	binding: {
		readonly endpoint: URL;
		readonly fetch: typeof globalThis.fetch;
	},
	path: string,
	accept: string,
): Promise<
	| {
			readonly status: "ok";
			readonly body: Uint8Array;
			readonly headers: Readonly<Record<string, string | undefined>>;
	  }
	| { readonly status: OciDistributionFailureV1 }
> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			readOciResponse(binding, path, accept, controller.signal),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					controller.abort();
					reject(new Error("OCI request timed out"));
				}, ociRequestTimeoutMs);
			}),
		]);
	} catch {
		return { status: "unavailable" };
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function readOciResponse(
	binding: {
		readonly endpoint: URL;
		readonly fetch: typeof globalThis.fetch;
	},
	path: string,
	accept: string,
	signal: AbortSignal,
): Promise<
	| {
			readonly status: "ok";
			readonly body: Uint8Array;
			readonly headers: Readonly<Record<string, string | undefined>>;
	  }
	| { readonly status: OciDistributionFailureV1 }
> {
	const response = await binding.fetch(
		new URL(`/v2/${path}`, binding.endpoint),
		{
			headers: { accept },
			redirect: "error",
			signal,
		},
	);
	if (
		typeof response !== "object" ||
		response === null ||
		!Number.isInteger(response.status) ||
		typeof response.headers?.forEach !== "function"
	) {
		return { status: "invalid" };
	}
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		headers[name] = value;
	});
	const body = await readResponseBytes(response.body, headers);
	if (body.status === "unavailable") return { status: "unavailable" };
	if (body.status === "invalid" || body.status === "oversized") {
		return { status: "invalid" };
	}
	if (response.status === 200) {
		return body.status === "ok"
			? { status: "ok", body: body.bytes, headers }
			: { status: "invalid" };
	}
	return { status: responseFailure(response.status) };
}

async function readResponseBytes(
	body: ReadableStream<Uint8Array> | null,
	headers: Readonly<Record<string, string | undefined>>,
): Promise<
	| { readonly status: "ok"; readonly bytes: Uint8Array }
	| { readonly status: "empty" | "invalid" | "oversized" | "unavailable" }
> {
	const contentLength = headerValue(headers, "content-length");
	if (contentLength !== undefined && !isBoundedContentLength(contentLength)) {
		await body?.cancel().catch(() => undefined);
		return { status: "oversized" };
	}
	if (body === null) return { status: "empty" };
	if (typeof body.getReader !== "function") return { status: "invalid" };
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (!(chunk.value instanceof Uint8Array)) return { status: "invalid" };
			length += chunk.value.byteLength;
			if (length > maxOciResponseBytes) {
				await reader.cancel().catch(() => undefined);
				return { status: "oversized" };
			}
			chunks.push(chunk.value);
		}
		return { status: "ok", bytes: Buffer.concat(chunks, length) };
	} catch {
		return { status: "unavailable" };
	} finally {
		reader?.releaseLock();
	}
}

function isBoundedContentLength(input: string): boolean {
	if (!/^\d+$/.test(input)) return true;
	const length = Number(input);
	return Number.isSafeInteger(length) && length <= maxOciResponseBytes;
}

function responseFailure(status: number): OciDistributionFailureV1 {
	if (status === 404) return "not-found";
	if (status === 401 || status === 403) return "not-admitted";
	return status === 429 || status >= 500 ? "unavailable" : "invalid";
}

function headerValue(
	headers: Readonly<Record<string, string | undefined>>,
	name: string,
): string | undefined {
	for (const [header, value] of Object.entries(headers)) {
		if (header.toLowerCase() === name && typeof value === "string")
			return value;
	}
	return undefined;
}

function hasMediaType(
	headers: Readonly<Record<string, string | undefined>>,
	expected: string,
): boolean {
	const value = headerValue(headers, "content-type");
	return value?.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

function parseOciImageManifest(
	input: Uint8Array,
): { readonly configDigest: string; readonly configSize: number } | undefined {
	const manifest = asRecord(JSON.parse(decodeUtf8(input)));
	const config = manifest ? asRecord(ownValue(manifest, "config")) : undefined;
	const layers = manifest ? ownValue(manifest, "layers") : undefined;
	if (
		!manifest ||
		ownValue(manifest, "schemaVersion") !== 2 ||
		ownValue(manifest, "mediaType") !== manifestMediaType ||
		!isOciDescriptor(config, configMediaType) ||
		!Array.isArray(layers) ||
		!layers.every((layer) => isOciDescriptor(asRecord(layer)))
	) {
		return undefined;
	}
	return {
		configDigest: ownValue(config, "digest") as string,
		configSize: ownValue(config, "size") as number,
	};
}

function isOciDescriptor(
	input: Record<string, unknown> | undefined,
	expectedMediaType?: string,
): input is Record<string, unknown> {
	const mediaType = input ? ownValue(input, "mediaType") : undefined;
	const digest = input ? ownValue(input, "digest") : undefined;
	const size = input ? ownValue(input, "size") : undefined;
	return (
		typeof mediaType === "string" &&
		mediaType.length > 0 &&
		(expectedMediaType === undefined || mediaType === expectedMediaType) &&
		typeof digest === "string" &&
		ImmutableOciDigestV1Schema.safeParse(digest).success &&
		typeof size === "number" &&
		Number.isSafeInteger(size) &&
		size >= 0
	);
}

function decodeUtf8(input: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(input);
}

async function resolveManifest(
	distribution: OciDistributionClientV1,
	request: ImageRegistryAdmissionRequestV1,
): Promise<OciManifestResolutionV1> {
	try {
		return normalizeManifestResolution(
			await distribution.resolveManifest({
				imageReference: request.imageReference,
			}),
		);
	} catch {
		return { status: "unavailable" };
	}
}

async function authorizePolicy(
	policy: OciImageAdmissionPolicyV1,
	request: ImageRegistryAdmissionRequestV1,
	manifest: Extract<OciManifestResolutionV1, { readonly status: "resolved" }>,
): Promise<
	| {
			readonly status: "admitted";
			readonly evidence: ImageAdmissionPolicyEvidenceV1;
	  }
	| {
			readonly status: "rejected";
			readonly code:
				| "IMAGE_NOT_ADMITTED"
				| "IMAGE_ADMISSION_POLICY_UNAVAILABLE";
	  }
> {
	try {
		const decision = await policy.authorize({
			...request,
			immutableDigest: manifest.immutableDigest,
		});
		if (decision.status === "rejected") {
			return { status: "rejected", code: "IMAGE_NOT_ADMITTED" };
		}
		if (
			decision.status !== "admitted" ||
			typeof decision.decisionRef !== "string" ||
			typeof decision.evaluatedAt !== "string"
		) {
			return { status: "rejected", code: "IMAGE_ADMISSION_POLICY_UNAVAILABLE" };
		}
		const evidence = ImageAdmissionPolicyEvidenceV1Schema.safeParse({
			schemaVersion: 1,
			policyRef: request.admissionPolicyRef,
			decisionRef: decision.decisionRef,
			subjectRef: request.subjectRef,
			agentId: request.agentId,
			imageDigest: manifest.immutableDigest,
			evaluatedAt: decision.evaluatedAt,
		});
		return evidence.success
			? { status: "admitted", evidence: evidence.data }
			: { status: "rejected", code: "IMAGE_ADMISSION_POLICY_UNAVAILABLE" };
	} catch {
		return { status: "rejected", code: "IMAGE_ADMISSION_POLICY_UNAVAILABLE" };
	}
}

async function resolveConfig(
	distribution: OciDistributionClientV1,
	request: ImageRegistryAdmissionRequestV1,
	manifest: Extract<OciManifestResolutionV1, { readonly status: "resolved" }>,
): Promise<
	| {
			readonly status: "resolved";
			readonly ociConfig: OciImageConfigV1;
			readonly runtimeManifestLabel: string | null | undefined;
	  }
	| {
			readonly status: "rejected";
			readonly code:
				| "OCI_CONFIG_INVALID"
				| "IMAGE_NOT_FOUND"
				| "IMAGE_NOT_ADMITTED"
				| "IMAGE_REGISTRY_UNAVAILABLE";
	  }
> {
	let result: OciConfigResolutionV1;
	try {
		result = normalizeConfigResolution(
			await distribution.readConfig({
				imageReference: request.imageReference,
				configDigest: manifest.configDigest,
				configSize: manifest.configSize,
			}),
		);
	} catch {
		return { status: "rejected", code: "IMAGE_REGISTRY_UNAVAILABLE" };
	}
	if (result.status !== "resolved") {
		return { status: "rejected", code: distributionFailureCode(result.status) };
	}
	try {
		const parsed = parseOciConfig(result.config, manifest.configDigest);
		return parsed
			? { status: "resolved", ...parsed }
			: { status: "rejected", code: "OCI_CONFIG_INVALID" };
	} catch {
		return { status: "rejected", code: "OCI_CONFIG_INVALID" };
	}
}

function normalizeManifestResolution(input: unknown): OciManifestResolutionV1 {
	const result = asRecord(input);
	if (
		result?.status === "resolved" &&
		typeof result.immutableDigest === "string" &&
		typeof result.configDigest === "string" &&
		typeof result.configSize === "number" &&
		ImmutableOciDigestV1Schema.safeParse(result.immutableDigest).success &&
		ImmutableOciDigestV1Schema.safeParse(result.configDigest).success &&
		Number.isSafeInteger(result.configSize) &&
		result.configSize >= 0
	) {
		return {
			status: "resolved",
			immutableDigest: result.immutableDigest,
			configDigest: result.configDigest,
			configSize: result.configSize,
		};
	}
	return result && isDistributionFailure(result.status)
		? { status: result.status }
		: { status: "invalid" };
}

function normalizeConfigResolution(input: unknown): OciConfigResolutionV1 {
	const result = asRecord(input);
	if (result?.status === "resolved" && Object.hasOwn(result, "config")) {
		return { status: "resolved", config: result.config };
	}
	return result && isDistributionFailure(result.status)
		? { status: result.status }
		: { status: "invalid" };
}

function isDistributionFailure(
	input: unknown,
): input is OciDistributionFailureV1 {
	return (
		input === "not-found" ||
		input === "not-admitted" ||
		input === "invalid" ||
		input === "unavailable"
	);
}

function parseOciConfig(
	input: unknown,
	configDigest: string,
):
	| {
			readonly ociConfig: OciImageConfigV1;
			readonly runtimeManifestLabel: string | null | undefined;
	  }
	| undefined {
	const root = asRecord(input);
	if (!root) return undefined;
	const configuration = ownValue(root, "config");
	const config = configuration === undefined ? {} : asRecord(configuration);
	if (!config) return undefined;
	const entrypoint = optionalStrings(ownValue(config, "Entrypoint"));
	const command = optionalStrings(ownValue(config, "Cmd"));
	const workingDirectory = optionalText(ownValue(config, "WorkingDir"));
	const user = optionalText(ownValue(config, "User"));
	const declaredEnvKeys = optionalEnvironmentKeys(ownValue(config, "Env"));
	if (
		entrypoint === null ||
		command === null ||
		workingDirectory === null ||
		user === null ||
		declaredEnvKeys === null
	) {
		return undefined;
	}
	const ociConfig = OciImageConfigV1Schema.safeParse({
		schemaVersion: 1,
		configDigest,
		operatingSystem: ownValue(root, "os"),
		architecture: ownValue(root, "architecture"),
		...(entrypoint === undefined ? {} : { entrypoint }),
		...(command === undefined ? {} : { command }),
		...(workingDirectory === undefined ? {} : { workingDirectory }),
		...(user === undefined ? {} : { user }),
		...(declaredEnvKeys === undefined ? {} : { declaredEnvKeys }),
	});
	if (!ociConfig.success) return undefined;
	const labels = ownValue(config, "Labels");
	if (labels === undefined) {
		return { ociConfig: ociConfig.data, runtimeManifestLabel: undefined };
	}
	const labelValues = asRecord(labels);
	if (!labelValues) return undefined;
	const label = ownValue(labelValues, runtimeManifestLabelName);
	return {
		ociConfig: ociConfig.data,
		runtimeManifestLabel:
			label === undefined
				? undefined
				: typeof label === "string"
					? label
					: null,
	};
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
	if (
		typeof input !== "object" ||
		input === null ||
		Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Object.prototype
	) {
		return undefined;
	}
	return input as Record<string, unknown>;
}

function ownValue(input: Record<string, unknown>, key: string): unknown {
	const property = Object.getOwnPropertyDescriptor(input, key);
	return property && "value" in property ? property.value : undefined;
}

function optionalStrings(input: unknown): readonly string[] | null | undefined {
	if (input === undefined) return undefined;
	return Array.isArray(input) &&
		input.every((value) => typeof value === "string")
		? input
		: null;
}

function optionalText(input: unknown): string | null | undefined {
	if (input === undefined) return undefined;
	return typeof input === "string" ? input : null;
}

function optionalEnvironmentKeys(
	input: unknown,
): readonly string[] | null | undefined {
	const values = optionalStrings(input);
	if (values === null || values === undefined) return values;
	return values.map((value) => value.split("=", 1)[0] ?? "");
}

function distributionFailureCode(
	status: unknown,
):
	| "IMAGE_NOT_FOUND"
	| "IMAGE_NOT_ADMITTED"
	| "OCI_CONFIG_INVALID"
	| "IMAGE_REGISTRY_UNAVAILABLE" {
	switch (status) {
		case "not-found":
			return "IMAGE_NOT_FOUND";
		case "not-admitted":
			return "IMAGE_NOT_ADMITTED";
		case "unavailable":
			return "IMAGE_REGISTRY_UNAVAILABLE";
		case "invalid":
			return "OCI_CONFIG_INVALID";
		default:
			return "OCI_CONFIG_INVALID";
	}
}

function rejected(
	request: Pick<ImageRegistryAdmissionRequestV1, "requestId" | "traceId">,
	code:
		| "IMAGE_REFERENCE_INVALID"
		| "IMAGE_NOT_FOUND"
		| "IMAGE_NOT_ADMITTED"
		| "OCI_CONFIG_INVALID"
		| "RUNTIME_MANIFEST_MISSING"
		| "RUNTIME_MANIFEST_INVALID"
		| "IMAGE_REGISTRY_UNAVAILABLE"
		| "IMAGE_ADMISSION_POLICY_UNAVAILABLE",
): ImageRegistryAdmissionResultV1 {
	const errors = {
		IMAGE_REFERENCE_INVALID: ["Image reference is invalid", false],
		IMAGE_NOT_FOUND: ["Image was not found", false],
		IMAGE_NOT_ADMITTED: [
			"The image is not admitted by deployment policy",
			false,
		],
		OCI_CONFIG_INVALID: ["OCI image config is invalid", false],
		RUNTIME_MANIFEST_MISSING: ["Runtime Manifest is missing", false],
		RUNTIME_MANIFEST_INVALID: ["Runtime Manifest is invalid", false],
		IMAGE_REGISTRY_UNAVAILABLE: ["Image registry is unavailable", true],
		IMAGE_ADMISSION_POLICY_UNAVAILABLE: [
			"Image admission policy is unavailable",
			true,
		],
	} as const;
	const [message, retryable] = errors[code];
	return ImageRegistryAdmissionResultV1Schema.parse({
		schemaVersion: 1,
		status: "rejected",
		requestId: request.requestId,
		traceId: request.traceId,
		error: {
			schemaVersion: 1,
			code,
			message,
			retryable,
			traceId: request.traceId,
		},
	});
}
