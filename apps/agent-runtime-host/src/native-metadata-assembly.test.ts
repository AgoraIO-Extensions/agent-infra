import type { RuntimeHostNativeMetadataReadContextV1 } from "@agent-infra/agent-runtime";
import { RuntimeHostError } from "@agent-infra/agent-runtime";
import type {
	RuntimeNativeMetadataReadRequestV1,
	RuntimeNativeMetadataReadResponseV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeNativeMetadataReadV1,
	type RuntimeNativeMetadataReadAssemblyV1,
} from "./native-metadata-assembly.js";

const request = {
	schemaVersion: 1,
	readId: "read-assembly",
	selector: "status" as const,
	scope: {
		schemaVersion: 1,
		principal: { kind: "user", id: "user-assembly" },
		agentId: "agent-assembly",
		channelId: "web",
		conversationId: "conversation-assembly",
		executionId: "execution-assembly",
		sessionGeneration: 1,
		authorizationRevision: "authorization-assembly",
	},
	readStartedAt: 1_000,
	expiresAt: 10_000,
	requestId: "request-assembly",
	traceId: "trace-assembly",
	originalHostScopeRef: "host-scope-assembly",
	proof: { schemaVersion: 1, format: "native-metadata-jws", token: "proof" },
} as const satisfies RuntimeNativeMetadataReadRequestV1;

const response: RuntimeNativeMetadataReadResponseV1 = {
	schemaVersion: request.schemaVersion,
	readId: request.readId,
	selector: request.selector,
	scope: request.scope,
	readStartedAt: request.readStartedAt,
	expiresAt: request.expiresAt,
	requestId: request.requestId,
	traceId: request.traceId,
	originalHostScopeRef: request.originalHostScopeRef,
	projection: {
		selector: "status",
		status: "idle",
		readAt: "2026-10-13T00:00:00.000Z",
	},
};

function context(signal: AbortSignal): RuntimeHostNativeMetadataReadContextV1 {
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
		nativeSessionRef: "native-session-assembly",
		signal,
		expiresAt: request.expiresAt,
		scope: request.scope,
		originalHostScopeRef: request.originalHostScopeRef,
		assertCurrent: () => authority,
		revalidate: async () => authority,
		verifyProof: async () => undefined,
	};
}

describe("Runtime native metadata Host assembly", () => {
	it("binds the request-local context to RuntimeHost and preserves the route signal", async () => {
		const signal = new AbortController().signal;
		const readNativeMetadataV1 = vi.fn().mockResolvedValue(response);
		const host = { readNativeMetadataV1 };
		const assembly: RuntimeNativeMetadataReadAssemblyV1 = {
			resolveContext: vi.fn(async () => context(new AbortController().signal)),
		};
		const read = createRuntimeNativeMetadataReadV1(host, assembly);

		await expect(read(request, signal)).resolves.toEqual(response);
		expect(assembly.resolveContext).toHaveBeenCalledWith({
			request,
			signal,
		});
		expect(readNativeMetadataV1).toHaveBeenCalledWith(
			request,
			expect.objectContaining({ signal }),
		);
	});

	it.each(["missing context", "resolver failure"] as const)(
		"fails closed on %s",
		async (failure) => {
			const host = {
				readNativeMetadataV1: vi.fn(),
			};
			const assembly: RuntimeNativeMetadataReadAssemblyV1 = {
				resolveContext:
					failure === "missing context"
						? vi.fn(async () => null)
						: vi.fn(async () => {
								throw new Error("worker unavailable");
							}),
			};
			const read = createRuntimeNativeMetadataReadV1(host, assembly);

			await expect(
				read(request, new AbortController().signal),
			).rejects.toMatchObject({
				code: "RUNTIME_NATIVE_METADATA_UNAVAILABLE",
				httpStatus: 503,
			});
			expect(host.readNativeMetadataV1).not.toHaveBeenCalled();
		},
	);

	it("preserves an authorization denial from RuntimeHost", async () => {
		const denial = new RuntimeHostError("RUNTIME_GRANT_INVALID", "denied", 403);
		const host = {
			readNativeMetadataV1: vi.fn().mockRejectedValue(denial),
		};
		const assembly: RuntimeNativeMetadataReadAssemblyV1 = {
			resolveContext: vi.fn(async ({ signal }) => context(signal)),
		};

		await expect(
			createRuntimeNativeMetadataReadV1(host, assembly)(
				request,
				new AbortController().signal,
			),
		).rejects.toBe(denial);
	});
});
