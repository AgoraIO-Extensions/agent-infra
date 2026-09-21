import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import { RuntimeCapabilitiesResponseV1Schema } from "@agent-infra/contracts/runtime";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type { V1Service } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import {
	runtimeGrantFixture,
	verificationForRuntimeGrant,
} from "../../../packages/agent-runtime/src/grant-fixture.test-support.js";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import { createWorkloadRuntimeV1 } from "./workload-runtime.js";
import { fixture } from "./workload-runtime-split.fixture.js";

describe("assembled Workload Runtime contracts", () => {
	it("retains capabilities only for the exact healthy promotion attempt", async () => {
		const fetch = vi.fn(async () => new Response("ok"));
		const f = fixture({ fetch });
		await f.tick(8);
		const ready = f.state;
		if (ready?.phase !== "ready") throw new Error();
		const runtime = createWorkloadRuntimeV1(f.options);
		for (let i = 0; i < 3; i++) {
			expect(await runtime.observe(ready)).toBe("healthy");
			await expect(runtime.capabilities(ready)).rejects.toThrow(
				"Runtime capabilities are unavailable",
			);
		}
		const promoting = { ...ready, phase: "promoting" as const };
		await runtime.closeRoute(promoting);
		expect(await runtime.observe(promoting)).toBe("healthy");
		await expect(runtime.capabilities({ ...promoting })).rejects.toThrow(
			"Runtime capabilities are unavailable",
		);
		await expect(runtime.capabilities(promoting)).resolves.toEqual(
			ready.capabilities,
		);
		await expect(runtime.capabilities(promoting)).rejects.toThrow(
			"Runtime capabilities are unavailable",
		);
		expect(await runtime.observe(promoting)).toBe("healthy");
		fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
		expect(await runtime.observe(promoting)).toBe("unhealthy");
		await expect(runtime.capabilities(promoting)).rejects.toThrow(
			"Runtime capabilities are unavailable",
		);
	});

	it.each([
		new Error("network unavailable"),
		new DOMException("probe timed out", "TimeoutError"),
	])("closes a ready route when its health probe throws: %s", async (error) => {
		const fetcher = vi.fn(async () => new Response("ok"));
		const f = fixture({ fetch: fetcher });
		await f.tick(8);
		const ready = f.state;
		if (ready?.phase !== "ready") throw new Error();
		const serviceName = validateAgentWorkloadDesiredV1(
			ready.candidate.deployment,
		).service.name;
		fetcher.mockRejectedValueOnce(error);

		await f.tick(1);

		expect(f.state?.phase).toBe("observing");
		expect(
			(await f.client.read<V1Service>("Service", serviceName))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe("closed");
	});

	it("keeps a core-compatible candidate available when optional capability probing has no valid result", async () => {
		const f = fixture({
			probeRuntime: async () => ({
				core: "passed",
				capabilities: { attachments: "unavailable" },
			}),
		});
		await f.tick(8);
		expect(f.state?.phase).toBe("ready");
		expect(Object.values(f.state?.capabilities ?? {})).toEqual([
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it("uses RuntimeHost Fake HTTP capabilities and persists only the declared intersection across Worker restarts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "workload-runtime-"));
		try {
			const host = await RuntimeHost.open({
				store: await FileRuntimeStore.open(join(directory, "host.json")),
				driver: await FakeRuntimeDriver.open(join(directory, "driver.json")),
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			});
			const app = createRuntimeHostApp({
				host,
				serviceToken: "synthetic-service-proof",
				verifyGrant: verificationForRuntimeGrant,
			});
			const f = fixture({
				fetch: (async (url, init) =>
					app.request(String(url), init)) as typeof fetch,
				async probeRuntime({ agentId, workloadRevision, baseUrl }) {
					const binding = {
						agentId,
						actorId: "worker-a",
						channelId: "web",
						conversationId: "probe",
						executionId: `probe-${workloadRevision}`,
						turnId: "probe",
						sessionGeneration: 1,
						traceId: "trace-a",
					};
					const response = await app.request(
						`${baseUrl}/internal/runtime/v1/capabilities`,
						{
							method: "POST",
							headers: {
								authorization: "Bearer synthetic-service-proof",
								"content-type": "application/json",
							},
							body: JSON.stringify({
								schemaVersion: 1,
								...binding,
								requestId: "probe-a",
								deliveryFence: 1,
								grant: runtimeGrantFixture(binding, ["capabilities.read"]),
							}),
						},
					);
					expect(response.status).toBe(200);
					return {
						core: "passed",
						capabilities: RuntimeCapabilitiesResponseV1Schema.parse(
							await response.json(),
						).capabilities,
					};
				},
			});
			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			expect(f.state?.capabilities).toMatchObject({
				modelSelection: true,
				attachments: true,
				connection: false,
				resultFiles: false,
			});
			expect(
				[...f.resources.values()].filter(
					(resource) => resource.kind === "Ingress",
				),
			).toHaveLength(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("closes and cleans a candidate whose Runtime core probe fails", async () => {
		const f = fixture({
			probeRuntime: async () => ({ core: "failed", capabilities: {} }),
		});
		await f.tick(10);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
	});

	it("removes delayed resource writes even after creation failure was persisted", async () => {
		const f = fixture({
			probeRuntime: async () => ({ core: "failed", capabilities: {} }),
		});
		await f.tick(4);
		const remnants = new Map(f.resources);
		await f.tick(6);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
		for (const [key, object] of remnants) f.resources.set(key, object);
		await f.tick(1);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
	});

	it("cleans the same UID after an uncommitted generation change", async () => {
		const f = fixture({
			probeRuntime: async () => ({ core: "failed", capabilities: {} }),
		});
		await f.tick(5);
		expect(f.state?.phase).toBe("cleaning");
		for (const [key, object] of f.resources) {
			if (object.kind === "StatefulSet" && object.metadata)
				f.resources.set(key, {
					...object,
					metadata: { ...object.metadata, generation: 2 },
				});
		}
		await f.tick(1);
		expect(f.state?.phase).toBe("failed");
		expect(f.resources.size).toBe(0);
	});

	it("does not clean a replacement UID or a newer resource revision", async () => {
		for (const metadata of [
			{ uid: "replacement" },
			{ labels: { "agent-infra.agora.io/revision": "2" } },
		]) {
			const f = fixture({
				probeRuntime: async () => ({ core: "failed", capabilities: {} }),
			});
			await f.tick(5);
			for (const [key, object] of f.resources) {
				if (object.kind === "StatefulSet" && object.metadata)
					f.resources.set(key, {
						...object,
						metadata: {
							...object.metadata,
							...metadata,
							labels: { ...object.metadata.labels, ...metadata.labels },
						},
					});
			}
			await f.tick(1);
			expect(f.state?.phase).toBe("cleaning");
			expect(
				[...f.resources.values()].some(
					(object) => object.kind === "StatefulSet",
				),
			).toBe(true);
		}
	});

	it("uses a fixed origin and disables redirects for image-declared health paths", async () => {
		const fetcher = vi.fn(async () => new Response("", { status: 503 }));
		const probe = vi.fn(async () => ({
			core: "passed" as const,
			capabilities: {},
		}));
		const f = fixture({ fetch: fetcher, probeRuntime: probe });
		await f.tick(5);
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringMatching(
				/^http:\/\/agent-[a-f0-9]+-probe\.workload-test\.svc:8080\/healthz$/,
			),
			expect.objectContaining({
				redirect: "error",
				signal: expect.any(AbortSignal),
			}),
		);
		expect(probe).not.toHaveBeenCalled();
		expect(f.state?.phase).toBe("cleaning");
	});
});
