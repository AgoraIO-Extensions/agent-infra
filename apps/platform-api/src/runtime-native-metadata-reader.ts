import { isDeepStrictEqual } from "node:util";
import {
	type NativeMetadataProjectionV1,
	PlatformNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataBindingResponseV1Schema,
	type RuntimeNativeMetadataProofV1,
	RuntimeNativeMetadataProofV1Schema,
	type RuntimeNativeMetadataReadRequestV1,
	RuntimeNativeMetadataReadResponseV1Schema,
	runtimeNativeMetadataRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import type { IdentityContext } from "./http/identity.js";
import type { RuntimeNativeMetadataRequestRegistryV1 } from "./runtime-native-metadata-current.js";
import type { RuntimeNativeMetadataRequestContextV1 } from "./runtime-native-metadata-request-context.js";

export interface RuntimeNativeMetadataTransportV1 {
	read(
		request: RuntimeNativeMetadataReadRequestV1,
		signal: AbortSignal,
	): Promise<unknown>;
}

export interface RuntimeNativeMetadataProofIssuerV1 {
	issue(input: {
		readonly request: RuntimeNativeMetadataBindingResponseV1;
		readonly signal: AbortSignal;
	}): Promise<RuntimeNativeMetadataProofV1>;
}

export interface RuntimeNativeMetadataWorkerGatewayV1 {
	read(
		request: import("@agent-infra/contracts/runtime").PlatformNativeMetadataReadRequestV1,
		signal: AbortSignal,
	): Promise<unknown>;
}

type RuntimeNativeMetadataBindingResponseV1 =
	import("@agent-infra/contracts/runtime").RuntimeNativeMetadataBindingResponseV1;

function sameBinding(
	left: RuntimeNativeMetadataBindingResponseV1,
	right: RuntimeNativeMetadataBindingResponseV1,
) {
	return (
		runtimeNativeMetadataRequestSigningPayloadV1(left) ===
		runtimeNativeMetadataRequestSigningPayloadV1(right)
	);
}

type ResolveRequest = (input: {
	readonly identity: IdentityContext;
	readonly conversationId: string;
	readonly executionId: string;
	readonly selector: "status" | "commands" | "skills";
	readonly signal: AbortSignal;
	readonly requestContext?: RuntimeNativeMetadataRequestContextV1;
}) => Promise<RuntimeNativeMetadataBindingResponseV1 | null>;

async function prepareRead(
	resolveRequest: ResolveRequest,
	identity: IdentityContext,
	conversationId: string,
	executionId: string,
	selector: "status" | "commands" | "skills",
	requestContext: RuntimeNativeMetadataRequestContextV1,
) {
	const input = {
		identity,
		conversationId,
		executionId,
		selector,
		signal: requestContext.signal,
		requestContext,
	};
	const current = await requestContext.revalidate(identity);
	const resolved = await requestContext.run(() =>
		resolveRequest({ ...input, identity: current }),
	);
	if (!resolved) throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
	const binding = RuntimeNativeMetadataBindingResponseV1Schema.parse(resolved);
	if (
		binding.selector !== selector ||
		binding.scope.principal.kind !== "user" ||
		binding.scope.principal.id !== identity.userId ||
		binding.scope.conversationId !== conversationId ||
		binding.scope.executionId !== executionId ||
		binding.scope.channelId !== "web" ||
		binding.readStartedAt !== requestContext.readStartedAt
	)
		throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
	requestContext.limit(binding.expiresAt);
	const revalidate = async () => {
		const fresh = await requestContext.revalidate(identity);
		const original = await requestContext.run(() =>
			resolveRequest({ ...input, identity: fresh }),
		);
		if (
			!original ||
			!isDeepStrictEqual(original.scope, binding.scope) ||
			original.originalHostScopeRef !== binding.originalHostScopeRef ||
			original.readStartedAt !== binding.readStartedAt ||
			original.expiresAt !== binding.expiresAt
		) {
			requestContext.close();
			throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
		}
		return requestContext.revalidate(identity);
	};
	return { binding, revalidate };
}

/**
 * API-side producer adapter for request-local native metadata reads.
 * Deployment code owns proof signing and Worker transport; this seam owns
 * identity/selector binding and response projection before data reaches Web.
 */
export function createRuntimeNativeMetadataReaderV1(options: {
	readonly resolveRequest: (input: {
		readonly identity: IdentityContext;
		readonly conversationId: string;
		readonly executionId: string;
		readonly selector: "status" | "commands" | "skills";
		readonly signal: AbortSignal;
		readonly requestContext?: RuntimeNativeMetadataRequestContextV1;
	}) => Promise<RuntimeNativeMetadataBindingResponseV1 | null>;
	readonly proofIssuer: RuntimeNativeMetadataProofIssuerV1;
	readonly transport: RuntimeNativeMetadataTransportV1;
}) {
	if (
		typeof options.resolveRequest !== "function" ||
		typeof options.proofIssuer?.issue !== "function" ||
		typeof options.transport?.read !== "function"
	)
		throw new TypeError("Runtime native metadata reader options are invalid");
	return {
		async read(
			identity: IdentityContext,
			conversationId: string,
			executionId: string,
			selector: "status" | "commands" | "skills",
			requestContext: RuntimeNativeMetadataRequestContextV1,
		): Promise<NativeMetadataProjectionV1 | null> {
			if (!requestContext) return null;
			try {
				const { binding, revalidate } = await prepareRead(
					options.resolveRequest,
					identity,
					conversationId,
					executionId,
					selector,
					requestContext,
				);
				const proof = RuntimeNativeMetadataProofV1Schema.parse(
					await requestContext.run((signal) =>
						options.proofIssuer.issue({
							request: binding,
							signal,
						}),
					),
				);
				await revalidate();
				const response = RuntimeNativeMetadataReadResponseV1Schema.parse(
					await requestContext.run(() =>
						options.transport.read(
							{ ...binding, proof },
							requestContext.signal,
						),
					),
				);
				const { projection: _projection, ...responseBindingInput } = response;
				const responseBinding =
					RuntimeNativeMetadataBindingResponseV1Schema.parse(
						responseBindingInput,
					);
				if (
					!sameBinding(binding, responseBinding) ||
					response.projection.selector !== selector
				)
					throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
				await revalidate();
				requestContext.beforeDelivery(revalidate);
				return response.projection;
			} catch {
				requestContext.close();
				return null;
			}
		},
	};
}

/** API reader variant for the production Worker-only proof path. */
export function createRuntimeNativeMetadataWorkerReaderV1(options: {
	readonly resolveRequest: Parameters<
		typeof createRuntimeNativeMetadataReaderV1
	>[0]["resolveRequest"];
	readonly gateway: RuntimeNativeMetadataWorkerGatewayV1;
	readonly requestRegistry?: RuntimeNativeMetadataRequestRegistryV1;
}) {
	if (
		typeof options.resolveRequest !== "function" ||
		typeof options.gateway?.read !== "function"
	)
		throw new TypeError(
			"Runtime native metadata Worker reader options are invalid",
		);
	return {
		async read(
			identity: IdentityContext,
			conversationId: string,
			executionId: string,
			selector: "status" | "commands" | "skills",
			requestContext: RuntimeNativeMetadataRequestContextV1,
		): Promise<NativeMetadataProjectionV1 | null> {
			if (!requestContext) return null;
			const registry = options.requestRegistry;
			if (!registry) {
				requestContext.close();
				return null;
			}
			let requestSourceRef: string | undefined;
			try {
				const { binding, revalidate } = await prepareRead(
					options.resolveRequest,
					identity,
					conversationId,
					executionId,
					selector,
					requestContext,
				);
				const { originalHostScopeRef: _hostScope, ...requestIdentity } =
					binding;
				requestSourceRef = registry.register({
					binding,
					identity,
					requestContext,
					revalidate,
				});
				const request = PlatformNativeMetadataReadRequestV1Schema.parse({
					...requestIdentity,
					apiRequestSourceRef: requestSourceRef,
				});
				const response = RuntimeNativeMetadataReadResponseV1Schema.parse(
					await requestContext.run((signal) =>
						options.gateway.read(request, signal),
					),
				);
				const { projection: _projection, ...responseBinding } = response;
				if (
					runtimeNativeMetadataRequestSigningPayloadV1(responseBinding) !==
						runtimeNativeMetadataRequestSigningPayloadV1(binding) ||
					response.projection.selector !== selector
				)
					throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
				await revalidate();
				requestContext.beforeDelivery(revalidate);
				return response.projection;
			} catch {
				requestContext.close();
				return null;
			} finally {
				if (requestSourceRef) registry.release(requestSourceRef);
			}
		},
	};
}
