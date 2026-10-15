import {
	type PlatformNativeMetadataReadRequestV1,
	type RuntimeNativeMetadataBindingResponseV1,
	RuntimeNativeMetadataBindingResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import { PostgresConversationQueryV1 } from "@agent-infra/platform-store";
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

type NativeMetadataScopeQueryV1 = Pick<
	PostgresConversationQueryV1,
	"readNativeMetadataObjectScopeV1"
>;

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
	readonly query: NativeMetadataScopeQueryV1;
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

export interface PlatformWorkerNativeMetadataGatewayPortsV1 {
	/** Explicit deployment seam; when absent the Store-backed resolver is used. */
	readonly binding?: WorkerRuntimeNativeMetadataBindingResolverV1;
	/** Explicit test/deployment seam; takes precedence over platformApiCurrent. */
	readonly current?: WorkerRuntimeNativeMetadataCurrentCheckerV1;
	/** Optional production Platform API current-confirmation input. */
	readonly platformApiCurrent?: PlatformApiNativeMetadataCurrentClientOptionsV1;
	/** Optional when deployment uses the same Worker signing key for proof. */
	readonly proofIssuer?: WorkerRuntimeNativeMetadataProofIssuerV1;
	readonly transport: WorkerRuntimeNativeMetadataTransportResolverV1;
	readonly port?: number;
}

export function createPlatformNativeMetadataGatewayAssemblyV1(options: {
	readonly serviceToken: string;
	/** Used only when the deployment omits an explicit binding resolver. */
	readonly databaseUrl?: string;
	readonly signing?: {
		readonly issuer: string;
		readonly workerId: string;
		readonly keyId: string;
		readonly privateKey: import("node:crypto").KeyObject;
		readonly now?: () => number;
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
	const defaultBinding =
		options.ports.binding === undefined && options.databaseUrl
			? (() => {
					const query = new PostgresConversationQueryV1({
						databaseUrl: options.databaseUrl,
					});
					return createPlatformNativeMetadataBindingResolverV1({
						query,
						close: () => query.close(),
					});
				})()
			: undefined;
	const binding = options.ports.binding ?? defaultBinding;
	if (!binding)
		throw new TypeError(
			"Platform Worker native metadata binding resolver is unavailable",
		);
	const gateway = createWorkerRuntimeNativeMetadataGatewayV1({
		...options.ports,
		binding,
		current,
		proofIssuer,
	});
	return {
		app: createWorkerRuntimeNativeMetadataGatewayAppV1({
			serviceToken: options.serviceToken,
			gateway,
			current,
		}),
		...(options.ports.port === undefined ? {} : { port: options.ports.port }),
		...(defaultBinding?.close ? { close: defaultBinding.close } : {}),
	};
}
