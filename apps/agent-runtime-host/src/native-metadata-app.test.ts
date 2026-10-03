import type { RuntimeHost } from "@agent-infra/agent-runtime";
import type {
	RuntimeNativeMetadataBindingRequestV1,
	RuntimeNativeMetadataReadRequestV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeHostApp } from "./app.js";

const route = "/internal/runtime/native-metadata/v1";
const metadataToken = "synthetic-metadata-worker-token";
const runtimeToken = "synthetic-runtime-service-token";

function fixture() {
	const now = Date.now();
	const identity: RuntimeNativeMetadataBindingRequestV1 = {
		schemaVersion: 1,
		readId: "read-original",
		selector: "status",
		scope: {
			schemaVersion: 1,
			principal: { kind: "user", id: "user-a" },
			agentId: "agent-a",
			channelId: "web",
			conversationId: "conversation-a",
			executionId: "execution-a",
			sessionGeneration: 1,
			authorizationRevision: "authorization-a",
		},
		readStartedAt: now,
		expiresAt: now + 30_000,
		requestId: "request-a",
		traceId: "trace-a",
	};
	const binding = { ...identity, originalHostScopeRef: "a".repeat(64) };
	const read: RuntimeNativeMetadataReadRequestV1 = {
		...binding,
		proof: { schemaVersion: 1, format: "native-metadata-jws", token: "a.b.c" },
	};
	const result = {
		...binding,
		projection: {
			selector: "status" as const,
			status: "idle" as const,
			readAt: new Date(now).toISOString(),
		},
	};
	const resolve = vi
		.fn<RuntimeHost["resolveNativeMetadataBindingV1"]>()
		.mockResolvedValue(binding);
	const readMetadata = vi
		.fn<RuntimeHost["readNativeMetadataV1"]>()
		.mockResolvedValue(result);
	const verifyGrant = vi.fn(() => {
		throw new Error("Legacy verification must not authorize metadata");
	});
	const host = {
		resolveNativeMetadataBindingV1: resolve,
		readNativeMetadataV1: readMetadata,
	} as unknown as RuntimeHost;
	const options = {
		host,
		serviceToken: runtimeToken,
		runtimeWorkerId: "business-worker",
		nativeMetadata: {
			workerId: "metadata-worker",
			serviceToken: metadataToken,
		},
		verifyGrant,
	};
	return {
		app: createRuntimeHostApp(options),
		options,
		identity,
		binding,
		read,
		result,
		resolve,
		readMetadata,
		verifyGrant,
	};
}

function request(
	path: string,
	body: unknown,
	token = metadataToken,
	signal?: AbortSignal,
) {
	return new Request(`http://runtime.test${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
		signal,
	});
}

describe("Host metadata HTTP boundary", () => {
	it("keeps metadata transport authorization independent from business and legacy grants", async () => {
		const f = fixture();
		for (const path of ["binding", "read"]) {
			for (const token of [runtimeToken, "wrong-worker-token", ""]) {
				const denied = await f.app.request(
					request(`${route}/${path}`, f.identity, token),
				);
				expect(denied.status).toBe(401);
			}
		}
		const business = await f.app.request(
			request("/internal/runtime/v1/status", {}, metadataToken),
		);
		expect(business.status).toBe(401);
		const disabled = createRuntimeHostApp({
			...f.options,
			nativeMetadata: undefined,
		});
		expect(
			disabled.routes.filter(
				({ method, path }) => method === "POST" && path.startsWith(`${route}/`),
			),
		).toEqual([]);
		expect(
			(await disabled.request(request(`${route}/binding`, f.identity))).status,
		).toBe(401);
		expect(f.resolve).not.toHaveBeenCalled();
		expect(f.readMetadata).not.toHaveBeenCalled();
		expect(f.verifyGrant).not.toHaveBeenCalled();
	});

	it.each(["binding", "read"] as const)(
		"passes only the deployed Worker and unchanged raw signal to %s",
		async (path) => {
			const f = fixture();
			const body = path === "binding" ? f.identity : f.read;
			const raw = request(
				`${route}/${path}`,
				body,
				metadataToken,
				new AbortController().signal,
			);
			const response = await f.app.request(raw);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(
				path === "binding" ? f.binding : f.result,
			);
			const producer = path === "binding" ? f.resolve : f.readMetadata;
			expect(producer).toHaveBeenCalledExactlyOnceWith(
				body,
				"metadata-worker",
				raw.signal,
			);
			expect(producer.mock.calls[0]?.[2]).toBe(raw.signal);
			expect(f.verifyGrant).not.toHaveBeenCalled();
		},
	);

	it.each(["binding", "read"] as const)(
		"rejects invalid %s identity, query and oversized body before producer I/O",
		async (path) => {
			const f = fixture();
			const body = path === "binding" ? f.identity : f.read;
			const invalid: unknown[] = [
				{ ...body, workerId: "caller-worker" },
				{
					...body,
					scope: { ...body.scope, nativePath: "private-path-canary" },
				},
				{ ...body, expiresAt: body.readStartedAt + 30_001 },
				{ ...body, originalHostScopeRef: "private-ref-canary" },
				"private-malformed-json-canary",
				JSON.stringify({ ...body, requestId: "x".repeat(65_537) }),
			];
			if (path === "read") {
				invalid.push({
					...f.read,
					proof: { ...f.read.proof, token: "invalid-proof" },
				});
				const { proof: _proof, ...missingProof } = f.read;
				invalid.push(missingProof);
			}
			for (const value of invalid) {
				const response = await f.app.request(
					request(`${route}/${path}`, value),
				);
				expect(response.status).toBe(400);
				expect(await response.text()).not.toContain("canary");
			}
			const query = await f.app.request(
				request(`${route}/${path}?workerId=caller-worker`, body),
			);
			expect(query.status).toBe(400);
			expect(f.resolve).not.toHaveBeenCalled();
			expect(f.readMetadata).not.toHaveBeenCalled();
		},
	);

	it.each(["before", "during"] as const)(
		"drops results when the original request aborts %s producer I/O",
		async (timing) => {
			for (const path of ["binding", "read"] as const) {
				const f = fixture();
				const controller = new AbortController();
				f.resolve.mockImplementationOnce(async () => {
					controller.abort();
					return f.binding;
				});
				f.readMetadata.mockImplementationOnce(async () => {
					controller.abort();
					return f.result;
				});
				if (timing === "before") controller.abort();
				const response = await f.app.request(
					request(
						`${route}/${path}`,
						path === "binding" ? f.identity : f.read,
						metadataToken,
						controller.signal,
					),
				);
				expect(response.status).toBeGreaterThanOrEqual(400);
				expect(await response.text()).not.toContain(
					f.binding.originalHostScopeRef,
				);
				if (timing === "before") {
					expect(f.resolve).not.toHaveBeenCalled();
					expect(f.readMetadata).not.toHaveBeenCalled();
				}
			}
		},
	);

	it("rejects producer fields outside the strict binding and read response schemas", async () => {
		const f = fixture();
		const invalidBinding = {
			...f.binding,
			nativePath: "private-producer-canary",
		};
		const invalidRead = {
			...f.result,
			projection: {
				...f.result.projection,
				nativePath: "private-producer-canary",
			},
		};
		f.resolve.mockResolvedValue(invalidBinding);
		f.readMetadata.mockResolvedValue(invalidRead);
		for (const path of ["binding", "read"] as const) {
			const response = await f.app.request(
				request(`${route}/${path}`, path === "binding" ? f.identity : f.read),
			);
			expect(response.status).toBe(500);
			expect(await response.text()).not.toContain("private-producer-canary");
		}
	});
});
