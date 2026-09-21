import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { V1Service, V1StatefulSet } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { createProductionConversationRuntimeResolverV2 } from "./conversation-deployment.js";
import {
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import { fixture } from "./workload-runtime-split.fixture.js";

describe("assembled Workload Runtime contracts", () => {
	it("keeps legacy lifecycle readiness without inventing verified execution capacity", async () => {
		const f = fixture({ executionCapacityProfiles: [] });
		await f.tick(8);
		expect(f.state?.phase).toBe("ready");
		expect(f.state?.verified).not.toHaveProperty("executionCapacity");
	});

	it("resolves trusted Conversation routes through live Workload observation and rejects changed resources", async () => {
		const keys = generateKeyPairSync("ed25519");
		const signing = {
			workerId: "transport-a",
			issuer: "platform",
			keyId: "key-a",
			privateKey: keys.privateKey,
		};
		const f = fixture({
			policy: {
				...workloadTestPolicy,
				runtimeAuth: {
					workerId: signing.workerId,
					grantKeyId: signing.keyId,
					grantIssuer: signing.issuer,
					grantPublicKey: keys.publicKey
						.export({ type: "spki", format: "pem" })
						.toString(),
					serviceTokenSecret: { name: "runtime-transport", key: "token" },
				},
			},
		});
		await f.tick(8);
		assert(f.state?.phase === "ready");
		const resolve = createProductionConversationRuntimeResolverV2({
			workload: f.options,
			signing,
			serviceToken: "synthetic-transport-token",
		});
		const input = {
			agentId: "agent-a",
			signal: new AbortController().signal,
			workload: f.state,
			purpose: "business" as const,
			command: "turn.submit" as const,
		};
		const before = structuredClone(f.resources);
		const service = workloadResourceNameV1("agent-a");
		expect(await resolve(input)).toEqual({
			baseUrl: `http://${service}.${f.options.policy.namespace}.svc:8080`,
			workerId: "transport-a",
			serviceToken: "synthetic-transport-token",
		});
		expect(await resolve({ ...input, purpose: "control" })).toMatchObject({
			baseUrl: `http://${service}-probe.${f.options.policy.namespace}.svc:8080`,
		});
		expect(f.resources).toEqual(before);
		expect(f.state.verified?.executionCapacity).toEqual(
			f.options.executionCapacityProfiles?.[0],
		);
		const withdrawn = createProductionConversationRuntimeResolverV2({
			workload: { ...f.options, executionCapacityProfiles: [] },
			signing,
			serviceToken: "synthetic-transport-token",
		});
		await expect(withdrawn(input)).rejects.toMatchObject({
			code: "RUNTIME_WORKLOAD_UNAVAILABLE",
		});
		await expect(
			withdrawn({ ...input, command: "session.status" }),
		).resolves.toBeDefined();
		await expect(
			withdrawn({ ...input, command: "turn.supplement" }),
		).resolves.toBeDefined();
		await expect(
			withdrawn({ ...input, purpose: "control" }),
		).resolves.toMatchObject({
			baseUrl: `http://${service}-probe.${f.options.policy.namespace}.svc:8080`,
		});
		await expect(
			resolve({ ...input, agentId: "other-agent" }),
		).rejects.toMatchObject({ code: "RUNTIME_WORKLOAD_UNAVAILABLE" });
		await expect(
			resolve({ ...input, workload: { ...f.state, phase: "observing" } }),
		).rejects.toMatchObject({ code: "RUNTIME_WORKLOAD_UNAVAILABLE" });
		const actual = await f.client.read<V1StatefulSet>("StatefulSet", service);
		assert(actual?.metadata);
		f.resources.set(`StatefulSet/${service}`, {
			...actual,
			metadata: { ...actual.metadata, uid: "replacement-workload" },
		});
		await expect(resolve(input)).rejects.toMatchObject({
			code: "RUNTIME_WORKLOAD_UNAVAILABLE",
		});
		await expect(
			resolve({ ...input, purpose: "control" }),
		).rejects.toMatchObject({ code: "RUNTIME_WORKLOAD_UNAVAILABLE" });
		f.resources.set(`StatefulSet/${service}`, actual);
		const liveService = await f.client.read<V1Service>("Service", service);
		assert(liveService?.spec);
		f.resources.set(`Service/${service}`, {
			...liveService,
			spec: {
				...liveService.spec,
				type: "ExternalName",
				externalName: "foreign.invalid",
			},
		} as V1Service);
		await expect(resolve(input)).rejects.toMatchObject({
			code: "RUNTIME_WORKLOAD_UNAVAILABLE",
		});
		expect(() =>
			createProductionConversationRuntimeResolverV2({
				workload: f.options,
				signing: {
					...signing,
					privateKey: generateKeyPairSync("ed25519").privateKey,
				},
				serviceToken: "synthetic-transport-token",
			}),
		).toThrow("Conversation Runtime deployment authorization is invalid");
	});

	it("keeps retryable registry admission failures in preflight without Kubernetes mutations", async () => {
		const f = fixture({
			registry: {
				async admit(request) {
					return {
						schemaVersion: 1,
						status: "rejected",
						requestId: request.requestId,
						traceId: request.traceId,
						error: {
							schemaVersion: 1,
							code: "IMAGE_REGISTRY_UNAVAILABLE",
							message: "Image registry is unavailable",
							retryable: true,
							traceId: request.traceId,
						},
					};
				},
			},
		});
		await f.tick(2);
		expect(f.state).toMatchObject({ phase: "preflight", attempts: 1 });
		expect(f.state?.candidate.deployment).toBeNull();
		expect(f.resources.size).toBe(0);
	});

	it("bounds registry admission and ignores a successful result after the deadline", async () => {
		vi.useFakeTimers();
		const gate = Promise.withResolvers<void>();
		let admissionSignal: AbortSignal | undefined;
		const admitted = workloadRegistryFixture({
			schemaVersion: 1,
			interactionMode: "platform-adapter",
			protocol: "acp",
			service: { port: 8080 },
			health: { path: "/healthz" },
		});
		const admit = vi.fn(
			async (
				request: Parameters<typeof admitted.admit>[0],
				options?: { readonly signal?: AbortSignal },
			) => {
				admissionSignal = options?.signal;
				await gate.promise;
				return admitted.admit(request);
			},
		);
		const f = fixture({ registry: { admit } });
		try {
			await f.tick(1);
			const preflight = f.tick(1);
			await Promise.resolve();
			expect(admit).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(59_999);
			expect(f.state).toMatchObject({ phase: "preflight", attempts: 0 });
			expect(f.resources.size).toBe(0);
			expect(admissionSignal?.aborted).toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			await preflight;
			expect(admissionSignal?.aborted).toBe(true);
			expect(f.state).toMatchObject({ phase: "preflight", attempts: 1 });
			expect(f.state?.candidate.deployment).toBeNull();
			expect(f.resources.size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);

			gate.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(f.state).toMatchObject({ phase: "preflight", attempts: 1 });
			expect(f.state?.candidate.deployment).toBeNull();
			expect(f.resources.size).toBe(0);
		} finally {
			gate.resolve();
			vi.useRealTimers();
		}
	});

	it.each(["resolves", "rejects"] as const)(
		"clears the admission deadline when the registry %s first",
		async (outcome) => {
			vi.useFakeTimers();
			const admitted = workloadRegistryFixture({
				schemaVersion: 1,
				interactionMode: "platform-adapter",
				protocol: "acp",
				service: { port: 8080 },
				health: { path: "/healthz" },
			});
			const f = fixture({
				registry: {
					async admit(request) {
						if (outcome === "rejects")
							throw new Error("Registry request failed");
						return admitted.admit(request);
					},
				},
			});
			try {
				await f.tick(2);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);
});
