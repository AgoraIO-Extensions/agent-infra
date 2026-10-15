import { randomUUID } from "node:crypto";
import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	type RuntimeNativeMetadataBindingResponseV1,
	RuntimeNativeMetadataBindingResponseV1Schema,
	runtimeNativeMetadataRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import type { IdentityContext } from "./http/identity.js";

const maximumEntries = 128;

export interface RuntimeNativeMetadataRequestRegistryEntryV1 {
	readonly binding: RuntimeNativeMetadataBindingResponseV1;
	readonly identity: IdentityContext;
}

export interface RuntimeNativeMetadataRequestRegistryV1 {
	register(input: RuntimeNativeMetadataRequestRegistryEntryV1): string;
	lookup(
		sourceRef: string,
		request: NativeMetadataCurrentRequestV1,
	): RuntimeNativeMetadataRequestRegistryEntryV1 | undefined;
	release(sourceRef: string): void;
	clear(): void;
}

/** Request-local API authority for one bounded Worker current-confirmation flow. */
export function createRuntimeNativeMetadataRequestRegistryV1(
	options: {
		readonly now?: () => number;
		readonly maximumEntries?: number;
	} = {},
): RuntimeNativeMetadataRequestRegistryV1 {
	const now = options.now ?? Date.now;
	const maximum = options.maximumEntries ?? maximumEntries;
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > maximumEntries)
		throw new TypeError("Native metadata request registry size is invalid");
	const entries = new Map<
		string,
		RuntimeNativeMetadataRequestRegistryEntryV1
	>();
	const expire = (entry: RuntimeNativeMetadataRequestRegistryEntryV1) =>
		entry.binding.expiresAt <= now();
	return {
		register(input) {
			const binding = RuntimeNativeMetadataBindingResponseV1Schema.parse(
				input.binding,
			);
			if (
				binding.scope.principal.kind !== "user" ||
				binding.scope.principal.id !== input.identity.userId ||
				input.identity.accountStatus !== "active" ||
				expire({ binding, identity: input.identity })
			)
				throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
			for (const [sourceRef, entry] of entries) {
				if (expire(entry)) entries.delete(sourceRef);
			}
			if (entries.size >= maximum)
				throw new Error("NATIVE_METADATA_REQUEST_CAPACITY");
			const sourceRef = randomUUID();
			entries.set(sourceRef, { binding, identity: input.identity });
			return sourceRef;
		},
		lookup(sourceRef, request) {
			const entry = entries.get(sourceRef);
			if (!entry) return undefined;
			if (expire(entry)) {
				entries.delete(sourceRef);
				return undefined;
			}
			const parsed = NativeMetadataCurrentRequestV1Schema.parse(request);
			if (parsed.phase !== "read_metadata") return undefined;
			const { phase: _phase, ...requestBinding } = parsed;
			return runtimeNativeMetadataRequestSigningPayloadV1(requestBinding) ===
				runtimeNativeMetadataRequestSigningPayloadV1(entry.binding)
				? entry
				: undefined;
		},
		release(sourceRef) {
			entries.delete(sourceRef);
		},
		clear() {
			entries.clear();
		},
	};
}

type CurrentAuthorization =
	| {
			readonly outcome: "allowed";
			readonly authority: {
				readonly actorId: string;
				readonly agentId: string;
				readonly channelId: string;
				readonly authorizationRevision: string;
			};
	  }
	| { readonly outcome: "denied" | "revoked" | "unavailable" };

/** Build the default API current checker from the existing Conversation authorization port. */
export function createRuntimeNativeMetadataCurrentCheckerV1(options: {
	readonly registry: RuntimeNativeMetadataRequestRegistryV1;
	readonly authorize: (
		identity: IdentityContext,
		request: {
			readonly schemaVersion: 1;
			readonly operation: "conversation.read";
			readonly conversationId: string;
		},
	) => Promise<CurrentAuthorization>;
}) {
	if (
		typeof options.registry?.lookup !== "function" ||
		typeof options.authorize !== "function"
	)
		throw new TypeError("Native metadata current checker options are invalid");
	return {
		async check(input: {
			readonly request: NativeMetadataCurrentRequestV1;
			readonly apiRequestSourceRef: string;
			readonly signal: AbortSignal;
		}): Promise<NativeMetadataCurrentResponseV1> {
			if (input.signal.aborted) return { outcome: "unavailable" };
			let entry: RuntimeNativeMetadataRequestRegistryEntryV1 | undefined;
			try {
				entry = options.registry.lookup(
					input.apiRequestSourceRef,
					input.request,
				);
			} catch {
				return { outcome: "unavailable" };
			}
			if (!entry) return { outcome: "unavailable" };
			try {
				const decision = await options.authorize(entry.identity, {
					schemaVersion: 1,
					operation: "conversation.read",
					conversationId: entry.binding.scope.conversationId,
				});
				if (input.signal.aborted) return { outcome: "unavailable" };
				if (decision.outcome !== "allowed")
					return {
						outcome:
							decision.outcome === "revoked" ? "denied" : decision.outcome,
					};
				const authority = decision.authority;
				if (
					authority.actorId !== entry.binding.scope.principal.id ||
					authority.agentId !== entry.binding.scope.agentId ||
					authority.channelId !== entry.binding.scope.channelId ||
					authority.authorizationRevision !==
						entry.binding.scope.authorizationRevision
				)
					return { outcome: "denied" };
				return { outcome: "allowed", request: input.request };
			} catch {
				return { outcome: "unavailable" };
			}
		},
	};
}
