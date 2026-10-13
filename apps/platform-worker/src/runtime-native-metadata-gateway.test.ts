import {
	type NativeMetadataCurrentResponseV1,
	type PlatformNativeMetadataReadRequestV1,
	PlatformNativeMetadataReadRequestV1Schema,
	type RuntimeNativeMetadataBindingResponseV1,
	type RuntimeNativeMetadataReadResponseV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import {
	createWorkerRuntimeNativeMetadataGatewayAppV1,
	createWorkerRuntimeNativeMetadataGatewayV1,
} from "./runtime-native-metadata-gateway.js";

const request = {
	schemaVersion: 1,
	readId: "read-gateway",
	selector: "commands" as const,
	scope: {
		schemaVersion: 1,
		principal: { kind: "user", id: "user-gateway" },
		agentId: "agent-gateway",
		channelId: "web",
		conversationId: "conversation-gateway",
		executionId: "execution-gateway",
		sessionGeneration: 3,
		authorizationRevision: "authorization-gateway",
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-gateway",
	traceId: "trace-gateway",
	apiRequestSourceRef: "api-request-gateway",
} as const satisfies PlatformNativeMetadataReadRequestV1;

const { apiRequestSourceRef: _source, ...bindingIdentity } = request;
const binding = {
	...bindingIdentity,
	originalHostScopeRef: "host-gateway",
} as const satisfies RuntimeNativeMetadataBindingResponseV1;

const proof = {
	schemaVersion: 1 as const,
	format: "native-metadata-jws" as const,
	token: "worker-proof",
};

const response: RuntimeNativeMetadataReadResponseV1 = {
	...binding,
	projection: {
		selector: "commands",
		revision: "a".repeat(64),
		capabilities: [],
	},
};

function allowed(): NativeMetadataCurrentResponseV1 {
	return {
		outcome: "allowed",
		request: { ...binding, phase: "read_metadata" },
	};
}

function setup(
	patch: Partial<{
		current: NativeMetadataCurrentResponseV1;
		binding: RuntimeNativeMetadataBindingResponseV1 | null;
	}> = {},
) {
	const current = vi.fn(async () => patch.current ?? allowed());
	const resolveBinding = vi.fn(async () =>
		patch.binding === undefined ? binding : patch.binding,
	);
	const resolveTransport = vi.fn(async () => ({
		read: vi.fn(async () => response),
	}));
	const issue = vi.fn(async () => proof);
	const gateway = createWorkerRuntimeNativeMetadataGatewayV1({
		binding: { resolve: resolveBinding },
		current: { check: current },
		proofIssuer: { issue },
		transport: { resolve: resolveTransport },
	});
	return { current, gateway, issue, resolveBinding, resolveTransport };
}

describe("Worker native metadata gateway", () => {
	it("confirms current binding before and after the fixed Runtime transport", async () => {
		const f = setup();
		await expect(
			f.gateway.read(request, new AbortController().signal),
		).resolves.toEqual(response);
		expect(f.resolveBinding).toHaveBeenCalledWith({
			request,
			signal: expect.any(AbortSignal),
		});
		expect(f.issue).toHaveBeenCalledWith({
			request: binding,
			signal: expect.any(AbortSignal),
		});
		expect(f.current).toHaveBeenCalledTimes(2);
		expect(f.current).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				apiRequestSourceRef: request.apiRequestSourceRef,
			}),
		);
		expect(f.resolveTransport).toHaveBeenCalledWith({
			binding,
			signal: expect.any(AbortSignal),
		});
	});

	it.each(["binding unavailable", "current denied"] as const)(
		"fails closed on %s",
		async (failure) => {
			const f =
				failure === "binding unavailable"
					? setup({ binding: null })
					: setup({ current: { outcome: "denied" } });
			await expect(
				f.gateway.read(request, new AbortController().signal),
			).rejects.toThrow("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
			expect(f.issue).not.toHaveBeenCalled();
		},
	);

	it("rejects a binding that crosses the API request", async () => {
		const f = setup({
			binding: {
				...binding,
				scope: { ...binding.scope, executionId: "foreign-execution" },
			},
		});
		await expect(
			f.gateway.read(request, new AbortController().signal),
		).rejects.toThrow("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
		expect(f.issue).not.toHaveBeenCalled();
	});

	it("protects the fetch ingress with its fixed service token", async () => {
		const f = setup();
		const app = createWorkerRuntimeNativeMetadataGatewayAppV1({
			serviceToken: "worker-gateway-token",
			gateway: f.gateway,
		});
		const body = JSON.stringify(
			PlatformNativeMetadataReadRequestV1Schema.parse(request),
		);
		await expect(
			app.fetch(
				new Request(
					"http://worker/internal/platform-worker/v1/native-metadata",
					{
						method: "POST",
						headers: {
							authorization: "Bearer wrong-token",
							"content-type": "application/json",
						},
						body,
					},
				),
			),
		).resolves.toMatchObject({ status: 401 });
		const responseValue = await app.fetch(
			new Request("http://worker/internal/platform-worker/v1/native-metadata", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-gateway-token",
					"content-type": "application/json",
				},
				body,
			}),
		);
		expect(responseValue.status).toBe(200);
	});

	it("rejects an oversized body while streaming it", async () => {
		const f = setup();
		const app = createWorkerRuntimeNativeMetadataGatewayAppV1({
			serviceToken: "worker-gateway-token",
			gateway: f.gateway,
		});
		const responseValue = await app.fetch(
			new Request("http://worker/internal/platform-worker/v1/native-metadata", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-gateway-token",
					"content-type": "application/json",
				},
				body: "x".repeat(1_048_577),
			}),
		);
		expect(responseValue.status).toBe(400);
		expect(f.resolveBinding).not.toHaveBeenCalled();
	});
});
