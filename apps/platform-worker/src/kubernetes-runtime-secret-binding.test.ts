import type {
	KubernetesObject,
	V1Secret,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

describe("GA Kubernetes Workload adapter", () => {
	it("rejects a Secret replacement that races the StatefulSet UID binding", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const ref = {
			schemaVersion: 1 as const,
			agentId: desired.agentId,
			ownerType: "agent-owner" as const,
			ownerId: "owner-a",
			secretId: "secret-a",
			secretVersion: 1,
			configRevision: 1,
			algorithmVersion: "aes-256-gcm:v1" as const,
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
			wrappingKeyVersion: "key-a",
			name: `${desired.service.name}-secret-1`,
		};
		desired.secretRefs = [ref];
		let swapBeforeStatefulSetReplace = false;
		const client: WorkerKubernetesClientV1 = {
			...f.client,
			async replace<T extends KubernetesObject>(object: T): Promise<T> {
				if (swapBeforeStatefulSetReplace && object.kind === "StatefulSet") {
					swapBeforeStatefulSetReplace = false;
					const secret = await f.client.read<V1Secret>("Secret", ref.name);
					if (!secret) throw new Error();
					f.resources.set(`Secret/${ref.name}`, {
						...secret,
						metadata: { ...secret.metadata, uid: "replacement-secret-uid" },
						data: { API_KEY: Buffer.from([9]).toString("base64") },
					} as V1Secret);
				}
				return f.client.replace(object);
			},
		};
		const adapter = createKubernetesRuntimeAdapterV1({
			client,
			policy: workloadTestPolicy,
			probe: async () => true,
		});
		const secretUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		swapBeforeStatefulSetReplace = true;
		await adapter.bindSecretFence(desired, identity, ref.name, 7, secretUid);
		expect(
			await adapter.observeSecretFence(desired, identity, ref.name, 7),
		).toBe(false);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});
	it("preserves an active Secret fence across rollout but rejects a terminating Secret", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const ref = {
			schemaVersion: 1 as const,
			agentId: desired.agentId,
			ownerType: "agent-owner" as const,
			ownerId: "owner-a",
			secretId: "secret-a",
			secretVersion: 1,
			configRevision: 1,
			algorithmVersion: "aes-256-gcm:v1" as const,
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
			wrappingKeyVersion: "key-a",
			name: `${desired.service.name}-secret-1`,
		};
		desired.secretRefs = [ref];
		const adapter = f.adapter();
		const secretUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.bindSecretFence(desired, identity, ref.name, 7, secretUid);
		const activationFence = {
			schemaVersion: 1 as const,
			agentId: ref.agentId,
			secretId: ref.secretId,
			secretVersion: ref.secretVersion,
			configRevision: ref.configRevision,
			kubernetesSecretName: ref.name,
			workloadUid: identity.uid,
			workloadGeneration: identity.generation,
			fence: 7,
		};
		const upgraded = workloadDesiredFixture(2);
		upgraded.secretRefs = [ref];
		upgraded.expectedWorkload = {
			state: "present",
			workloadUid: identity.uid,
			workloadGeneration: identity.generation,
		};
		let upgradedIdentity = await adapter.apply(upgraded);
		for (
			let attempt = 0;
			upgradedIdentity === "pending" && attempt < 3;
			attempt++
		)
			upgradedIdentity = await adapter.apply(upgraded);
		expect(upgradedIdentity).toMatchObject({
			uid: identity.uid,
			generation: expect.any(Number),
		});
		if (!upgradedIdentity || upgradedIdentity === "pending") throw new Error();
		const boundWorkload = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			upgraded.service.name,
		);
		if (!boundWorkload) throw new Error();
		const uidKey = Object.keys(boundWorkload.metadata?.annotations ?? {}).find(
			(key) => key.startsWith("agent-infra.agora.io/secret-uid-"),
		);
		expect(uidKey).toBeDefined();
		if (!uidKey) throw new Error();
		expect(boundWorkload.metadata?.annotations?.[uidKey]).toBe(secretUid);
		expect(await adapter.observe(upgraded, upgradedIdentity)).toBe("healthy");
		const annotationsWithoutUid = {
			...boundWorkload.metadata?.annotations,
		};
		delete annotationsWithoutUid[uidKey];
		f.resources.set(`StatefulSet/${upgraded.service.name}`, {
			...boundWorkload,
			metadata: {
				...boundWorkload.metadata,
				annotations: annotationsWithoutUid,
			},
		} as V1StatefulSet);
		expect(await adapter.observe(upgraded, upgradedIdentity)).toBe("drifted");
		expect(
			await adapter.observeActiveImmutableSecret(
				upgraded,
				ref,
				activationFence,
			),
		).toBe(false);
		f.resources.set(`StatefulSet/${upgraded.service.name}`, boundWorkload);
		expect(
			await adapter.observeActiveImmutableSecret(
				upgraded,
				ref,
				activationFence,
			),
		).toBe(true);
		const secret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!secret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			metadata: { ...secret.metadata, uid: "replacement-secret-uid" },
			data: { API_KEY: Buffer.from([9]).toString("base64") },
		} as V1Secret);
		expect(await adapter.observe(upgraded, upgradedIdentity)).toBe("drifted");
		expect(
			await adapter.observeActiveImmutableSecret(
				upgraded,
				ref,
				activationFence,
			),
		).toBe(false);
		expect(
			await adapter.removeImmutableSecret(upgraded, ref, activationFence),
		).toBe(false);
		f.resources.set(`Secret/${ref.name}`, secret);
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			metadata: {
				...secret.metadata,
				deletionTimestamp: new Date("2026-09-09T00:00:00Z"),
			},
		} as V1Secret);
		expect(
			await adapter.observeActiveImmutableSecret(
				upgraded,
				ref,
				activationFence,
			),
		).toBe(false);
	});
	it.each([
		"missing-both",
		"empty-uid",
		"zero",
		"noncanonical",
		"unsafe-integer",
		"wrong-uid",
	] as const)(
		"requires every Secret binding before readiness or promotion: %s",
		async (mutation) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			desired.secretRefs = [1, 2].map((index) => ({
				schemaVersion: 1,
				agentId: desired.agentId,
				ownerType: "agent-owner",
				ownerId: "owner-a",
				secretId: `secret-${index}`,
				secretVersion: 1,
				configRevision: 1,
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion: "key-a",
				name: `${desired.service.name}-secret-${index}`,
			}));
			const uids = await Promise.all(
				desired.secretRefs.map((ref) =>
					adapter.applyImmutableSecret(
						desired,
						ref.name,
						ref.secretId.replace("-", "_"),
						new Uint8Array([1]),
					),
				),
			);
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			expect(
				await adapter.observe(desired, identity, "closed", "activation"),
			).toBe("healthy");
			for (const [index, ref] of desired.secretRefs.entries()) {
				const uid = uids[index];
				if (!uid) throw new Error();
				await adapter.bindSecretFence(desired, identity, ref.name, 7, uid);
				// Initial activation observes one bound Secret while others remain unbound.
				expect(
					await adapter.observeSecretFence(desired, identity, ref.name, 7),
				).toBe(true);
			}
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			const ref = desired.secretRefs[1];
			if (!workload?.metadata?.annotations || !ref) throw new Error();
			const annotations = { ...workload.metadata.annotations };
			const uidKey = Object.keys(annotations).find(
				(key) =>
					key.startsWith("agent-infra.agora.io/secret-uid-") &&
					annotations[key] === uids[1],
			);
			if (!uidKey) throw new Error();
			const fenceKey = uidKey.replace("/secret-uid-", "/secret-");
			if (mutation === "missing-both") {
				delete annotations[uidKey];
				delete annotations[fenceKey];
				const secret = await f.client.read<V1Secret>("Secret", ref.name);
				if (!secret) throw new Error();
				f.resources.set(`Secret/${ref.name}`, {
					...secret,
					metadata: { ...secret.metadata, uid: "unverified-replacement" },
					data: { secret_2: "Ag==" },
				} as V1Secret);
			} else if (mutation === "empty-uid") annotations[uidKey] = "";
			else if (mutation === "wrong-uid") annotations[uidKey] = "foreign-uid";
			else
				annotations[fenceKey] =
					mutation === "zero"
						? "0"
						: mutation === "noncanonical"
							? "07"
							: "9007199254740992";
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				metadata: { ...workload.metadata, annotations },
			});
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toMatchObject({
				code: "conflict",
			});
			expect(
				await adapter.switchRoute({
					schemaVersion: 1,
					requestId: desired.requestId,
					traceId: desired.traceId,
					agentId: desired.agentId,
					fence: desired.fence,
					action: "promote",
					candidateValidated: true,
					candidateRoute: {
						routeRef: desired.route.name,
						workloadUid: identity.uid,
						workloadGeneration: identity.generation,
						workloadRevision: desired.workloadRevision,
					},
				}),
			).toMatchObject({ status: "failed" });
			expect(
				(await f.client.read<V1Service>("Service", desired.service.name))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
			).toBe("closed");
		},
	);
	it("detects missing, terminating, foreign, or mutable Secret refs before reporting healthy", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const ref = {
			schemaVersion: 1 as const,
			agentId: desired.agentId,
			ownerType: "agent-owner" as const,
			ownerId: "owner-a",
			secretId: "secret-a",
			secretVersion: 1,
			configRevision: 1,
			algorithmVersion: "aes-256-gcm:v1" as const,
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
			wrappingKeyVersion: "key-a",
			name: `${desired.service.name}-secret-1`,
		};
		desired.secretRefs = [ref];
		const adapter = f.adapter();
		await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("healthy");
		const liveSecret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!liveSecret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...liveSecret,
			metadata: {
				...liveSecret.metadata,
				deletionTimestamp: new Date("2026-09-09T00:00:00Z"),
			},
		} as V1Secret);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
		f.resources.set(`Secret/${ref.name}`, liveSecret);

		f.resources.delete(`Secret/${ref.name}`);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
		await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("healthy");

		const secret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!secret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			immutable: false,
		} as V1Secret);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			metadata: {
				...secret.metadata,
				annotations: {
					...secret.metadata?.annotations,
					"agent-infra.agora.io/agent-id": "agent-b",
				},
			},
		} as V1Secret);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
	});
});
