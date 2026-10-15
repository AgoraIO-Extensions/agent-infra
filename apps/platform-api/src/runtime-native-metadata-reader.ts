import { randomUUID } from "node:crypto";
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
		): Promise<NativeMetadataProjectionV1 | null> {
			const controller = new AbortController();
			try {
				const resolved = await options.resolveRequest({
					identity,
					conversationId,
					executionId,
					selector,
					signal: controller.signal,
				});
				if (!resolved) return null;
				const binding =
					RuntimeNativeMetadataBindingResponseV1Schema.parse(resolved);
				if (
					binding.selector !== selector ||
					binding.scope.principal.kind !== "user" ||
					binding.scope.principal.id !== identity.userId ||
					binding.scope.authorizationRevision !==
						identity.authorizationRevision ||
					binding.scope.conversationId !== conversationId ||
					binding.scope.executionId !== executionId ||
					binding.scope.channelId !== "web"
				)
					return null;
				const proof = RuntimeNativeMetadataProofV1Schema.parse(
					await options.proofIssuer.issue({
						request: binding,
						signal: controller.signal,
					}),
				);
				const response = RuntimeNativeMetadataReadResponseV1Schema.parse(
					await options.transport.read(
						{ ...binding, proof },
						controller.signal,
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
					return null;
				return response.projection;
			} catch {
				return null;
			} finally {
				controller.abort();
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
		): Promise<NativeMetadataProjectionV1 | null> {
			const controller = new AbortController();
			let requestSourceRef: string | undefined;
			try {
				const resolved = await options.resolveRequest({
					identity,
					conversationId,
					executionId,
					selector,
					signal: controller.signal,
				});
				if (!resolved) return null;
				const binding =
					RuntimeNativeMetadataBindingResponseV1Schema.parse(resolved);
				if (
					binding.selector !== selector ||
					binding.scope.principal.kind !== "user" ||
					binding.scope.principal.id !== identity.userId ||
					binding.scope.authorizationRevision !==
						identity.authorizationRevision ||
					binding.scope.conversationId !== conversationId ||
					binding.scope.executionId !== executionId ||
					binding.scope.channelId !== "web"
				)
					return null;
				const { originalHostScopeRef: _hostScope, ...requestIdentity } =
					binding;
				requestSourceRef = options.requestRegistry?.register({
					binding,
					identity,
				});
				const request = PlatformNativeMetadataReadRequestV1Schema.parse({
					...requestIdentity,
					apiRequestSourceRef: requestSourceRef ?? randomUUID(),
				});
				const response = RuntimeNativeMetadataReadResponseV1Schema.parse(
					await options.gateway.read(request, controller.signal),
				);
				const { projection: _projection, ...responseBinding } = response;
				if (
					runtimeNativeMetadataRequestSigningPayloadV1(responseBinding) !==
						runtimeNativeMetadataRequestSigningPayloadV1(binding) ||
					response.projection.selector !== selector
				)
					return null;
				return response.projection;
			} catch {
				return null;
			} finally {
				if (requestSourceRef)
					options.requestRegistry?.release(requestSourceRef);
				controller.abort();
			}
		},
	};
}
