import type {
	KubernetesObject,
	V1Secret,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import type {
	WorkerKubernetesClientV1,
	WorkloadResourceKind,
} from "./kubernetes-client.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

describe("GA Kubernetes Workload adapter", () => {
	it("creates immutable Agent/version Secret refs and refuses terminating or changed Secret reuse", async () => {
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
		const createdUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const existing = await f.client.read<V1Secret>("Secret", ref.name);
		expect(existing?.immutable).toBe(true);
		expect(createdUid).toBe(existing?.metadata?.uid);
		if (!existing) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...existing,
			metadata: {
				...existing.metadata,
				deletionTimestamp: new Date("2026-09-09T00:00:00Z"),
			},
		} as V1Secret);
		await expect(
			adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				new Uint8Array([1, 2, 3]),
			),
		).rejects.toMatchObject({ code: "conflict" });
		f.resources.set(`Secret/${ref.name}`, existing);
		expect(
			await adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				new Uint8Array([1, 2, 3]),
			),
		).toBe(createdUid);
		await expect(
			adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				new Uint8Array([4]),
			),
		).rejects.toThrow();
		expect((await f.client.read<V1Secret>("Secret", ref.name))?.data).toEqual(
			existing?.data,
		);
	});
	it("removes a materialized Secret only with its current Workload fence", async () => {
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
		expect(
			await adapter.removeImmutableSecret(desired, ref, {
				...activationFence,
				fence: 8,
			}),
		).toBe(false);
		expect(await f.client.read<V1Secret>("Secret", ref.name)).not.toBeNull();
		const workload = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		if (!workload) throw new Error();
		f.resources.delete(`StatefulSet/${desired.service.name}`);
		expect(
			await adapter.removeImmutableSecret(desired, ref, activationFence),
		).toBe(false);
		expect(await f.client.read<V1Secret>("Secret", ref.name)).not.toBeNull();
		f.resources.set(`StatefulSet/${desired.service.name}`, {
			...workload,
			metadata: {
				...workload.metadata,
				generation: identity.generation + 1,
			},
		} as V1StatefulSet);
		expect(
			await adapter.removeImmutableSecret(desired, ref, activationFence),
		).toBe(true);
		expect(await f.client.read<V1Secret>("Secret", ref.name)).toBeNull();
	});
	it.each([
		"kubernetes.io/service-account-token",
		"kubernetes.io/tls",
		undefined,
	])(
		"rejects non-Opaque Secret reuse, activation and cleanup: %s",
		async (type) => {
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
			const plaintext = new Uint8Array([1]);
			const uid = await adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				plaintext,
			);
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const secret = await f.client.read<V1Secret>("Secret", ref.name);
			if (!secret) throw new Error();
			f.resources.set(`Secret/${ref.name}`, { ...secret, type } as V1Secret);
			await expect(
				adapter.applyImmutableSecret(desired, ref.name, "API_KEY", plaintext),
			).rejects.toThrow();
			expect(
				await adapter.observe(desired, identity, "closed", "activation"),
			).toBe("drifted");
			await expect(
				adapter.bindSecretFence(desired, identity, ref.name, 7, uid),
			).rejects.toThrow();
			await expect(
				adapter.removeImmutableSecret(desired, ref),
			).rejects.toMatchObject({
				code: "policy",
			});
			expect(await f.client.read<V1Secret>("Secret", ref.name)).toEqual({
				...secret,
				type,
			});
		},
	);
	it("fences identical immutable Secret reuse without changing its body", async () => {
		const f = fixture();
		const desired = { ...workloadDesiredFixture(), fence: 9 };
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
		const plaintext = new Uint8Array([1, 2, 3]);
		await adapter.applyImmutableSecret(desired, ref.name, "API_KEY", plaintext);
		const existing = await f.client.read<V1Secret>("Secret", ref.name);
		if (!existing) throw new Error();

		const current = { ...desired, requestId: "request-current", fence: 11 };
		await adapter.applyImmutableSecret(current, ref.name, "API_KEY", plaintext);
		const reused = await f.client.read<V1Secret>("Secret", ref.name);
		expect(reused?.metadata?.annotations?.["agent-infra.agora.io/fence"]).toBe(
			"11",
		);
		expect(reused?.metadata?.uid).toBe(existing.metadata?.uid);
		expect(reused?.metadata?.resourceVersion).not.toBe(
			existing.metadata?.resourceVersion,
		);
		expect(reused?.immutable).toBe(existing.immutable);
		expect(reused?.type).toBe(existing.type);
		expect(reused?.data).toStrictEqual(existing.data);

		await expect(
			adapter.removeImmutableSecret(desired, ref),
		).rejects.toMatchObject({
			code: "conflict",
		});
		expect(await f.client.read<V1Secret>("Secret", ref.name)).not.toBeNull();
	});
	it("advances the Workload fence when the bound Secret fence is unchanged", async () => {
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

		const current = { ...desired, requestId: "request-current", fence: 11 };
		await adapter.bindSecretFence(current, identity, ref.name, 7, secretUid);
		const bound = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		const uidKey = Object.keys(bound?.metadata?.annotations ?? {}).find((key) =>
			key.startsWith("agent-infra.agora.io/secret-uid-"),
		);
		if (!bound || !uidKey) throw new Error();
		const legacyAnnotations = { ...bound.metadata?.annotations };
		delete legacyAnnotations[uidKey];
		f.resources.set(`StatefulSet/${desired.service.name}`, {
			...bound,
			metadata: { ...bound.metadata, annotations: legacyAnnotations },
		} as V1StatefulSet);
		await adapter.bindSecretFence(current, identity, ref.name, 7, secretUid);
		const repaired = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		expect(repaired?.metadata?.annotations?.[uidKey]).toBe(secretUid);
		if (!repaired) throw new Error();
		f.resources.set(`StatefulSet/${desired.service.name}`, {
			...repaired,
			metadata: {
				...repaired.metadata,
				annotations: {
					...repaired.metadata?.annotations,
					[uidKey]: "foreign-secret-uid",
				},
			},
		} as V1StatefulSet);
		await expect(
			adapter.bindSecretFence(current, identity, ref.name, 7, secretUid),
		).rejects.toMatchObject({ code: "conflict" });
		f.resources.set(`StatefulSet/${desired.service.name}`, repaired);
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", desired.service.name))
				?.metadata?.annotations?.["agent-infra.agora.io/fence"],
		).toBe("11");
		await expect(
			adapter.apply({ ...desired, requestId: "request-stale", fence: 9 }),
		).rejects.toMatchObject({ code: "conflict" });
		await adapter.bindSecretFence(current, identity, ref.name, 8, secretUid);
		await expect(
			adapter.bindSecretFence(current, identity, ref.name, 7, secretUid),
		).rejects.toMatchObject({ code: "conflict" });
		expect(
			Object.values(
				(
					await f.client.read<V1StatefulSet>(
						"StatefulSet",
						desired.service.name,
					)
				)?.metadata?.annotations ?? {},
			),
		).toContain("8");
	});
	it("rebinds a recreated active Secret only with its original activation fence", async () => {
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
		const plaintext = new Uint8Array([1, 2, 3]);
		const originalUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			plaintext,
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.bindSecretFence(desired, identity, ref.name, 7, originalUid);
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
		const secret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!secret) throw new Error();
		const replacementUid = "replacement-secret-uid";
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			metadata: { ...secret.metadata, uid: replacementUid },
		} as V1Secret);

		expect(
			await adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				plaintext,
				activationFence,
			),
		).toBe(replacementUid);
		const rebound = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		expect(
			Object.entries(rebound?.metadata?.annotations ?? {}).find(([key]) =>
				key.startsWith("agent-infra.agora.io/secret-uid-"),
			)?.[1],
		).toBe(replacementUid);
	});
	it.each([
		"zero generation",
		"wrong reference",
		"wrong activation fence",
		"higher management fence",
	] as const)("rejects active Secret recovery with a %s", async (mutation) => {
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
		const plaintext = new Uint8Array([1, 2, 3]);
		const originalUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			plaintext,
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.bindSecretFence(desired, identity, ref.name, 7, originalUid);
		const secret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!secret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			metadata: { ...secret.metadata, uid: "replacement-secret-uid" },
		} as V1Secret);
		const activationFence = {
			schemaVersion: 1 as const,
			agentId: ref.agentId,
			secretId: mutation === "wrong reference" ? "secret-other" : ref.secretId,
			secretVersion: ref.secretVersion,
			configRevision: ref.configRevision,
			kubernetesSecretName: ref.name,
			workloadUid: identity.uid,
			workloadGeneration:
				mutation === "zero generation" ? 0 : identity.generation,
			fence: mutation === "wrong activation fence" ? 8 : 7,
		};
		if (mutation === "higher management fence") {
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			if (!workload?.metadata?.annotations) throw new Error();
			workload.metadata.annotations["agent-infra.agora.io/fence"] = "2";
			f.resources.set(`StatefulSet/${desired.service.name}`, workload);
		}

		await expect(
			adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				plaintext,
				activationFence,
			),
		).rejects.toMatchObject({ code: "conflict" });
		const workload = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		expect(Object.values(workload?.metadata?.annotations ?? {})).toContain(
			originalUid,
		);
	});
	it.each(["Secret UID", "StatefulSet resourceVersion"] as const)(
		"rejects a concurrent %s change while rebinding an active Secret",
		async (race) => {
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
			let armed = false;
			let secretReads = 0;
			const client: WorkerKubernetesClientV1 = {
				...f.client,
				async read<T extends KubernetesObject>(
					kind: WorkloadResourceKind,
					name: string,
				) {
					if (armed && race === "Secret UID" && kind === "Secret") {
						secretReads++;
						if (secretReads === 2) {
							const secret = await f.client.read<V1Secret>("Secret", ref.name);
							if (!secret) throw new Error();
							f.resources.set(`Secret/${ref.name}`, {
								...secret,
								metadata: { ...secret.metadata, uid: "raced-secret-uid" },
							} as V1Secret);
						}
					}
					return f.client.read<T>(kind, name);
				},
				async replace<T extends KubernetesObject>(object: T): Promise<T> {
					if (
						armed &&
						race === "StatefulSet resourceVersion" &&
						object.kind === "StatefulSet"
					) {
						armed = false;
						const workload = await f.client.read<V1StatefulSet>(
							"StatefulSet",
							desired.service.name,
						);
						if (!workload) throw new Error();
						f.resources.set(`StatefulSet/${desired.service.name}`, {
							...workload,
							metadata: {
								...workload.metadata,
								resourceVersion: "concurrent-resource-version",
							},
						} as V1StatefulSet);
					}
					return f.client.replace(object);
				},
			};
			const adapter = createKubernetesRuntimeAdapterV1({
				client,
				policy: workloadTestPolicy,
				probe: async () => true,
			});
			const plaintext = new Uint8Array([1, 2, 3]);
			const originalUid = await adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				plaintext,
			);
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			await adapter.bindSecretFence(
				desired,
				identity,
				ref.name,
				7,
				originalUid,
			);
			const secret = await f.client.read<V1Secret>("Secret", ref.name);
			if (!secret) throw new Error();
			f.resources.set(`Secret/${ref.name}`, {
				...secret,
				metadata: { ...secret.metadata, uid: "replacement-secret-uid" },
			} as V1Secret);
			armed = true;

			await expect(
				adapter.applyImmutableSecret(desired, ref.name, "API_KEY", plaintext, {
					schemaVersion: 1,
					agentId: ref.agentId,
					secretId: ref.secretId,
					secretVersion: ref.secretVersion,
					configRevision: ref.configRevision,
					kubernetesSecretName: ref.name,
					workloadUid: identity.uid,
					workloadGeneration: identity.generation,
					fence: 7,
				}),
			).rejects.toMatchObject({ code: "conflict" });
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			expect(Object.values(workload?.metadata?.annotations ?? {})).toContain(
				originalUid,
			);
		},
	);
});
