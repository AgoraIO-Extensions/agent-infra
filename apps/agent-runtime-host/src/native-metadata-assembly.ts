import type {
	RuntimeHost,
	RuntimeHostNativeMetadataReadContextV1,
} from "@agent-infra/agent-runtime";
import { RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	type RuntimeNativeMetadataReadRequestV1,
	RuntimeNativeMetadataReadRequestV1Schema,
	runtimeNativeMetadataRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";

export interface RuntimeNativeMetadataReadAssemblyV1 {
	/**
	 * Resolve the request-local Worker proof/current binding. Implementations
	 * must use the fixed deployment association for this Host and never accept a
	 * caller-selected URL, service identity, or scope.
	 */
	resolveContext(input: {
		readonly request: RuntimeNativeMetadataReadRequestV1;
		readonly signal: AbortSignal;
	}): Promise<RuntimeHostNativeMetadataReadContextV1 | null>;
}

function metadataCurrentBinding(
	value: Extract<NativeMetadataCurrentRequestV1, { phase: "read_metadata" }>,
) {
	const { phase: _phase, ...binding } = value;
	return binding;
}

/**
 * Compose the Host-side current confirmation with the already authenticated
 * Worker proof. The native session resolver is deployment-owned because only
 * the Host process can inspect its local native session binding.
 */
export function createRuntimeNativeMetadataCurrentAssemblyV1(options: {
	readonly current: {
		check(input: {
			readonly request: NativeMetadataCurrentRequestV1;
			readonly apiRequestSourceRef: string;
			readonly signal: AbortSignal;
		}): Promise<NativeMetadataCurrentResponseV1>;
	};
	readonly resolveNativeSessionRef: (input: {
		readonly request: RuntimeNativeMetadataReadRequestV1;
		readonly signal: AbortSignal;
	}) => Promise<string | null>;
	readonly verifyProof: (
		request: RuntimeNativeMetadataReadRequestV1,
	) => void | Promise<void>;
}): RuntimeNativeMetadataReadAssemblyV1 {
	if (
		typeof options.current?.check !== "function" ||
		typeof options.resolveNativeSessionRef !== "function" ||
		typeof options.verifyProof !== "function"
	)
		throw new TypeError("Runtime native metadata current assembly is invalid");
	return {
		async resolveContext({ request, signal }) {
			if (signal.aborted || !request.apiRequestSourceRef) return null;
			try {
				RuntimeNativeMetadataReadRequestV1Schema.parse(request);
				await options.verifyProof(request);
				const {
					proof: _proof,
					apiRequestSourceRef: _source,
					...identity
				} = request;
				const currentRequest = NativeMetadataCurrentRequestV1Schema.parse({
					...identity,
					phase: "read_metadata",
					originalHostScopeRef: request.originalHostScopeRef,
				});
				const current = await options.current.check({
					request: currentRequest,
					apiRequestSourceRef: request.apiRequestSourceRef,
					signal,
				});
				if (
					signal.aborted ||
					current.outcome !== "allowed" ||
					current.request.phase !== "read_metadata" ||
					runtimeNativeMetadataRequestSigningPayloadV1(
						metadataCurrentBinding(current.request),
					) !==
						runtimeNativeMetadataRequestSigningPayloadV1({
							...identity,
							originalHostScopeRef: request.originalHostScopeRef,
						})
				)
					return null;
				const nativeSessionRef = await options.resolveNativeSessionRef({
					request,
					signal,
				});
				if (!nativeSessionRef || signal.aborted) return null;
				const authority = {
					principal: request.scope.principal,
					scope: {
						agentId: request.scope.agentId,
						conversationId: request.scope.conversationId,
						executionId: request.scope.executionId,
						sessionGeneration: request.scope.sessionGeneration,
					},
				};
				return {
					nativeSessionRef,
					signal,
					expiresAt: request.expiresAt,
					scope: request.scope,
					originalHostScopeRef: request.originalHostScopeRef,
					assertCurrent: () => authority,
					revalidate: async () => {
						const next = await options.current.check({
							request: currentRequest,
							apiRequestSourceRef: request.apiRequestSourceRef as string,
							signal,
						});
						if (
							next.outcome !== "allowed" ||
							next.request.phase !== "read_metadata" ||
							runtimeNativeMetadataRequestSigningPayloadV1(
								metadataCurrentBinding(next.request),
							) !==
								runtimeNativeMetadataRequestSigningPayloadV1({
									...identity,
									originalHostScopeRef: request.originalHostScopeRef,
								})
						)
							throw new Error("current-denied");
						return authority;
					},
					verifyProof: () => options.verifyProof(request),
				};
			} catch {
				return null;
			}
		},
	};
}

/**
 * Bind the deployment-owned proof/current resolver to the RuntimeHost
 * lifecycle. RuntimeHost remains the authority for pre/post Driver checks and
 * projection validation; the resolver only supplies request-local evidence.
 */
export function createRuntimeNativeMetadataReadV1(
	host: Pick<RuntimeHost, "readNativeMetadataV1">,
	assembly: RuntimeNativeMetadataReadAssemblyV1,
) {
	if (
		typeof host?.readNativeMetadataV1 !== "function" ||
		typeof assembly?.resolveContext !== "function"
	)
		throw new TypeError("Runtime native metadata assembly is invalid");
	return async (
		value: RuntimeNativeMetadataReadRequestV1,
		signal: AbortSignal,
	) => {
		const parsed = RuntimeNativeMetadataReadRequestV1Schema.safeParse(value);
		if (!parsed.success)
			throw new RuntimeHostError(
				"RUNTIME_REQUEST_INVALID",
				"Runtime request is invalid",
				400,
			);
		const request = parsed.data;
		if (signal.aborted) throw unavailable();
		try {
			const context = await assembly.resolveContext({ request, signal });
			if (!context) throw unavailable();
			return await host.readNativeMetadataV1(request, { ...context, signal });
		} catch (error) {
			if (error instanceof RuntimeHostError) throw error;
			throw unavailable();
		}
	};
}

function unavailable() {
	return new RuntimeHostError(
		"RUNTIME_NATIVE_METADATA_UNAVAILABLE",
		"Runtime native metadata is unavailable",
		503,
		true,
	);
}
