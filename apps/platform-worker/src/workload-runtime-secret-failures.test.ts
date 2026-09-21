import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type {
	V1Secret,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { workloadTestPolicy } from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import {
	activeSecretRecord,
	fixture,
	secretCleanupStore,
	secretConfiguration,
	validateActiveSecretRecordV1,
} from "./workload-runtime-split.fixture.js";

describe("assembled Workload Runtime contracts", () => {
	it.each(["missing", "replacement-without-binding"] as const)(
		"fails closed when an active-origin Secret is %s",
		async (mutation) => {
			let record = activeSecretRecord();
			const cleanup = secretCleanupStore(record);
			const decrypt = vi.fn(async () => ({
				outcome: "failed" as const,
				code: "SECRET_KEY_UNAVAILABLE" as const,
			}));
			const audit = vi.fn(async () => undefined);
			const f = fixture(
				{ decryptor: { decrypt } },
				{
					configuration: secretConfiguration({ revision: 2 }),
					secrets: {
						get bindings() {
							return [{ materialization: "active-origin" as const, record }];
						},
						store: cleanup.store,
						auditDecryption: audit,
					},
				},
			);
			await f.tick(2);
			const deployment = validateAgentWorkloadDesiredV1(
				f.state?.candidate.deployment,
			);
			const ref = deployment.secretRefs[0];
			if (!ref) throw new Error();
			record = validateActiveSecretRecordV1({
				...record,
				kubernetesSecretRef: ref,
				activationFence: {
					...record.activationFence,
					kubernetesSecretName: ref.name,
				},
			});
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy: workloadTestPolicy,
				probe: async () => true,
			});
			const secretUid = await adapter.applyImmutableSecret(
				deployment,
				ref.name,
				"BOT_TOKEN",
				new Uint8Array([1, 2, 3]),
			);
			const identity = await adapter.apply(deployment);
			if (!identity || identity === "pending") throw new Error();
			record = validateActiveSecretRecordV1({
				...record,
				activationFence: {
					...record.activationFence,
					workloadUid: identity.uid,
					workloadGeneration: identity.generation,
				},
			});
			await adapter.bindSecretFence(
				deployment,
				identity,
				ref.name,
				record.activationFence.fence,
				secretUid,
			);

			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			expect(decrypt).not.toHaveBeenCalled();
			if (mutation === "missing") f.resources.delete(`Secret/${ref.name}`);
			else {
				const secret = await f.client.read<V1Secret>("Secret", ref.name);
				const workload = await f.client.read<V1StatefulSet>(
					"StatefulSet",
					deployment.service.name,
				);
				if (!secret || !workload?.metadata?.annotations) throw new Error();
				const annotations = { ...workload.metadata.annotations };
				for (const key of Object.keys(annotations)) {
					if (key.startsWith("agent-infra.agora.io/secret-"))
						delete annotations[key];
				}
				f.resources.set(`StatefulSet/${deployment.service.name}`, {
					...workload,
					metadata: { ...workload.metadata, annotations },
				});
				f.resources.set(`Secret/${ref.name}`, {
					...secret,
					metadata: { ...secret.metadata, uid: "unverified-replacement" },
					data: { BOT_TOKEN: "BA==" },
				} as V1Secret);
			}
			const before = structuredClone(record);

			await f.tick(2);
			expect(decrypt).toHaveBeenCalledTimes(1);
			expect(audit).toHaveBeenCalledWith("secret-a", "key-a", "rejected");
			expect(f.state?.phase).not.toBe("ready");
			expect(
				(await f.client.read<V1Service>("Service", deployment.service.name))
					?.spec?.selector?.["agent-infra.agora.io/revision"],
			).toBe("closed");
			expect(record).toEqual(before);
		},
	);

	it.each([
		"missing",
		"foreign",
		"mutable",
		"activation fence mismatch",
		"StatefulSet UID mismatch",
		"StatefulSet generation mismatch",
		"Secret fence annotation mismatch",
	] as const)(
		"does not reuse a %s current active Secret when decryption is unavailable",
		async (mutation) => {
			let record = activeSecretRecord();
			const cleanup = secretCleanupStore(record);
			const decrypt = vi.fn(async () => ({
				outcome: "failed" as const,
				code: "SECRET_KEY_UNAVAILABLE" as const,
			}));
			const audit = vi.fn(async () => undefined);
			const f = fixture(
				{ decryptor: { decrypt } },
				{
					configuration: secretConfiguration(),
					secrets: {
						get bindings() {
							return [{ materialization: "current" as const, record }];
						},
						store: cleanup.store,
						auditDecryption: audit,
					},
				},
			);
			await f.tick(2);
			const deployment = validateAgentWorkloadDesiredV1(
				f.state?.candidate.deployment,
			);
			const ref = deployment.secretRefs[0];
			if (!ref) throw new Error();
			record = validateActiveSecretRecordV1({
				...record,
				kubernetesSecretRef: ref,
				activationFence: {
					...record.activationFence,
					kubernetesSecretName: ref.name,
				},
			});
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy: workloadTestPolicy,
				probe: async () => true,
			});
			const secretUid = await adapter.applyImmutableSecret(
				deployment,
				ref.name,
				"BOT_TOKEN",
				new Uint8Array([1, 2, 3]),
			);
			const identity = await adapter.apply(deployment);
			if (!identity || identity === "pending") throw new Error();
			record = validateActiveSecretRecordV1({
				...record,
				activationFence: {
					...record.activationFence,
					workloadUid: identity.uid,
					workloadGeneration: identity.generation,
				},
			});
			await adapter.bindSecretFence(
				deployment,
				identity,
				ref.name,
				record.activationFence.fence,
				secretUid,
			);
			if (mutation === "activation fence mismatch")
				record = validateActiveSecretRecordV1({
					...record,
					activationFence: {
						...record.activationFence,
						fence: record.activationFence.fence + 1,
					},
				});
			if (mutation === "StatefulSet UID mismatch")
				record = validateActiveSecretRecordV1({
					...record,
					activationFence: {
						...record.activationFence,
						workloadUid: "workload-other",
					},
				});
			if (mutation === "StatefulSet generation mismatch")
				record = validateActiveSecretRecordV1({
					...record,
					activationFence: {
						...record.activationFence,
						workloadGeneration: record.activationFence.workloadGeneration + 1,
					},
				});
			const secret = await f.client.read<V1Secret>("Secret", ref.name);
			if (!secret) throw new Error();
			if (mutation === "missing") f.resources.delete(`Secret/${ref.name}`);
			if (mutation === "foreign")
				f.resources.set(`Secret/${ref.name}`, {
					...secret,
					metadata: {
						...secret.metadata,
						annotations: {
							...secret.metadata?.annotations,
							"agent-infra.agora.io/agent-id": "agent-other",
						},
					},
				} as V1Secret);
			if (mutation === "mutable")
				f.resources.set(`Secret/${ref.name}`, {
					...secret,
					immutable: false,
				} as V1Secret);
			if (mutation === "Secret fence annotation mismatch") {
				const statefulSet = await f.client.read<V1StatefulSet>(
					"StatefulSet",
					deployment.service.name,
				);
				const fenceAnnotation = Object.keys(
					statefulSet?.metadata?.annotations ?? {},
				).find((key) => key.startsWith("agent-infra.agora.io/secret-"));
				if (!statefulSet?.metadata?.name || !fenceAnnotation) throw new Error();
				f.resources.set(`StatefulSet/${statefulSet.metadata.name}`, {
					...statefulSet,
					metadata: {
						...statefulSet.metadata,
						annotations: {
							...statefulSet.metadata.annotations,
							[fenceAnnotation]: "2",
						},
					},
				} as V1StatefulSet);
			}
			const before = structuredClone(record);

			await f.tick(2);
			expect(decrypt).toHaveBeenCalledTimes(1);
			expect(audit).toHaveBeenCalledWith("secret-a", "key-a", "rejected");
			expect(f.state?.phase).not.toBe("ready");
			expect(
				(await f.client.read<V1Service>("Service", deployment.service.name))
					?.spec?.selector?.["agent-infra.agora.io/revision"],
			).toBe("closed");
			expect(record).toEqual(before);
		},
	);
});
