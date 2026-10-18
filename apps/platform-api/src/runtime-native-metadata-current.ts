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
import type { RuntimeNativeMetadataRequestContextV1 } from "./runtime-native-metadata-request-context.js";

const maximumEntries = 128;

export interface RuntimeNativeMetadataRequestRegistryEntryV1 {
	readonly binding: RuntimeNativeMetadataBindingResponseV1;
	readonly identity: IdentityContext;
	readonly requestContext: RuntimeNativeMetadataRequestContextV1;
	readonly revalidate: () => Promise<IdentityContext>;
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
	const abortListeners = new Map<string, () => void>();
	const release = (sourceRef: string) => {
		const entry = entries.get(sourceRef);
		const listener = abortListeners.get(sourceRef);
		if (entry && listener)
			entry.requestContext.signal.removeEventListener("abort", listener);
		entries.delete(sourceRef);
		abortListeners.delete(sourceRef);
	};
	const expire = (entry: RuntimeNativeMetadataRequestRegistryEntryV1) =>
		entry.binding.expiresAt <= now() || entry.requestContext.signal.aborted;
	return {
		register(input) {
			input.requestContext.assertCurrent();
			const binding = RuntimeNativeMetadataBindingResponseV1Schema.parse(
				input.binding,
			);
			if (
				binding.scope.principal.kind !== "user" ||
				binding.scope.principal.id !== input.identity.userId ||
				input.identity.accountStatus !== "active" ||
				binding.readStartedAt !== input.requestContext.readStartedAt ||
				binding.expiresAt !== input.requestContext.expiresAt ||
				expire({ ...input, binding })
			)
				throw new Error("NATIVE_METADATA_REQUEST_UNAVAILABLE");
			for (const [sourceRef, entry] of entries) {
				if (expire(entry)) {
					entry.requestContext.close();
					release(sourceRef);
				}
			}
			if (entries.size >= maximum)
				throw new Error("NATIVE_METADATA_REQUEST_CAPACITY");
			const sourceRef = randomUUID();
			entries.set(sourceRef, { ...input, binding });
			const abort = () => release(sourceRef);
			abortListeners.set(sourceRef, abort);
			input.requestContext.signal.addEventListener("abort", abort, {
				once: true,
			});
			return sourceRef;
		},
		lookup(sourceRef, request) {
			const entry = entries.get(sourceRef);
			if (!entry) return undefined;
			if (expire(entry)) {
				entry.requestContext.close();
				release(sourceRef);
				return undefined;
			}
			try {
				const parsed = NativeMetadataCurrentRequestV1Schema.parse(request);
				if (parsed.phase !== "read_metadata") throw new Error();
				const { phase: _phase, ...requestBinding } = parsed;
				if (
					runtimeNativeMetadataRequestSigningPayloadV1(requestBinding) ===
					runtimeNativeMetadataRequestSigningPayloadV1(entry.binding)
				)
					return entry;
			} catch {
				/* A failed association is never revived. */
			}
			entry.requestContext.close();
			release(sourceRef);
			return undefined;
		},
		release,
		clear() {
			for (const [sourceRef, entry] of entries) {
				entry.requestContext.close();
				release(sourceRef);
			}
		},
	};
}

export type CurrentAuthorization =
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
			const requestContext = entry.requestContext;
			const abort = () => requestContext.close();
			input.signal.addEventListener("abort", abort, { once: true });
			try {
				if (input.signal.aborted) throw new Error();
				const identity = await requestContext.run(() => entry.revalidate());
				const decision = await requestContext.run(() =>
					options.authorize(identity, {
						schemaVersion: 1,
						operation: "conversation.read",
						conversationId: entry.binding.scope.conversationId,
					}),
				);
				requestContext.assertCurrent();
				if (decision.outcome !== "allowed") {
					requestContext.close();
					return {
						outcome:
							decision.outcome === "revoked" ? "denied" : decision.outcome,
					};
				}
				const authority = decision.authority;
				if (
					authority.actorId !== entry.binding.scope.principal.id ||
					authority.agentId !== entry.binding.scope.agentId ||
					authority.channelId !== entry.binding.scope.channelId
				) {
					requestContext.close();
					return { outcome: "denied" };
				}
				requestContext.confirmPolicy(
					authority,
					entry.binding.scope.conversationId,
				);
				await requestContext.run(() => entry.revalidate());
				if (
					options.registry.lookup(input.apiRequestSourceRef, input.request) !==
					entry
				)
					throw new Error();
				return { outcome: "allowed", request: input.request };
			} catch {
				requestContext.close();
				return { outcome: "unavailable" };
			} finally {
				input.signal.removeEventListener("abort", abort);
			}
		},
	};
}
