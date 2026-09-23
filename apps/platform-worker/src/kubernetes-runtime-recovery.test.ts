import type {
	V1Pod,
	V1Secret,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { workloadDesiredFixture } from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";

describe("persisted recovery candidate Kubernetes operations", () => {
	const fenceKey = "agent-infra.agora.io/fence";
	const revisionKey = "agent-infra.agora.io/revision";
	async function recoveryFixture() {
		const f = fixture();
		const desired = workloadDesiredFixture(2);
		const reference = {
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
			name: `${desired.service.name}-secret-recovery-2`,
		};
		desired.secretRefs = [reference];
		const adapter = f.adapter();
		const secretUid = await adapter.applyImmutableSecret(
			desired,
			reference.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const workload = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		if (!workload?.metadata || !workload.spec) throw new Error();
		const secret = await f.client.read<V1Secret>("Secret", reference.name);
		if (!secret?.metadata) throw new Error();
		const creation = {
			revision: desired.workloadRevision,
			fence: desired.fence,
		};
		return {
			...f,
			desired,
			reference,
			adapter,
			identity,
			workload: {
				...workload,
				metadata: workload.metadata,
				spec: workload.spec,
			},
			secret: { ...secret, metadata: secret.metadata },
			secretUid,
			creation,
		};
	}
	it.each(["unhealthy", "no Pod", "increased generation"] as const)(
		"adopts the exact persisted creation with %s without treating it as healthy",
		async (condition) => {
			const f = await recoveryFixture();
			if (condition === "unhealthy")
				f.workload.status = { replicas: 1, readyReplicas: 0 };
			if (condition === "increased generation")
				f.workload.metadata.generation = f.identity.generation + 1;
			f.resources.set(`StatefulSet/${f.desired.service.name}`, f.workload);
			if (condition === "no Pod")
				f.resources.delete(`Pod/${f.desired.service.name}-0`);
			const writes = f.writes.length;
			const expected = {
				uid: f.identity.uid,
				generation: f.workload.metadata.generation,
			};
			expect(await f.adapter.observeRecoveryWorkload(f.desired, null)).toEqual(
				expected,
			);
			expect(
				await f.adapter.observeRecoveryWorkload(f.desired, f.identity),
			).toEqual(expected);
			expect(f.probe).not.toHaveBeenCalled();
			expect(f.writes).toHaveLength(writes);
		},
	);
	it.each([
		"older revision",
		"older fence",
		"higher fence",
		"foreign Agent",
		"changed image",
		"changed env",
		"changed Secret",
		"injected container",
		"changed PVC",
		"unsafe retention",
		"missing resourceVersion",
		"invalid generation",
		"deleting",
		"known different UID",
		"generation rollback",
	] as const)("rejects recovery adoption with %s", async (mutation) => {
		const f = await recoveryFixture();
		const workload = f.workload;
		const container = workload.spec.template.spec?.containers[0];
		if (
			!container ||
			!workload.metadata.annotations ||
			!workload.metadata.labels
		)
			throw new Error();
		let identity: typeof f.identity | null = null;
		if (mutation === "older revision")
			workload.metadata.labels[revisionKey] = "1";
		if (mutation === "older fence")
			workload.metadata.annotations[fenceKey] = "1";
		if (mutation === "higher fence")
			workload.metadata.annotations[fenceKey] = "3";
		if (mutation === "foreign Agent")
			workload.metadata.annotations["agent-infra.agora.io/agent-id"] =
				"agent-b";
		if (mutation === "changed image") container.image = "foreign/image:latest";
		if (mutation === "changed env")
			container.env = [{ name: "LOG_LEVEL", value: "debug" }];
		if (mutation === "changed Secret")
			container.envFrom = [{ secretRef: { name: "original-secret" } }];
		if (mutation === "injected container")
			workload.spec.template.spec?.containers.push({
				name: "extra",
				image: "extra:latest",
			});
		if (mutation === "changed PVC")
			workload.spec.template.spec?.volumes?.push({
				name: "other",
				persistentVolumeClaim: { claimName: "other-data" },
			});
		if (mutation === "unsafe retention")
			workload.spec.persistentVolumeClaimRetentionPolicy = {
				whenDeleted: "Delete",
				whenScaled: "Delete",
			};
		if (mutation === "missing resourceVersion")
			delete workload.metadata.resourceVersion;
		if (mutation === "invalid generation") workload.metadata.generation = 0;
		if (mutation === "deleting")
			workload.metadata.deletionTimestamp = new Date();
		if (mutation === "known different UID")
			identity = { ...f.identity, uid: "previous-uid" };
		if (mutation === "generation rollback")
			identity = { ...f.identity, generation: f.identity.generation + 1 };
		f.resources.set(`StatefulSet/${f.desired.service.name}`, workload);
		await expect(
			f.adapter.observeRecoveryWorkload(f.desired, identity),
		).rejects.toMatchObject({
			code: mutation === "foreign Agent" ? "policy" : "conflict",
		});
	});
	it.each(["live StatefulSet", "missing StatefulSet"] as const)(
		"rejects a foreign Pod beside a %s",
		async (state) => {
			const f = await recoveryFixture();
			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${f.desired.service.name}-0`,
			);
			if (!pod?.metadata) throw new Error();
			pod.metadata.ownerReferences = [
				{
					apiVersion: "apps/v1",
					kind: "StatefulSet",
					name: f.desired.service.name,
					uid: "foreign-uid",
					controller: true,
				},
			];
			f.resources.set(`Pod/${f.desired.service.name}-0`, pod);
			if (state === "missing StatefulSet")
				f.resources.delete(`StatefulSet/${f.desired.service.name}`);
			await expect(
				f.adapter.observeRecoveryWorkload(f.desired, null),
			).rejects.toMatchObject({ code: "conflict" });
		},
	);
	it.each(["present", "absent"] as const)(
		"rejects a stale management fence while the recovery StatefulSet is %s",
		async (state) => {
			const f = await recoveryFixture();
			if (state === "absent") {
				f.resources.delete(`StatefulSet/${f.desired.service.name}`);
				f.resources.delete(`Pod/${f.desired.service.name}-0`);
			}
			const pvc = await f.client.read(
				"PersistentVolumeClaim",
				f.desired.persistentVolume.name,
			);
			if (!pvc?.metadata?.annotations) throw new Error();
			pvc.metadata.annotations[fenceKey] = "4";
			f.resources.set(
				`PersistentVolumeClaim/${f.desired.persistentVolume.name}`,
				pvc,
			);
			await expect(
				f.adapter.observeRecoveryWorkload(f.desired, null),
			).rejects.toMatchObject({ code: "conflict" });
			expect(
				await f.adapter.observeRecoveryWorkload(f.desired, null, {
					revision: 2,
					fence: 4,
				}),
			).toEqual(state === "absent" ? null : f.identity);
		},
	);
	it("reports absence only after successful StatefulSet and Pod reads", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture(2);
		expect(await f.adapter().observeRecoveryWorkload(desired, null)).toBeNull();
		vi.spyOn(f.client, "list").mockRejectedValue(
			new Error("synthetic read failure"),
		);
		await expect(
			f.adapter().observeRecoveryWorkload(desired, null),
		).rejects.toThrow("synthetic read failure");
	});
	it("cleans the failed candidate under the latest fence, preserving the original Secret and PVC", async () => {
		const f = await recoveryFixture();
		const originalName = `${f.desired.service.name}-original-secret`;
		const original = {
			...f.secret,
			metadata: {
				...f.secret.metadata,
				name: originalName,
				uid: "original-uid",
			},
		};
		f.resources.set(`Secret/${originalName}`, original);
		const pvcBefore = await f.client.read(
			"PersistentVolumeClaim",
			f.desired.persistentVolume.name,
		);
		const latest = { ...f.desired, fence: 4 };
		await f.adapter.closeAgent(
			latest.agentId,
			latest.workloadRevision,
			latest.fence,
		);
		const remove = vi.spyOn(f.client, "delete");
		expect(
			await f.adapter.removeRecoveryWorkload(latest, f.identity, f.creation),
		).toBe(true);
		expect(remove).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "StatefulSet",
				metadata: expect.objectContaining({
					uid: f.identity.uid,
					resourceVersion: f.workload.metadata.resourceVersion,
				}),
			}),
		);
		expect(
			await f.adapter.removeRecoverySecret(
				latest,
				f.reference,
				f.secretUid,
				f.creation,
			),
		).toBe(true);
		expect(
			await f.client.read(
				"PersistentVolumeClaim",
				f.desired.persistentVolume.name,
			),
		).toEqual(pvcBefore);
		expect(await f.client.read("Secret", originalName)).toEqual(original);
		expect(
			await f.adapter.removeRecoveryWorkload(latest, f.identity, f.creation),
		).toBe(true);
		expect(
			await f.adapter.removeRecoverySecret(
				latest,
				f.reference,
				f.secretUid,
				f.creation,
			),
		).toBe(true);
		expect(remove).toHaveBeenCalledTimes(2);
	});
	it.each([
		"NodePort",
		"LoadBalancer",
		"external IP",
		"foreign selector",
		"changed port",
		"routing annotation",
	] as const)(
		"retains recovery resources with probe Service drift: %s",
		async (mutation) => {
			const f = await recoveryFixture();
			expect(
				await f.adapter.closeAgent(
					f.desired.agentId,
					f.desired.workloadRevision,
					f.desired.fence,
				),
			).toBe(true);
			const probeName = `${f.desired.service.name}-probe`;
			const probe = await f.client.read<V1Service>("Service", probeName);
			if (!probe?.spec || !probe.metadata?.annotations) throw new Error();
			if (mutation === "NodePort" || mutation === "LoadBalancer")
				probe.spec.type = mutation;
			if (mutation === "external IP") probe.spec.externalIPs = ["192.0.2.1"];
			if (mutation === "foreign selector")
				probe.spec.selector = { "agent-infra.agora.io/agent": "foreign-agent" };
			if (mutation === "changed port")
				probe.spec.ports = [{ name: "runtime", port: 9090, targetPort: 9090 }];
			if (mutation === "routing annotation")
				probe.metadata.annotations[
					"external-dns.alpha.kubernetes.io/hostname"
				] = "probe.example.test";
			f.resources.set(`Service/${probeName}`, probe);
			const remove = vi.spyOn(f.client, "delete");
			expect(
				await f.adapter.removeRecoveryWorkload(
					f.desired,
					f.identity,
					f.creation,
				),
			).toBe(false);
			expect(remove).not.toHaveBeenCalled();
			// A retry after the candidate disappeared must also retain its Secret.
			f.resources.delete(`StatefulSet/${f.desired.service.name}`);
			f.resources.delete(`Pod/${f.desired.service.name}-0`);
			expect(
				await f.adapter.removeRecoverySecret(
					f.desired,
					f.reference,
					f.secretUid,
					f.creation,
				),
			).toBe(false);
			expect(remove).not.toHaveBeenCalled();
			expect(await f.client.read("Secret", f.reference.name)).toEqual(f.secret);
		},
	);
	it.each(["internal", "absent"] as const)(
		"cleans recovery resources with an %s probe under a newer management fence",
		async (state) => {
			const f = await recoveryFixture();
			if (state === "absent")
				f.resources.delete(`Service/${f.desired.service.name}-probe`);
			const latest = { ...f.desired, fence: 4 };
			await f.adapter.closeAgent(
				latest.agentId,
				latest.workloadRevision,
				latest.fence,
			);
			expect(
				await f.adapter.removeRecoveryWorkload(latest, f.identity, f.creation),
			).toBe(true);
			expect(
				await f.adapter.removeRecoverySecret(
					latest,
					f.reference,
					f.secretUid,
					f.creation,
				),
			).toBe(true);
		},
	);
	it.each(["foreign Agent", "newer fence"] as const)(
		"rejects a probe Service with a %s before deleting recovery resources",
		async (mutation) => {
			const f = await recoveryFixture();
			const probeName = `${f.desired.service.name}-probe`;
			const probe = await f.client.read<V1Service>("Service", probeName);
			if (!probe?.metadata?.annotations) throw new Error();
			if (mutation === "foreign Agent")
				probe.metadata.annotations["agent-infra.agora.io/agent-id"] = "agent-b";
			else probe.metadata.annotations[fenceKey] = "3";
			f.resources.set(`Service/${probeName}`, probe);
			const remove = vi.spyOn(f.client, "delete");
			const error = {
				code: mutation === "foreign Agent" ? "policy" : "conflict",
			};
			await expect(
				f.adapter.removeRecoveryWorkload(f.desired, f.identity, f.creation),
			).rejects.toMatchObject(error);
			await expect(
				f.adapter.removeRecoverySecret(
					f.desired,
					f.reference,
					f.secretUid,
					f.creation,
				),
			).rejects.toMatchObject(error);
			expect(remove).not.toHaveBeenCalled();
		},
	);
	it.each([
		"no identity",
		"different UID",
		"generation rollback",
		"different creation fence",
		"different creation revision",
		"missing resourceVersion",
	] as const)("retains the candidate Workload with %s", async (mutation) => {
		const f = await recoveryFixture();
		let identity: typeof f.identity | null = f.identity;
		const creation = { ...f.creation };
		if (mutation === "no identity") identity = null;
		if (mutation === "different UID")
			identity = { ...f.identity, uid: "original-workload" };
		if (mutation === "generation rollback")
			identity = { ...f.identity, generation: f.identity.generation + 1 };
		if (mutation === "different creation fence") creation.fence = 1;
		if (mutation === "different creation revision") creation.revision = 1;
		if (mutation === "missing resourceVersion") {
			delete f.workload.metadata.resourceVersion;
			f.resources.set(`StatefulSet/${f.desired.service.name}`, f.workload);
		}
		const remove = vi.spyOn(f.client, "delete");
		expect(
			await f.adapter.removeRecoveryWorkload(f.desired, identity, creation),
		).toBe(false);
		expect(remove).not.toHaveBeenCalled();
	});
	it.each(["whenDeleted", "whenScaled", "volumeClaimTemplates"] as const)(
		"protects persistent data when recovery candidate %s drifted",
		async (field) => {
			const f = await recoveryFixture();
			if (field === "volumeClaimTemplates")
				f.workload.spec.volumeClaimTemplates = [{ metadata: { name: "data" } }];
			else
				f.workload.spec.persistentVolumeClaimRetentionPolicy = {
					whenDeleted: "Retain",
					whenScaled: "Retain",
					[field]: "Delete",
				};
			f.resources.set(`StatefulSet/${f.desired.service.name}`, f.workload);
			const remove = vi.spyOn(f.client, "delete");
			expect(
				await f.adapter.removeRecoveryWorkload(
					f.desired,
					f.identity,
					f.creation,
				),
			).toBe(false);
			expect(remove).not.toHaveBeenCalled();
		},
	);
	it.each(["Service", "PersistentVolumeClaim", "NetworkPolicy"] as const)(
		"rejects a higher %s fence even after candidate deletion",
		async (kind) => {
			const f = await recoveryFixture();
			expect(
				await f.adapter.removeRecoveryWorkload(
					f.desired,
					f.identity,
					f.creation,
				),
			).toBe(true);
			const name =
				kind === "PersistentVolumeClaim"
					? f.desired.persistentVolume.name
					: f.desired.service.name;
			const resource = await f.client.read(kind, name);
			if (!resource?.metadata?.annotations) throw new Error();
			resource.metadata.annotations[fenceKey] = "3";
			f.resources.set(`${kind}/${name}`, resource);
			const remove = vi.spyOn(f.client, "delete");
			await expect(
				f.adapter.removeRecoveryWorkload(f.desired, f.identity, f.creation),
			).rejects.toMatchObject({ code: "conflict" });
			await expect(
				f.adapter.removeRecoverySecret(
					f.desired,
					f.reference,
					f.secretUid,
					f.creation,
				),
			).rejects.toMatchObject({ code: "conflict" });
			expect(remove).not.toHaveBeenCalled();
		},
	);
	it.each(["open route", "foreign Pod", "failed read"] as const)(
		"retains recovery resources after %s",
		async (condition) => {
			const f = await recoveryFixture();
			if (condition === "open route") {
				await f.adapter.bindSecretFence(
					f.desired,
					f.identity,
					f.reference.name,
					f.creation.fence,
					f.secretUid,
				);
				await f.adapter.promote(f.desired, f.identity);
			}
			if (condition === "foreign Pod") {
				const pod = await f.client.read<V1Pod>(
					"Pod",
					`${f.desired.service.name}-0`,
				);
				if (!pod?.metadata) throw new Error();
				pod.metadata.ownerReferences = [];
				f.resources.set(`Pod/${f.desired.service.name}-0`, pod);
			}
			if (condition === "failed read")
				vi.spyOn(f.client, "read").mockRejectedValue(
					new Error("synthetic read failure"),
				);
			const remove = vi.spyOn(f.client, "delete");
			const result = f.adapter.removeRecoveryWorkload(
				f.desired,
				f.identity,
				f.creation,
			);
			if (condition === "failed read")
				await expect(result).rejects.toThrow("synthetic read failure");
			else expect(await result).toBe(false);
			expect(remove).not.toHaveBeenCalled();
		},
	);
	it.each(["StatefulSet", "Secret"] as const)(
		"retains a concurrent %s replacement through UID/resourceVersion preconditions",
		async (kind) => {
			const f = await recoveryFixture();
			if (kind === "Secret")
				await f.adapter.removeRecoveryWorkload(
					f.desired,
					f.identity,
					f.creation,
				);
			const name =
				kind === "Secret" ? f.reference.name : f.desired.service.name;
			const remove = f.client.delete.bind(f.client);
			vi.spyOn(f.client, "delete").mockImplementation(async (resource) => {
				const live = await f.client.read(kind, name);
				if (!live) throw new Error();
				f.resources.set(`${kind}/${name}`, {
					...live,
					metadata: {
						...live.metadata,
						uid: "replacement-uid",
						resourceVersion: "new-version",
					},
				});
				return remove(resource);
			});
			await expect(
				kind === "Secret"
					? f.adapter.removeRecoverySecret(
							f.desired,
							f.reference,
							f.secretUid,
							f.creation,
						)
					: f.adapter.removeRecoveryWorkload(f.desired, f.identity, f.creation),
			).rejects.toMatchObject({ code: "conflict" });
			expect((await f.client.read(kind, name))?.metadata?.uid).toBe(
				"replacement-uid",
			);
		},
	);
	it.each(["StatefulSet", "Secret"] as const)(
		"resumes %s cleanup after a lost successful deletion response",
		async (kind) => {
			const f = await recoveryFixture();
			if (kind === "Secret")
				await f.adapter.removeRecoveryWorkload(
					f.desired,
					f.identity,
					f.creation,
				);
			const name =
				kind === "Secret" ? f.reference.name : f.desired.service.name;
			const cleanup = () =>
				kind === "Secret"
					? f.adapter.removeRecoverySecret(
							f.desired,
							f.reference,
							f.secretUid,
							f.creation,
						)
					: f.adapter.removeRecoveryWorkload(f.desired, f.identity, f.creation);
			f.loseNextDelete(kind, name);
			await expect(cleanup()).rejects.toMatchObject({ code: "unavailable" });
			expect(await f.client.read(kind, name)).not.toBeNull();
			await f.completeDeferredDelete();
			const remove = vi.spyOn(f.client, "delete");
			expect(await cleanup()).toBe(true);
			expect(remove).not.toHaveBeenCalled();
		},
	);
	it("waits for all Pods to disappear before reclaiming recovery material", async () => {
		const f = await recoveryFixture();
		const pod = await f.client.read("Pod", `${f.desired.service.name}-0`);
		if (!pod) throw new Error();
		f.resources.delete(`StatefulSet/${f.desired.service.name}`);
		const remove = vi.spyOn(f.client, "delete");
		expect(
			await f.adapter.removeRecoveryWorkload(f.desired, f.identity, f.creation),
		).toBe(false);
		expect(
			await f.adapter.removeRecoverySecret(
				f.desired,
				f.reference,
				f.secretUid,
				f.creation,
			),
		).toBe(false);
		expect(remove).not.toHaveBeenCalled();
		f.resources.delete(`Pod/${f.desired.service.name}-0`);
		expect(
			await f.adapter.removeRecoverySecret(
				f.desired,
				f.reference,
				f.secretUid,
				f.creation,
			),
		).toBe(true);
	});
	it.each([
		"different UID",
		"different creation fence",
		"different creation revision",
		"different Secret version",
		"mutable",
		"wrong type",
		"missing resourceVersion",
	] as const)("retains recovery material with %s", async (mutation) => {
		const f = await recoveryFixture();
		await f.adapter.removeRecoveryWorkload(f.desired, f.identity, f.creation);
		if (!f.secret.metadata.annotations || !f.secret.metadata.labels)
			throw new Error();
		if (mutation === "different UID") f.secret.metadata.uid = "replacement-uid";
		if (mutation === "different creation fence")
			f.secret.metadata.annotations[fenceKey] = "1";
		if (mutation === "different creation revision")
			f.secret.metadata.labels[revisionKey] = "1";
		if (mutation === "different Secret version")
			f.secret.metadata.annotations["agent-infra.agora.io/secret-version"] =
				"2";
		if (mutation === "mutable") f.secret.immutable = false;
		if (mutation === "wrong type") f.secret.type = "kubernetes.io/tls";
		if (mutation === "missing resourceVersion")
			delete f.secret.metadata.resourceVersion;
		f.resources.set(`Secret/${f.reference.name}`, f.secret);
		const remove = vi.spyOn(f.client, "delete");
		expect(
			await f.adapter.removeRecoverySecret(
				f.desired,
				f.reference,
				f.secretUid,
				f.creation,
			),
		).toBe(false);
		expect(remove).not.toHaveBeenCalled();
	});
	it("rejects a caller-supplied reference outside the persisted candidate", async () => {
		const f = await recoveryFixture();
		await f.adapter.removeRecoveryWorkload(f.desired, f.identity, f.creation);
		const remove = vi.spyOn(f.client, "delete");
		await expect(
			f.adapter.removeRecoverySecret(
				f.desired,
				{ ...f.reference, name: "original-secret" },
				f.secretUid,
				f.creation,
			),
		).rejects.toMatchObject({ code: "policy" });
		expect(remove).not.toHaveBeenCalled();
	});
});
