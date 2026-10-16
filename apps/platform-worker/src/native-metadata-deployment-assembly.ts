import {
	type PlatformNativeMetadataReadRequestV1,
	type RuntimeNativeMetadataBindingResponseV1,
	RuntimeNativeMetadataBindingResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	type NativeMetadataRuntimeTargetScopeResponseV1,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import { createWorkerRuntimeNativeMetadataClientV1 } from "./runtime-native-metadata-client.js";
import {
	createPlatformApiNativeMetadataCurrentClientV1,
	type PlatformApiNativeMetadataCurrentClientOptionsV1,
} from "./runtime-native-metadata-current-client.js";
import {
	createWorkerRuntimeNativeMetadataGatewayAppV1,
	createWorkerRuntimeNativeMetadataGatewayV1,
	type WorkerRuntimeNativeMetadataBindingResolverV1,
	type WorkerRuntimeNativeMetadataCurrentCheckerV1,
	type WorkerRuntimeNativeMetadataProofIssuerV1,
	type WorkerRuntimeNativeMetadataTransportResolverV1,
} from "./runtime-native-metadata-gateway.js";
import { createWorkerRuntimeNativeMetadataProofIssuerV1 } from "./runtime-native-metadata-proof.js";
import type { PlatformWorkerNativeMetadataGatewayServerOptionsV1 } from "./runtime-native-metadata-server.js";
import { sessionSandboxServiceTokenV1 } from "./session-workload-adapter.js";
import type { WorkloadRuntimeOptionsV1 } from "./workload-runtime.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";

type NativeMetadataObjectScopeQueryV1 = Pick<
	PostgresConversationQueryV1,
	"readNativeMetadataObjectScopeV1"
>;
type NativeMetadataCallbackCredentialScopeQueryV1 = Pick<
	PostgresConversationQueryV1,
	"readNativeMetadataCallbackCredentialScopeV1"
>;
type NativeMetadataRuntimeTargetScopeQueryV1 = Pick<
	PostgresConversationQueryV1,
	"readNativeMetadataRuntimeTargetScopeV1"
>;

function validNamespace(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 63 &&
		/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)
	);
}

function sameScope(
	left: PlatformNativeMetadataReadRequestV1["scope"],
	right: {
		readonly schemaVersion: number;
		readonly principal: { readonly kind: string; readonly id: string };
		readonly agentId: string;
		readonly channelId: string;
		readonly conversationId: string;
		readonly executionId: string;
		readonly sessionGeneration: number;
		readonly authorizationRevision: string;
	},
) {
	return (
		right.schemaVersion === left.schemaVersion &&
		right.principal.kind === left.principal.kind &&
		right.principal.id === left.principal.id &&
		right.agentId === left.agentId &&
		right.channelId === left.channelId &&
		right.conversationId === left.conversationId &&
		right.executionId === left.executionId &&
		right.sessionGeneration === left.sessionGeneration &&
		right.authorizationRevision === left.authorizationRevision
	);
}

/** Build the default Store-backed binding resolver; transport stays deployment-owned. */
export function createPlatformNativeMetadataBindingResolverV1(options: {
	readonly query: NativeMetadataObjectScopeQueryV1;
	readonly close?: () => Promise<void>;
}) {
	if (typeof options.query?.readNativeMetadataObjectScopeV1 !== "function")
		throw new TypeError("Platform native metadata query is invalid");
	return {
		async resolve(input: {
			readonly request: PlatformNativeMetadataReadRequestV1;
			readonly signal: AbortSignal;
		}): Promise<RuntimeNativeMetadataBindingResponseV1 | null> {
			try {
				const scope = await options.query.readNativeMetadataObjectScopeV1({
					scope: {
						actorId: input.request.scope.principal.id,
						channelId: input.request.scope.channelId,
						principal: input.request.scope.principal,
					},
					conversationId: input.request.scope.conversationId,
					executionId: input.request.scope.executionId,
					signal: input.signal,
				});
				if (
					!scope?.originalHostScopeRef ||
					!sameScope(input.request.scope, scope)
				)
					return null;
				const { apiRequestSourceRef: _source, ...identity } = input.request;
				return RuntimeNativeMetadataBindingResponseV1Schema.parse({
					...identity,
					originalHostScopeRef: scope.originalHostScopeRef,
				});
			} catch {
				return null;
			}
		},
		...(options.close ? { close: options.close } : {}),
	};
}

/**
 * Resolve the callback credential from the authoritative current Sandbox
 * allocation.  The deployment namespace is fixed by the Worker process; a
 * request cannot select a namespace or derive a token from caller metadata.
 */
export function createPlatformNativeMetadataSandboxCredentialResolverV1(options: {
	readonly query: NativeMetadataCallbackCredentialScopeQueryV1;
	readonly deploymentServiceToken: string;
	readonly namespace: string;
}) {
	if (
		!/^[\x21-\x7e]{1,8192}$/.test(options.deploymentServiceToken) ||
		!validNamespace(options.namespace) ||
		typeof options.query?.readNativeMetadataCallbackCredentialScopeV1 !==
			"function"
	)
		throw new TypeError(
			"Platform native metadata callback credential is invalid",
		);
	return {
		async resolve(input: {
			readonly binding: RuntimeNativeMetadataBindingResponseV1;
			readonly signal: AbortSignal;
		}): Promise<{
			readonly kind: "sandbox" | "deployment";
			readonly token: string;
		} | null> {
			try {
				const scope =
					await options.query.readNativeMetadataCallbackCredentialScopeV1({
						scope: {
							actorId: input.binding.scope.principal.id,
							channelId: input.binding.scope.channelId,
							principal: input.binding.scope.principal,
						},
						agentId: input.binding.scope.agentId,
						conversationId: input.binding.scope.conversationId,
						executionId: input.binding.scope.executionId,
						signal: input.signal,
					});
				if (
					!scope ||
					scope.originalHostScopeRef !== input.binding.originalHostScopeRef
				)
					return null;
				if (scope.sandboxId === null && scope.namespace === null)
					return { kind: "deployment", token: options.deploymentServiceToken };
				if (scope.sandboxId === null || scope.namespace !== options.namespace)
					return null;
				return {
					kind: "sandbox",
					token: sessionSandboxServiceTokenV1(
						options.deploymentServiceToken,
						scope.namespace,
						scope.sandboxId,
					),
				};
			} catch {
				return null;
			}
		},
	};
}

export interface PlatformWorkerNativeMetadataGatewayPortsV1 {
	/** Explicit deployment seam; when absent the Store-backed resolver is used. */
	readonly binding?: WorkerRuntimeNativeMetadataBindingResolverV1;
	/** Explicit test/deployment seam; takes precedence over platformApiCurrent. */
	readonly current?: WorkerRuntimeNativeMetadataCurrentCheckerV1;
	/** Optional production Platform API current-confirmation input. */
	readonly platformApiCurrent?: PlatformApiNativeMetadataCurrentClientOptionsV1;
	/** Optional when deployment uses the same Worker signing key for proof. */
	readonly proofIssuer?: WorkerRuntimeNativeMetadataProofIssuerV1;
	/** Explicit transport override; takes precedence over runtimeTarget. */
	readonly transport?: WorkerRuntimeNativeMetadataTransportResolverV1;
	/** Current Runtime Host callback credential, resolved from Store allocation. */
	readonly callbackCredential?: import("./runtime-native-metadata-gateway.js").WorkerRuntimeNativeMetadataCallbackCredentialResolverV1;
	/** Deployment-resolved fixed Runtime target keyed by the verified binding. */
	readonly runtimeTarget?: PlatformNativeMetadataRuntimeTargetResolverV1;
	readonly port?: number;
}

export interface PlatformNativeMetadataRuntimeTargetV1 {
	readonly baseUrl: string;
	readonly serviceToken: string;
}

export interface PlatformNativeMetadataRuntimeTargetResolverV1 {
	resolve(input: {
		readonly binding: RuntimeNativeMetadataBindingResponseV1;
		readonly signal: AbortSignal;
	}): Promise<PlatformNativeMetadataRuntimeTargetV1 | null>;
}

/**
 * Assemble the default Worker → Runtime metadata transport from a
 * deployment-owned, already-bound target. Request fields never select the
 * Runtime origin or credential.
 */
export function createPlatformNativeMetadataTransportResolverV1(options: {
	readonly resolveTarget: PlatformNativeMetadataRuntimeTargetResolverV1["resolve"];
	readonly fetch?: typeof fetch;
}): WorkerRuntimeNativeMetadataTransportResolverV1 {
	if (typeof options.resolveTarget !== "function")
		throw new TypeError("Platform Runtime target resolver is invalid");
	return {
		async resolve({ binding, signal }) {
			if (signal.aborted) return null;
			try {
				const target = await options.resolveTarget({ binding, signal });
				if (signal.aborted || !target || typeof target !== "object")
					return null;
				return createWorkerRuntimeNativeMetadataClientV1({
					baseUrl: target.baseUrl,
					serviceToken: target.serviceToken,
					...(options.fetch ? { fetch: options.fetch } : {}),
				});
			} catch {
				return null;
			}
		},
	};
}

/**
 * Resolve a current, deployment-owned Runtime target from the Store scope and
 * the existing production Conversation resolver.  The request cannot select
 * an origin, token, namespace, or Sandbox resource.
 */
export function createPlatformNativeMetadataRuntimeTargetResolverV1(options: {
	readonly query: NativeMetadataRuntimeTargetScopeQueryV1;
	readonly workload: WorkloadRuntimeOptionsV1;
	readonly resolveConversationRuntimeHost: ConversationRuntimeOptionsV2["resolveRuntimeHost"];
}) {
	if (
		typeof options.query?.readNativeMetadataRuntimeTargetScopeV1 !==
			"function" ||
		typeof options.resolveConversationRuntimeHost !== "function" ||
		!options.workload?.policy
	)
		throw new TypeError("Platform Runtime target resolver options are invalid");
	return {
		async resolve(input: {
			readonly binding: RuntimeNativeMetadataBindingResponseV1;
			readonly signal: AbortSignal;
		}): Promise<PlatformNativeMetadataRuntimeTargetV1 | null> {
			try {
				const binding = RuntimeNativeMetadataBindingResponseV1Schema.parse(
					input.binding,
				);
				const current =
					await options.query.readNativeMetadataRuntimeTargetScopeV1({
						scope: {
							actorId: binding.scope.principal.id,
							channelId: binding.scope.channelId,
							principal: binding.scope.principal,
						},
						agentId: binding.scope.agentId,
						conversationId: binding.scope.conversationId,
						executionId: binding.scope.executionId,
						sandboxPolicy: {
							namespace: options.workload.policy.namespace,
							resourceConfigurationHash: workloadResourceConfigurationHashV1(
								options.workload.policy,
							),
						},
						signal: input.signal,
					});
				if (
					input.signal.aborted ||
					!current ||
					!sameRuntimeTargetScope(current, binding)
				)
					return null;
				const host = await options.resolveConversationRuntimeHost({
					agentId: current.agentId,
					...(current.sandboxResource
						? { conversationId: current.conversationId }
						: {}),
					actorId: current.actorId,
					channelId: current.channelId,
					principal: current.principal,
					sessionGeneration: current.sessionGeneration,
					signal: input.signal,
					workload: current.workload,
					...(current.sandboxResource
						? { sandboxResource: current.sandboxResource }
						: {}),
					...(current.sandboxResource
						? { requireSandboxObservation: true as const }
						: {}),
					purpose: "control",
					command: "session.status",
				});
				if (input.signal.aborted) return null;
				return {
					baseUrl: host.baseUrl,
					serviceToken: host.serviceToken,
				};
			} catch {
				if (input.signal.aborted) return null;
				return null;
			}
		},
	};
}

function sameRuntimeTargetScope(
	current: NativeMetadataRuntimeTargetScopeResponseV1,
	binding: RuntimeNativeMetadataBindingResponseV1,
) {
	return (
		current.agentId === binding.scope.agentId &&
		current.actorId === binding.scope.principal.id &&
		current.channelId === binding.scope.channelId &&
		current.principal.kind === binding.scope.principal.kind &&
		current.principal.id === binding.scope.principal.id &&
		current.conversationId === binding.scope.conversationId &&
		current.executionId === binding.scope.executionId &&
		current.sessionGeneration === binding.scope.sessionGeneration &&
		current.authorizationRevision === binding.scope.authorizationRevision &&
		current.originalHostScopeRef === binding.originalHostScopeRef
	);
}

export function createPlatformNativeMetadataGatewayAssemblyV1(options: {
	readonly serviceToken: string;
	/** Fixed Kubernetes namespace for current callback credential derivation. */
	readonly namespace?: string;
	/** Used only when the deployment omits an explicit binding resolver. */
	readonly databaseUrl?: string;
	readonly signing?: {
		readonly issuer: string;
		readonly workerId: string;
		readonly keyId: string;
		readonly privateKey: import("node:crypto").KeyObject;
		readonly now?: () => number;
	};
	/** Worker-owned default target assembly used only when no transport override exists. */
	readonly defaultRuntimeTarget?: {
		readonly workload: WorkloadRuntimeOptionsV1;
		readonly resolveConversationRuntimeHost: ConversationRuntimeOptionsV2["resolveRuntimeHost"];
	};
	readonly ports: PlatformWorkerNativeMetadataGatewayPortsV1;
}): PlatformWorkerNativeMetadataGatewayServerOptionsV1 {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Platform Worker service token is invalid");
	const proofIssuer =
		options.ports.proofIssuer ??
		(options.signing
			? createWorkerRuntimeNativeMetadataProofIssuerV1({
					issuer: options.signing.issuer,
					workerId: options.signing.workerId,
					keyVersion: options.signing.keyId,
					privateKey: options.signing.privateKey,
					...(options.signing.now ? { now: options.signing.now } : {}),
				})
			: undefined);
	if (!proofIssuer)
		throw new TypeError(
			"Platform Worker native metadata proof issuer is unavailable",
		);
	const current =
		options.ports.current ??
		(options.ports.platformApiCurrent
			? createPlatformApiNativeMetadataCurrentClientV1(
					options.ports.platformApiCurrent,
				)
			: { check: async () => ({ outcome: "unavailable" as const }) });
	let defaultQuery: PostgresConversationQueryV1 | undefined;
	const needsDefaultQuery =
		options.databaseUrl !== undefined &&
		(options.ports.binding === undefined ||
			(options.namespace !== undefined &&
				options.ports.callbackCredential === undefined) ||
			(!options.ports.transport &&
				!options.ports.runtimeTarget &&
				options.defaultRuntimeTarget !== undefined));
	if (needsDefaultQuery) {
		defaultQuery = new PostgresConversationQueryV1({
			databaseUrl: options.databaseUrl as string,
		});
	}
	try {
		const defaultBinding =
			options.ports.binding === undefined && defaultQuery
				? (() => {
						return createPlatformNativeMetadataBindingResolverV1({
							query: defaultQuery,
						});
					})()
				: undefined;
		const binding = options.ports.binding ?? defaultBinding;
		if (!binding)
			throw new TypeError(
				"Platform Worker native metadata binding resolver is unavailable",
			);
		const callbackCredential =
			options.ports.callbackCredential ??
			(options.namespace && defaultQuery
				? createPlatformNativeMetadataSandboxCredentialResolverV1({
						query: defaultQuery,
						deploymentServiceToken: options.serviceToken,
						namespace: options.namespace,
					})
				: undefined);
		const transport =
			options.ports.transport ??
			(options.ports.runtimeTarget
				? createPlatformNativeMetadataTransportResolverV1({
						resolveTarget: options.ports.runtimeTarget.resolve.bind(
							options.ports.runtimeTarget,
						),
					})
				: defaultQuery && options.defaultRuntimeTarget
					? createPlatformNativeMetadataTransportResolverV1({
							resolveTarget:
								createPlatformNativeMetadataRuntimeTargetResolverV1({
									query: defaultQuery,
									workload: options.defaultRuntimeTarget.workload,
									resolveConversationRuntimeHost:
										options.defaultRuntimeTarget.resolveConversationRuntimeHost,
								}).resolve,
						})
					: undefined);
		if (!transport)
			throw new TypeError(
				"Platform Worker native metadata transport is unavailable",
			);
		const gateway = createWorkerRuntimeNativeMetadataGatewayV1({
			...options.ports,
			binding,
			current,
			proofIssuer,
			transport,
		});
		return {
			app: createWorkerRuntimeNativeMetadataGatewayAppV1({
				serviceToken: options.serviceToken,
				gateway,
				...(callbackCredential ? { binding, callbackCredential } : {}),
				current,
			}),
			...(options.ports.port === undefined ? {} : { port: options.ports.port }),
			...(defaultQuery ? { close: () => defaultQuery.close() } : {}),
		};
	} catch (error) {
		void defaultQuery?.close().catch(() => undefined);
		throw error;
	}
}
