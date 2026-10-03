import type {
	NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentResponseV1,
	PlatformNativeMetadataReadRequestV1,
} from "@agent-infra/contracts";
import {
	RuntimeNativeMetadataBindingRequestV1Schema,
	RuntimeNativeMetadataReadRequestV1Schema,
	type RuntimeNativeMetadataReadResponseV1,
} from "@agent-infra/contracts/runtime";
import { ConversationRuntimeHostError } from "@agent-infra/platform-core";
import { createWorkerNativeMetadataProofSignerV1 } from "./native-metadata-proof-signer.js";
import { createWorkerNativeMetadataHostClientV1 } from "./runtime-host-client.js";

type Host = ReturnType<typeof createWorkerNativeMetadataHostClientV1>;

export function createPlatformNativeMetadataReadWorkerV1(options: {
	readonly maxActiveReads: number;
	readonly current: (
		apiSourceRef: string,
		request: NativeMetadataCurrentRequestV1,
		signal: AbortSignal,
	) => Promise<NativeMetadataCurrentResponseV1>;
	readonly signProof: ReturnType<typeof createWorkerNativeMetadataProofSignerV1>;
	readonly resolveHost: (
		scope: PlatformNativeMetadataReadRequestV1["scope"],
		signal: AbortSignal,
	) => Promise<{ readonly hostServiceId: string; readonly client: Host }>;
}) {
	const active = new Map<string, { apiSourceRef: string; hostServiceId: string; request: PlatformNativeMetadataReadRequestV1 }>();
	let closed = false;
	function assertActive(request: { readStartedAt: number; expiresAt: number }, signal: AbortSignal) {
		if (closed || signal.aborted || Date.now() < request.readStartedAt || Date.now() >= request.expiresAt)
			throw new ConversationRuntimeHostError("NATIVE_METADATA_UNAVAILABLE", true);
	}
	async function current(request: NativeMetadataCurrentRequestV1, hostServiceId: string, signal: AbortSignal) {
		const entry = active.get(request.readId);
		if (!entry || entry.hostServiceId !== hostServiceId) return { outcome: "denied" as const };
		if (
			entry.request.selector !== request.selector ||
			entry.request.requestId !== request.requestId ||
			entry.request.traceId !== request.traceId ||
			entry.request.readStartedAt !== request.readStartedAt ||
			entry.request.expiresAt !== request.expiresAt ||
			JSON.stringify(entry.request.scope) !== JSON.stringify(request.scope)
		)
			return { outcome: "denied" as const };
		try {
			assertActive(request, signal);
			const result = await options.current(entry.apiSourceRef, request, signal);
			assertActive(request, signal);
			return result;
		} catch {
			return { outcome: "unavailable" as const };
		}
	}
	async function read(request: PlatformNativeMetadataReadRequestV1, apiSourceRef: string, signal: AbortSignal): Promise<RuntimeNativeMetadataReadResponseV1> {
		if (active.size >= options.maxActiveReads) throw new ConversationRuntimeHostError("NATIVE_METADATA_UNAVAILABLE", true);
		assertActive(request, signal);
		const initial = await options.current(apiSourceRef, { ...request, phase: "resolve_original_binding", originalHostScopeRef: null }, signal);
		if (initial.outcome !== "allowed") throw new ConversationRuntimeHostError(initial.outcome === "denied" ? "NATIVE_METADATA_DENIED" : "NATIVE_METADATA_UNAVAILABLE", initial.outcome === "unavailable");
		const host = await options.resolveHost(request.scope, signal);
		const entry = { apiSourceRef, hostServiceId: host.hostServiceId, request };
		active.set(request.readId, entry);
		try {
			const bindingRequest = RuntimeNativeMetadataBindingRequestV1Schema.parse(request);
			const binding = await host.client.resolveOriginalBinding(bindingRequest, signal);
			assertActive(request, signal);
			const current = await options.current(apiSourceRef, { ...request, phase: "read_metadata", originalHostScopeRef: binding.originalHostScopeRef }, signal);
			if (current.outcome !== "allowed") throw new ConversationRuntimeHostError(current.outcome === "denied" ? "NATIVE_METADATA_DENIED" : "NATIVE_METADATA_UNAVAILABLE", current.outcome === "unavailable");
			const readRequest = RuntimeNativeMetadataReadRequestV1Schema.parse({ ...binding, proof: options.signProof({ ...binding, originalHostScopeRef: binding.originalHostScopeRef }) });
			const response = await host.client.readMetadata(readRequest, signal);
			assertActive(request, signal);
			return response;
		} finally {
			active.delete(request.readId);
		}
	}
	return {
		read,
		current,
		close() {
			closed = true;
			active.clear();
		},
	};
}
