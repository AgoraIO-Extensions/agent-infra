import { timingSafeEqual } from "node:crypto";

import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	type PlatformNativeMetadataReadRequestV1,
	PlatformNativeMetadataReadRequestV1Schema,
	type RuntimeNativeMetadataBindingResponseV1,
	RuntimeNativeMetadataBindingResponseV1Schema,
	type RuntimeNativeMetadataProofV1,
	type RuntimeNativeMetadataReadRequestV1,
	type RuntimeNativeMetadataReadResponseV1,
	RuntimeNativeMetadataReadResponseV1Schema,
	runtimeNativeMetadataRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";

const gatewayPath = "/internal/platform-worker/v1/native-metadata";
const currentPath = "/internal/platform-worker/v1/native-metadata/current";
const maximumRequestBytes = 1_048_576;

function parseCurrentBody(value: unknown) {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("invalid");
	const candidate = value as Record<string, unknown>;
	if (
		Object.keys(candidate).length !== 2 ||
		typeof candidate.apiRequestSourceRef !== "string" ||
		candidate.apiRequestSourceRef.length < 1 ||
		candidate.apiRequestSourceRef.length > 256
	)
		throw new Error("invalid");
	return {
		apiRequestSourceRef: candidate.apiRequestSourceRef,
		request: NativeMetadataCurrentRequestV1Schema.parse(candidate.request),
	};
}

export interface WorkerRuntimeNativeMetadataProofIssuerV1 {
	issue(input: {
		readonly request: RuntimeNativeMetadataBindingResponseV1;
		readonly apiRequestSourceRef?: string;
		readonly signal: AbortSignal;
	}): Promise<RuntimeNativeMetadataProofV1>;
}

export interface WorkerRuntimeNativeMetadataBindingResolverV1 {
	/** Resolve the original binding after API current authorization. */
	resolve(input: {
		readonly request: PlatformNativeMetadataReadRequestV1;
		readonly signal: AbortSignal;
	}): Promise<RuntimeNativeMetadataBindingResponseV1 | null>;
}

export interface WorkerRuntimeNativeMetadataCurrentCheckerV1 {
	/** Reconfirm the original API request and Host scope on every call. */
	check(input: {
		readonly request: NativeMetadataCurrentRequestV1;
		readonly apiRequestSourceRef: string;
		readonly signal: AbortSignal;
	}): Promise<NativeMetadataCurrentResponseV1>;
}

export interface WorkerRuntimeNativeMetadataTransportV1 {
	read(
		request: RuntimeNativeMetadataReadRequestV1,
		signal: AbortSignal,
	): Promise<unknown>;
}

export interface WorkerRuntimeNativeMetadataTransportResolverV1 {
	/** Resolve a fixed deployment-owned Runtime transport; request fields cannot select its origin. */
	resolve(input: {
		readonly binding: RuntimeNativeMetadataBindingResponseV1;
		readonly signal: AbortSignal;
	}): Promise<WorkerRuntimeNativeMetadataTransportV1 | null>;
}

function unavailable(): never {
	throw new Error("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
}

function authorized(header: string | null, expectedToken: string) {
	if (!header?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(expectedToken);
	return (
		supplied.length === expected.length && timingSafeEqual(supplied, expected)
	);
}

function sameIdentity(
	left: PlatformNativeMetadataReadRequestV1,
	right: RuntimeNativeMetadataBindingResponseV1,
) {
	const { apiRequestSourceRef: _source, ...identity } = left;
	return (
		runtimeNativeMetadataRequestSigningPayloadV1({
			...identity,
			originalHostScopeRef: right.originalHostScopeRef,
		}) === runtimeNativeMetadataRequestSigningPayloadV1(right)
	);
}

function sameCurrent(
	value: NativeMetadataCurrentResponseV1,
	binding: RuntimeNativeMetadataBindingResponseV1,
) {
	if (value.outcome !== "allowed" || value.request.phase !== "read_metadata")
		return false;
	const { phase: _phase, ...request } = value.request;
	return (
		runtimeNativeMetadataRequestSigningPayloadV1(request) ===
		runtimeNativeMetadataRequestSigningPayloadV1(binding)
	);
}

function currentRequest(
	binding: RuntimeNativeMetadataBindingResponseV1,
): NativeMetadataCurrentRequestV1 {
	return NativeMetadataCurrentRequestV1Schema.parse({
		...binding,
		phase: "read_metadata",
	});
}

async function boundedRequestBody(request: Request) {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maximumRequestBytes) {
				await reader.cancel();
				throw new Error("RUNTIME_REQUEST_TOO_LARGE");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, bytes).toString("utf8");
}

/** Coordinate one authenticated API → Worker → RuntimeHost metadata read. */
export function createWorkerRuntimeNativeMetadataGatewayV1(options: {
	readonly binding: WorkerRuntimeNativeMetadataBindingResolverV1;
	readonly current: WorkerRuntimeNativeMetadataCurrentCheckerV1;
	readonly proofIssuer: WorkerRuntimeNativeMetadataProofIssuerV1;
	readonly transport: WorkerRuntimeNativeMetadataTransportResolverV1;
}) {
	if (
		typeof options.binding?.resolve !== "function" ||
		typeof options.current?.check !== "function" ||
		typeof options.proofIssuer?.issue !== "function" ||
		typeof options.transport?.resolve !== "function"
	)
		throw new TypeError("Runtime native metadata gateway options are invalid");
	return {
		async read(
			value: PlatformNativeMetadataReadRequestV1,
			signal: AbortSignal,
		): Promise<RuntimeNativeMetadataReadResponseV1> {
			if (signal.aborted) unavailable();
			const request = PlatformNativeMetadataReadRequestV1Schema.parse(value);
			const binding = await options.binding.resolve({ request, signal });
			if (signal.aborted || !binding) unavailable();
			const parsedBinding =
				RuntimeNativeMetadataBindingResponseV1Schema.parse(binding);
			if (!sameIdentity(request, parsedBinding)) unavailable();
			const current = await options.current.check({
				request: currentRequest(parsedBinding),
				apiRequestSourceRef: request.apiRequestSourceRef,
				signal,
			});
			if (signal.aborted || !sameCurrent(current, parsedBinding)) unavailable();
			const proof = await options.proofIssuer.issue({
				request: parsedBinding,
				...(request.apiRequestSourceRef
					? { apiRequestSourceRef: request.apiRequestSourceRef }
					: {}),
				signal,
			});
			const transport = await options.transport.resolve({
				binding: parsedBinding,
				signal,
			});
			if (signal.aborted || !transport) unavailable();
			const response = RuntimeNativeMetadataReadResponseV1Schema.parse(
				await transport.read(
					{
						...parsedBinding,
						...(request.apiRequestSourceRef
							? { apiRequestSourceRef: request.apiRequestSourceRef }
							: {}),
						proof,
					},
					signal,
				),
			);
			const { projection: _projection, ...responseBinding } = response;
			if (
				runtimeNativeMetadataRequestSigningPayloadV1(responseBinding) !==
					runtimeNativeMetadataRequestSigningPayloadV1(parsedBinding) ||
				response.projection.selector !== parsedBinding.selector
			)
				unavailable();
			const after = await options.current.check({
				request: currentRequest(parsedBinding),
				apiRequestSourceRef: request.apiRequestSourceRef,
				signal,
			});
			if (signal.aborted || !sameCurrent(after, parsedBinding)) unavailable();
			return response;
		},
	};
}

/** Fetch-style internal Worker ingress; deployment code owns the listener and token. */
export function createWorkerRuntimeNativeMetadataGatewayAppV1(options: {
	readonly serviceToken: string;
	readonly gateway: Pick<
		ReturnType<typeof createWorkerRuntimeNativeMetadataGatewayV1>,
		"read"
	>;
	readonly current?: WorkerRuntimeNativeMetadataCurrentCheckerV1;
}) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Runtime native metadata service token is invalid");
	return {
		async fetch(request: Request): Promise<Response> {
			const path = new URL(request.url).pathname;
			if (
				request.method !== "POST" ||
				![gatewayPath, currentPath].includes(path)
			)
				return new Response(null, { status: 404 });
			if (
				!authorized(request.headers.get("authorization"), options.serviceToken)
			)
				return Response.json(
					{ code: "PLATFORM_WORKER_UNAUTHORIZED" },
					{ status: 401 },
				);
			let value:
				| PlatformNativeMetadataReadRequestV1
				| {
						apiRequestSourceRef: string;
						request: NativeMetadataCurrentRequestV1;
				  };
			try {
				const body = await boundedRequestBody(request);
				const parsed = JSON.parse(body);
				value =
					path === currentPath
						? parseCurrentBody(parsed)
						: PlatformNativeMetadataReadRequestV1Schema.parse(parsed);
			} catch {
				return Response.json(
					{ code: "RUNTIME_REQUEST_INVALID" },
					{ status: 400 },
				);
			}
			try {
				if (path === currentPath) {
					if (!options.current)
						return Response.json({ outcome: "unavailable" }, { status: 503 });
					const current = await options.current.check({
						request: (value as { request: NativeMetadataCurrentRequestV1 })
							.request,
						apiRequestSourceRef: (value as { apiRequestSourceRef: string })
							.apiRequestSourceRef,
						signal: request.signal,
					});
					return Response.json(current, {
						status: current.outcome === "denied" ? 403 : 200,
					});
				}
				const response = await options.gateway.read(
					value as PlatformNativeMetadataReadRequestV1,
					request.signal,
				);
				return Response.json(response);
			} catch {
				return Response.json(
					{ code: "RUNTIME_NATIVE_METADATA_UNAVAILABLE" },
					{ status: 503 },
				);
			}
		},
	};
}
