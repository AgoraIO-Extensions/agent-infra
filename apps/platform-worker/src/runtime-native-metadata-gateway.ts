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
	RuntimeNativeMetadataReadResponseV1OrV2Schema,
	runtimeNativeMetadataRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import { logNativeMetadataHop } from "@agent-infra/native-metadata-transport";

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

export interface WorkerRuntimeNativeMetadataCallbackCredentialResolverV1 {
	/** Resolve the credential for the already Store-bound current callback. */
	resolve(input: {
		readonly binding: RuntimeNativeMetadataBindingResponseV1;
		readonly signal: AbortSignal;
	}): Promise<{
		readonly kind: "sandbox" | "deployment";
		readonly token: string;
	} | null>;
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

type HostCurrentRequest = ReturnType<typeof parseCurrentBody>;

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
	// Only an active Host delivery can authorize a nested callback to the API.
	const active = new Map<
		string,
		{
			readonly binding: string;
			readonly sourceRef: string;
			readonly signal: AbortSignal;
		}
	>();
	return {
		async checkHostCurrent(
			value: HostCurrentRequest,
			callbackSignal: AbortSignal,
		): Promise<NativeMetadataCurrentResponseV1> {
			if (value.request.phase !== "read_metadata")
				return { outcome: "unavailable" };
			const { phase: _phase, ...binding } = value.request;
			const entry = active.get(binding.readId);
			if (
				!entry ||
				entry.sourceRef !== value.apiRequestSourceRef ||
				entry.binding !==
					runtimeNativeMetadataRequestSigningPayloadV1(binding) ||
				binding.expiresAt <= Date.now() ||
				entry.signal.aborted ||
				callbackSignal.aborted
			)
				return { outcome: "unavailable" };
			const signal = AbortSignal.any([entry.signal, callbackSignal]);
			const result = await options.current.check({
				request: value.request,
				apiRequestSourceRef: entry.sourceRef,
				signal,
			});
			if (
				signal.aborted ||
				active.get(binding.readId) !== entry ||
				binding.expiresAt <= Date.now()
			)
				return { outcome: "unavailable" };
			return result;
		},
		async read(
			value: PlatformNativeMetadataReadRequestV1,
			signal: AbortSignal,
		): Promise<
			import("@agent-infra/contracts/runtime").RuntimeNativeMetadataReadResponseV1OrV2
		> {
			if (signal.aborted) unavailable();
			const request = PlatformNativeMetadataReadRequestV1Schema.parse(value);
			let step:
				| "binding"
				| "current-before"
				| "proof"
				| "target"
				| "host"
				| "current-after" = "binding";
			let stageBegan = performance.now();
			const elapsed = () =>
				Math.max(0, Math.round(performance.now() - stageBegan));
			const advance = (next: typeof step) => {
				logNativeMetadataHop(
					"worker.read",
					step,
					request.traceId,
					"ok",
					elapsed(),
				);
				step = next;
				stageBegan = performance.now();
				logNativeMetadataHop(
					"worker.read",
					step,
					request.traceId,
					"started",
					0,
				);
			};
			logNativeMetadataHop("worker.read", step, request.traceId, "started", 0);
			try {
				const binding = await options.binding.resolve({ request, signal });
				if (signal.aborted || !binding) unavailable();
				const parsedBinding =
					RuntimeNativeMetadataBindingResponseV1Schema.parse(binding);
				if (!sameIdentity(request, parsedBinding)) unavailable();
				advance("current-before");
				const current = await options.current.check({
					request: currentRequest(parsedBinding),
					apiRequestSourceRef: request.apiRequestSourceRef,
					signal,
				});
				if (signal.aborted || !sameCurrent(current, parsedBinding))
					unavailable();
				advance("proof");
				const proof = await options.proofIssuer.issue({
					request: parsedBinding,
					...(request.apiRequestSourceRef
						? { apiRequestSourceRef: request.apiRequestSourceRef }
						: {}),
					signal,
				});
				advance("target");
				const transport = await options.transport.resolve({
					binding: parsedBinding,
					signal,
				});
				if (signal.aborted || !transport) unavailable();
				advance("host");
				if (active.size >= 128 || active.has(parsedBinding.readId))
					unavailable();
				const remaining = parsedBinding.expiresAt - Date.now();
				if (remaining <= 0) unavailable();
				const delivery = new AbortController();
				const deliverySignal = AbortSignal.any([
					signal,
					delivery.signal,
					AbortSignal.timeout(remaining),
				]);
				const release = () => active.delete(parsedBinding.readId);
				active.set(parsedBinding.readId, {
					binding: runtimeNativeMetadataRequestSigningPayloadV1(parsedBinding),
					sourceRef: request.apiRequestSourceRef,
					signal: deliverySignal,
				});
				deliverySignal.addEventListener("abort", release, { once: true });
				let response: import("@agent-infra/contracts/runtime").RuntimeNativeMetadataReadResponseV1OrV2;
				try {
					deliverySignal.throwIfAborted();
					response = RuntimeNativeMetadataReadResponseV1OrV2Schema.parse(
						await transport.read(
							{
								...parsedBinding,
								apiRequestSourceRef: request.apiRequestSourceRef,
								proof,
							},
							deliverySignal,
						),
					);
					deliverySignal.throwIfAborted();
				} finally {
					// The abort handler removes this entry and cancels any outstanding callback.
					delivery.abort();
				}
				const { projection: _projection, ...responseBinding } = response;
				if (
					runtimeNativeMetadataRequestSigningPayloadV1(responseBinding) !==
						runtimeNativeMetadataRequestSigningPayloadV1(parsedBinding) ||
					response.projection.selector !== parsedBinding.selector
				)
					unavailable();
				advance("current-after");
				const after = await options.current.check({
					request: currentRequest(parsedBinding),
					apiRequestSourceRef: request.apiRequestSourceRef,
					signal,
				});
				if (signal.aborted || !sameCurrent(after, parsedBinding)) unavailable();
				logNativeMetadataHop(
					"worker.read",
					step,
					request.traceId,
					"ok",
					elapsed(),
				);
				return response;
			} catch (error) {
				logNativeMetadataHop(
					"worker.read",
					step,
					request.traceId,
					"unavailable",
					elapsed(),
				);
				throw error;
			}
		},
	};
}

/** Fetch-style internal Worker ingress; deployment code owns the listener and token. */
export function createWorkerRuntimeNativeMetadataGatewayAppV1(options: {
	readonly serviceToken: string;
	readonly gateway: Pick<
		ReturnType<typeof createWorkerRuntimeNativeMetadataGatewayV1>,
		"read" | "checkHostCurrent"
	>;
	/** Store-backed resolver used only by the Runtime Host current callback. */
	readonly binding?: WorkerRuntimeNativeMetadataBindingResolverV1;
	readonly callbackCredential?: WorkerRuntimeNativeMetadataCallbackCredentialResolverV1;
}) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Runtime native metadata service token is invalid");
	if (
		(options.binding === undefined) !==
		(options.callbackCredential === undefined)
	)
		throw new TypeError(
			"Runtime native metadata callback credential is invalid",
		);
	const currentAuthorization = async (input: {
		readonly header: string | null;
		readonly value: {
			readonly apiRequestSourceRef: string;
			readonly request: NativeMetadataCurrentRequestV1;
		};
		readonly signal: AbortSignal;
	}) => {
		if (
			!options.binding ||
			!options.callbackCredential ||
			input.value.request.phase !== "read_metadata"
		)
			return false;
		try {
			const {
				phase: _phase,
				originalHostScopeRef: _host,
				...identity
			} = input.value.request;
			const readRequest = PlatformNativeMetadataReadRequestV1Schema.parse({
				...identity,
				apiRequestSourceRef: input.value.apiRequestSourceRef,
			});
			const binding = await options.binding.resolve({
				request: readRequest,
				signal: input.signal,
			});
			if (
				input.signal.aborted ||
				!binding ||
				!sameIdentity(readRequest, binding) ||
				binding.originalHostScopeRef !==
					input.value.request.originalHostScopeRef
			)
				return false;
			const credential = await options.callbackCredential.resolve({
				binding,
				signal: input.signal,
			});
			if (!credential || input.signal.aborted) return false;
			return authorized(input.header, credential.token);
		} catch {
			return false;
		}
	};
	return {
		async fetch(request: Request): Promise<Response> {
			const path = new URL(request.url).pathname;
			if (
				request.method !== "POST" ||
				![gatewayPath, currentPath].includes(path)
			)
				return new Response(null, { status: 404 });
			let value:
				| PlatformNativeMetadataReadRequestV1
				| {
						apiRequestSourceRef: string;
						request: NativeMetadataCurrentRequestV1;
				  };
			try {
				if (
					path === gatewayPath &&
					!authorized(
						request.headers.get("authorization"),
						options.serviceToken,
					)
				)
					return Response.json(
						{ code: "PLATFORM_WORKER_UNAUTHORIZED" },
						{ status: 401 },
					);
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
					if (!options.binding || !options.callbackCredential)
						return Response.json({ outcome: "unavailable" }, { status: 503 });
					if (
						!(await currentAuthorization({
							header: request.headers.get("authorization"),
							value: value as {
								readonly apiRequestSourceRef: string;
								readonly request: NativeMetadataCurrentRequestV1;
							},
							signal: request.signal,
						}))
					)
						return Response.json(
							{ code: "PLATFORM_WORKER_UNAUTHORIZED" },
							{ status: 401 },
						);
					const current = await options.gateway.checkHostCurrent(
						value as HostCurrentRequest,
						request.signal,
					);
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
