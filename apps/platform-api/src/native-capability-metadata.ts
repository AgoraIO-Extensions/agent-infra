import type { NativeMetadataProjectionV1 } from "@agent-infra/contracts/runtime";
import type {
	NativeCapabilityAdmissionCapabilityV1,
	NativeCapabilityAdmissionRequestV1,
	NativeCapabilityAdmissionScopeV1,
	NativeCapabilityMetadataProjectionV1,
	NativeCapabilityMetadataRevalidationPortV1,
	NativeCapabilityMetadataV1,
} from "@agent-infra/platform-core";
import {
	nativeCapabilityAdmissionRequestDigestV1,
	parseNativeCapabilityMetadataProjectionV1,
} from "@agent-infra/platform-core";
import type {
	ConversationQueryScopeV1,
	NativeCapabilityCurrentScopeResponseV1,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import type { IdentityContext } from "./http/identity.js";
import type { RuntimeNativeMetadataPublicReaderV1 } from "./http/native-metadata-routes.js";

const maximumCacheEntries = 128;
const maximumCacheTtlMs = 30_000;

type Selector = "commands" | "skills";

type CacheEntry = {
	readonly request: NativeCapabilityAdmissionRequestV1;
	readonly capability: NativeCapabilityAdmissionCapabilityV1;
	readonly scope: NativeCapabilityAdmissionScopeV1;
	readonly expiresAt: number;
};

function sameRequest(
	left: NativeCapabilityAdmissionRequestV1,
	right: NativeCapabilityAdmissionRequestV1,
) {
	return (
		nativeCapabilityAdmissionRequestDigestV1(left) ===
		nativeCapabilityAdmissionRequestDigestV1(right)
	);
}

function sameCapability(
	left: NativeCapabilityAdmissionCapabilityV1,
	right: NativeCapabilityAdmissionCapabilityV1,
) {
	return (
		left.id === right.id &&
		left.kind === right.kind &&
		left.name === right.name &&
		left.description === right.description &&
		left.source.name === right.source.name &&
		left.source.version === right.source.version &&
		left.availability === right.availability &&
		left.directoryRevision === right.directoryRevision
	);
}

function projectionSelector(selector: Selector): "commands" | "skills" {
	return selector;
}

function coreProjection(
	projection: NativeMetadataProjectionV1,
): NativeCapabilityMetadataProjectionV1 | undefined {
	if (projection.selector === "status") return undefined;
	const capabilities: NativeCapabilityMetadataV1[] =
		projection.capabilities.map((capability) => ({
			id: capability.id,
			kind: capability.kind,
			name: capability.name,
			description: capability.description,
			source: capability.source,
			availability: capability.availability,
		}));
	return parseNativeCapabilityMetadataProjectionV1({
		selector: projectionSelector(projection.selector),
		revision: projection.revision,
		capabilities,
	});
}

function scopeForQuery(authority: {
	readonly actorId: string;
	readonly channelId: string;
}): ConversationQueryScopeV1 {
	return {
		actorId: authority.actorId,
		channelId: authority.channelId,
		principal: { kind: "user", id: authority.actorId },
	};
}

function isCurrentScope(
	scope: NativeCapabilityCurrentScopeResponseV1,
	authority: {
		readonly actorId: string;
		readonly agentId: string;
		readonly channelId: string;
		readonly authorizationRevision: string;
	},
	request: NativeCapabilityAdmissionRequestV1,
	sessionGeneration: number,
) {
	return (
		scope.agentId === authority.agentId &&
		scope.actorId === authority.actorId &&
		scope.channelId === authority.channelId &&
		scope.conversationId === request.conversationId &&
		scope.sessionGeneration === sessionGeneration &&
		scope.authorizationRevision === authority.authorizationRevision &&
		scope.currentHostScopeRef.length > 0 &&
		scope.executionId.length > 0
	);
}

/**
 * Production API adapter for native capability admission.  Store resolves the
 * current execution fence; the already authenticated Worker reader supplies
 * commands/skills; this adapter owns projection and bounded cache checks.
 */
export function createNativeCapabilityMetadataRevalidationV1(options: {
	readonly query: Pick<
		PostgresConversationQueryV1,
		"readNativeCapabilityCurrentScopeV1"
	>;
	readonly reader: RuntimeNativeMetadataPublicReaderV1;
	readonly identity: IdentityContext;
	readonly now?: () => number;
	readonly cacheTtlMs?: number;
	readonly maximumEntries?: number;
}): NativeCapabilityMetadataRevalidationPortV1 {
	if (
		typeof options.query?.readNativeCapabilityCurrentScopeV1 !== "function" ||
		typeof options.reader?.read !== "function" ||
		typeof options.identity?.userId !== "string" ||
		options.identity.accountStatus !== "active"
	)
		throw new TypeError("Native capability metadata options are invalid");
	const now = options.now ?? Date.now;
	const cacheTtlMs = options.cacheTtlMs ?? 5_000;
	const maximumEntries = options.maximumEntries ?? maximumCacheEntries;
	if (
		!Number.isSafeInteger(cacheTtlMs) ||
		cacheTtlMs < 1 ||
		cacheTtlMs > maximumCacheTtlMs ||
		!Number.isSafeInteger(maximumEntries) ||
		maximumEntries < 1 ||
		maximumEntries > maximumCacheEntries
	)
		throw new TypeError("Native capability metadata cache options are invalid");
	const cache = new Map<string, CacheEntry>();
	const cacheKey = (request: NativeCapabilityAdmissionRequestV1) =>
		nativeCapabilityAdmissionRequestDigestV1(request);

	const prune = (timestamp: number) => {
		for (const [key, entry] of cache) {
			if (entry.expiresAt <= timestamp) cache.delete(key);
		}
		while (cache.size > maximumEntries) {
			const oldest = cache.keys().next().value;
			if (typeof oldest !== "string") break;
			cache.delete(oldest);
		}
	};

	return {
		async revalidate({ request, authority, sessionGeneration }) {
			try {
				if (
					authority.channelId !== "web" ||
					authority.actorId.length === 0 ||
					authority.agentId.length === 0 ||
					authority.authorizationRevision.length === 0
				)
					return { outcome: "unavailable" };
				if (
					options.identity.userId !== authority.actorId ||
					options.identity.authorizationRevision !==
						authority.authorizationRevision
				)
					return { outcome: "unavailable" };
				const current = await options.query.readNativeCapabilityCurrentScopeV1({
					scope: scopeForQuery(authority),
					agentId: authority.agentId,
					conversationId: request.conversationId,
				});
				if (!current) return { outcome: "unavailable" };
				if (!isCurrentScope(current, authority, request, sessionGeneration))
					return { outcome: "stale" };
				const [commands, skills] = await Promise.all([
					options.reader.read(
						options.identity,
						request.conversationId,
						current.executionId,
						"commands",
					),
					options.reader.read(
						options.identity,
						request.conversationId,
						current.executionId,
						"skills",
					),
				]);
				if (!commands || !skills) return { outcome: "unavailable" };
				const commandProjection = coreProjection(commands);
				const skillProjection = coreProjection(skills);
				if (!commandProjection || !skillProjection)
					return { outcome: "unavailable" };
				const projections: NativeCapabilityMetadataProjectionV1[] = [
					commandProjection,
					skillProjection,
				];
				const projectedRevisionMismatch = projections.some(
					(projection) => projection.revision !== request.directoryRevision,
				);
				if (projectedRevisionMismatch) return { outcome: "stale" };
				for (const projection of projections) {
					const selected = projection.capabilities.find(
						(capability) => capability.id === request.capabilityId,
					);
					if (!selected) continue;
					const capability = {
						...selected,
						directoryRevision: projection.revision,
					};
					const scope: NativeCapabilityAdmissionScopeV1 = {
						agentId: current.agentId,
						actorId: current.actorId,
						channelId: current.channelId,
						conversationId: current.conversationId,
						sessionGeneration: current.sessionGeneration,
						authorizationRevision: current.authorizationRevision,
						hostScopeRef: current.currentHostScopeRef,
					};
					const timestamp = now();
					if (!Number.isSafeInteger(timestamp) || timestamp < 0)
						return { outcome: "unavailable" };
					prune(timestamp);
					cache.delete(cacheKey(request));
					cache.set(cacheKey(request), {
						request,
						capability,
						scope,
						expiresAt: timestamp + cacheTtlMs,
					});
					prune(timestamp);
					return { outcome: "allowed", capability, scope };
				}
				return { outcome: "unknown" };
			} catch {
				return { outcome: "unavailable" };
			}
		},
		isCurrent({ request, capability, scope }) {
			const timestamp = now();
			if (!Number.isSafeInteger(timestamp) || timestamp < 0) return false;
			prune(timestamp);
			const entry = cache.get(cacheKey(request));
			return Boolean(
				entry &&
					entry.expiresAt > timestamp &&
					entry.scope.agentId === scope.agentId &&
					entry.scope.actorId === scope.actorId &&
					entry.scope.channelId === scope.channelId &&
					entry.scope.conversationId === scope.conversationId &&
					entry.scope.sessionGeneration === scope.sessionGeneration &&
					entry.scope.authorizationRevision === scope.authorizationRevision &&
					entry.scope.hostScopeRef === scope.hostScopeRef &&
					entry.scope.authorizationRevision ===
						options.identity.authorizationRevision &&
					sameRequest(entry.request, request) &&
					sameCapability(entry.capability, capability),
			);
		},
	};
}
