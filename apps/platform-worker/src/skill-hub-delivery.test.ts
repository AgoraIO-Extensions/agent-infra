import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppliedRuntimeSkillDirectoryV1 } from "@agent-infra/agent-runtime";
import type { SkillHubSyncBindingV1 } from "@agent-infra/contracts";
import { RuntimeSkillHubBindingV1Schema } from "@agent-infra/contracts/runtime";
import type { V1Pod, V1Secret, V1StatefulSet } from "@kubernetes/client-node";
import { afterEach, expect, it, vi } from "vitest";
import { publicationFixture } from "../../../packages/object-storage/src/skill-package-consumer.fixture.js";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import { skillHubRuntimeBindingV1 } from "./kubernetes-runtime-skill-mount.js";
import {
	readSkillHubDeliveryV1,
	skillHubAgentAssemblyRootV1,
	skillHubDeliveryIdentityV1,
	skillHubDeliveryProjectionV1,
} from "./skill-hub-delivery.js";
import { materializeSkillHubDeliveryV1 } from "./skill-hub-init.js";
import { createDeploymentSkillHubMaterializerFactoryV1 } from "./skill-materializer-production-assembly.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await writable(root);
		await rm(root, { recursive: true, force: true });
	}
});
async function writable(root: string) {
	const { readdir } = await import("node:fs/promises");
	await chmod(root, 0o700).catch(() => {});
	for (const entry of await readdir(root, { withFileTypes: true }).catch(
		() => [],
	))
		if (entry.isDirectory()) await writable(join(root, entry.name));
}
async function directory() {
	const root = await mkdtemp(join(tmpdir(), "skill-delivery-"));
	roots.push(root);
	return root;
}
const initImage = `registry.example.test/platform-worker@sha256:${"a".repeat(64)}`;

async function setup() {
	const root = await directory();
	const f = fixture();
	const publication = await publicationFixture();
	const {
		name: skillName,
		visibility: _visibility,
		admissionDecision: _admissionDecision,
		...ref
	} = publication.version;
	const receipt = vi.fn(async (value) => value);
	const factory = createDeploymentSkillHubMaterializerFactoryV1({
		...publication.options,
		assemblyRoot: root,
		runtimeUid: process.geteuid?.() === 65534 ? 65533 : 65534,
		agentVersion: "agent-version-1",
		actor: { actorId: "owner-a", organizationIds: [], isAdministrator: false },
		delivery: { client: f.client },
		store: {
			readPublication: publication.options.readPublication,
			recordAppliedReceipt: receipt,
			resolveSyncBindings: async (
				input,
			): Promise<readonly SkillHubSyncBindingV1[]> => [
				{
					schemaVersion: 1,
					agentId: input.agentId,
					agentVersion: "agent-version-1",
					skillName,
					skillVersion: ref,
					grant: {
						schemaVersion: 1,
						tools: [],
						connections: [],
						fileRoots: [],
						networkOrigins: [],
						scripts: false,
					},
					configurationRevision: input.configurationRevision,
					syncRevision: 1,
					state: "pending_sync",
					failureReason: null,
					appliedReceipt: null,
				},
			],
		},
	});
	if (!factory) throw new Error("factory unavailable");
	const worker = await factory({
		databaseUrl: "unused",
		signal: new AbortController().signal,
	});
	const materialize = async (agentId = "agent-a") => {
		const desired = workloadDesiredFixture();
		const result = await worker.materialize({
			agentId,
			configurationRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			fence: desired.fence,
		});
		return {
			...desired,
			agentId,
			skills: [...result.skills],
			skillGenerationId: result.generationId,
			skillAppliedBindings: JSON.stringify(result.appliedBindings),
		};
	};
	return { root, f, materialize, receipt };
}

it("delivers verified generation bytes before Applied and isolates two Agent roots", async () => {
	const { root, f, materialize, receipt } = await setup();
	receipt.mockImplementation(async (value) => {
		expect(
			[...f.resources.values()].filter(
				(x) => x.kind === "Secret" && (x as V1Secret).immutable,
			),
		).not.toHaveLength(0);
		return value;
	});
	const desired = await materialize();
	const binding = skillHubRuntimeBindingV1(desired);
	if (!binding) throw new Error();
	expect(await readSkillHubDeliveryV1(f.client, binding)).not.toBeNull();
	const other = skillHubRuntimeBindingV1(await materialize("agent-b"));
	if (!other) throw new Error();
	expect(skillHubDeliveryIdentityV1(binding).name).not.toBe(
		skillHubDeliveryIdentityV1(other).name,
	);
	expect(
		await lstat(skillHubAgentAssemblyRootV1(root, "agent-a")),
	).toBeDefined();
	expect(
		await lstat(skillHubAgentAssemblyRootV1(root, "agent-b")),
	).toBeDefined();
	expect(receipt).toHaveBeenCalledTimes(2);
});

it("does not record Applied when delivery fails", async () => {
	const { f, materialize, receipt } = await setup();
	vi.spyOn(f.client, "create").mockRejectedValue(new Error("unavailable"));
	await expect(materialize()).rejects.toThrow();
	expect(receipt).not.toHaveBeenCalled();
});

it("rejects replaced, mutable, foreign and corrupted delivery objects", async () => {
	const { f, materialize } = await setup();
	const binding = skillHubRuntimeBindingV1(await materialize());
	if (!binding) throw new Error();
	const { name } = skillHubDeliveryIdentityV1(binding);
	const original = await f.client.read<V1Secret>("Secret", name);
	if (!original?.metadata || !original.data) throw new Error();
	for (const mutation of [
		{ ...original, immutable: false },
		{
			...original,
			metadata: {
				...original.metadata,
				annotations: {
					...original.metadata.annotations,
					"agent-infra.agora.io/agent-id": "other-agent",
				},
			},
		},
		{
			...original,
			data: {
				...original.data,
				"file-0": Buffer.from("modified").toString("base64"),
			},
		},
	]) {
		f.resources.set(`Secret/${name}`, mutation);
		await expect(readSkillHubDeliveryV1(f.client, binding)).rejects.toThrow();
	}
	f.resources.set(`Secret/${name}`, original);
});

it("init copies ordinary sealed files, verifies retries and rejects tampered bytes", async () => {
	const { f, materialize } = await setup();
	const binding = skillHubRuntimeBindingV1(await materialize());
	if (!binding) throw new Error();
	const { name, digest, manifest } = skillHubDeliveryIdentityV1(binding);
	const secret = await f.client.read<V1Secret>("Secret", name);
	const source = await directory();
	const target = await directory();
	for (const [key, value] of Object.entries(secret?.data ?? {}))
		await writeFile(join(source, key), Buffer.from(value, "base64"));
	await materializeSkillHubDeliveryV1(source, target, digest);
	await materializeSkillHubDeliveryV1(source, target, digest);
	for (const file of manifest.files) {
		const path = join(target, ".agents", file.path);
		expect((await lstat(path)).isSymbolicLink()).toBe(false);
		expect((await lstat(path)).mode & 0o222).toBe(0);
		expect(
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
		).toBe(file.sha256);
	}
	await chmod(target, 0o555);
	const nativeRoot = await realpath(target);
	const runtimeDirectory = createAppliedRuntimeSkillDirectoryV1({
		...binding,
		root: nativeRoot,
	});
	expect(runtimeDirectory.nativeSkillPaths?.()).toEqual([
		join(nativeRoot, ".agents/skills/fixture/SKILL.md"),
	]);
	await writeFile(join(source, "file-0"), "tampered");
	await expect(
		materializeSkillHubDeliveryV1(source, await directory(), digest),
	).rejects.toThrow();
	await expect(
		materializeSkillHubDeliveryV1(source, await directory(), "0".repeat(64)),
	).rejects.toThrow();
});

it("init rejects a traversal manifest before creating any destination file", async () => {
	const { materialize } = await setup();
	const binding = skillHubRuntimeBindingV1(await materialize());
	if (!binding) throw new Error();
	const source = await directory();
	const target = await directory();
	const { manifest } = skillHubDeliveryIdentityV1(binding);
	const file = manifest.files[0];
	if (!file) throw new Error();
	file.path = "../outside";
	const bytes = Buffer.from(JSON.stringify(manifest));
	await writeFile(join(source, "manifest.json"), bytes);
	await expect(
		materializeSkillHubDeliveryV1(
			source,
			target,
			createHash("sha256").update(bytes).digest("hex"),
		),
	).rejects.toThrow();
	const { readdir } = await import("node:fs/promises");
	expect(await readdir(target)).toEqual([]);
});

it("renders stable Workload init mounts without changing its writable PVC subpath", async () => {
	const { f, materialize } = await setup();
	const desired = { ...(await materialize()), skillDeliveryImage: initImage };
	const adapter = createKubernetesRuntimeAdapterV1({
		client: f.client,
		policy: { ...workloadTestPolicy, skillDeliveryImage: initImage },
		probe: f.probe,
	});
	const identity = await adapter.apply(desired);
	if (!identity || identity === "pending") throw new Error();
	expect(await adapter.observe(desired, identity)).toBe("healthy");
	const upgraded = createKubernetesRuntimeAdapterV1({
		client: f.client,
		policy: {
			...workloadTestPolicy,
			skillDeliveryImage: `registry.example.test/platform-worker@sha256:${"b".repeat(64)}`,
		},
		probe: f.probe,
	});
	expect(await upgraded.observe(desired, identity)).toBe("healthy");
	const reconciled = await adapter.reconcile({
		...desired,
		expectedWorkload: {
			state: "present",
			workloadUid: identity.uid,
			workloadGeneration: identity.generation,
		},
	});
	expect(reconciled.status).toBe("applied");
	if (reconciled.status === "applied")
		expect(reconciled.applied.skillDeliveryImage).toBe(initImage);
	const workload = await f.client.read<V1StatefulSet>(
		"StatefulSet",
		desired.service.name,
	);
	expect(workload?.spec?.template.spec?.initContainers?.[0]?.name).toBe(
		"skill-materializer",
	);
	expect(
		workload?.spec?.template.spec?.containers[0]?.volumeMounts?.find(
			(x) => x.mountPath === "/workspace",
		)?.subPath,
	).toBeUndefined();
	const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
	if (!pod?.spec?.initContainers?.[0]) throw new Error();
	pod.spec.initContainers[0].image = "untrusted:latest";
	f.resources.set(`Pod/${desired.service.name}-0`, pod);
	expect(await adapter.observe(desired, identity)).toBe("drifted");
});

it("preserves the PVC delivery of a legacy Workload after enabling the new deployment mode", async () => {
	const { f, materialize } = await setup();
	const desired = await materialize();
	const adapter = createKubernetesRuntimeAdapterV1({
		client: f.client,
		policy: { ...workloadTestPolicy, skillDeliveryImage: initImage },
		probe: f.probe,
	});
	const identity = await adapter.apply(desired);
	if (!identity || identity === "pending") throw new Error();
	const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
	expect(pod?.spec?.initContainers ?? []).toEqual([]);
	expect(pod?.spec?.containers[0]?.volumeMounts).toContainEqual({
		name: "data",
		mountPath: "/opt/agent-infra-skill-hub/.agents",
		subPath: `generations/${desired.skillGenerationId}/.agents`,
		readOnly: true,
	});
	expect(await adapter.observe(desired, identity)).toBe("healthy");
});

it("rejects oversized delivery and mutable init images", async () => {
	const { materialize } = await setup();
	const original = skillHubRuntimeBindingV1(await materialize());
	if (!original) throw new Error();
	const oversized = structuredClone(original);
	const file = oversized.projections[0]?.manifest.files[0];
	if (!file) throw new Error();
	file.sizeBytes = 512 * 1024 + 1;
	expect(() =>
		skillHubDeliveryIdentityV1(RuntimeSkillHubBindingV1Schema.parse(oversized)),
	).toThrow();
	expect(() =>
		skillHubDeliveryProjectionV1(undefined, "worker:latest"),
	).toThrow();
});
