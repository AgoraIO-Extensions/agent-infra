import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type RuntimeSkillHubBindingV1,
	RuntimeSkillHubBindingV1Schema,
} from "@agent-infra/contracts/runtime";
import type { V1Secret } from "@kubernetes/client-node";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
} from "./kubernetes-client.js";
import type { WorkspaceSnapshotPodProjectionV1 } from "./workspace-snapshot-materializer.js";

export const skillHubDeliveryMaximumBytesV1 = 512 * 1024;
const sha = (value: Uint8Array | string) =>
	createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

/** One private assembly root per Agent; identifiers never become path components. */
export function skillHubAgentAssemblyRootV1(root: string, agentId: string) {
	if (
		!root.startsWith("/") ||
		resolve(root) !== root ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId)
	)
		throw new WorkloadKubernetesError("policy");
	return join(root, sha(agentId));
}

export function skillHubDeliveryManifestV1(input: RuntimeSkillHubBindingV1) {
	const binding = RuntimeSkillHubBindingV1Schema.parse(input);
	const skills = [...binding.projections].sort((a, b) =>
		a.manifest.name < b.manifest.name
			? -1
			: a.manifest.name > b.manifest.name
				? 1
				: 0,
	);
	const index = Buffer.from(
		[
			"# Skills",
			"",
			...skills.map(
				(skill) =>
					`- ${skill.manifest.name}@${skill.skillVersion.version} (${skill.skillVersion.packageDigest})`,
			),
			"",
		].join("\n"),
	);
	const files = [
		{ path: "SKILLS.md", sizeBytes: index.length, sha256: sha(index) },
		...skills.flatMap((skill) =>
			skill.manifest.files.map((file) => ({
				...file,
				path: `skills/${skill.manifest.name}/${file.path}`,
			})),
		),
	].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	if (
		files.length > 2001 ||
		new Set(files.map((file) => file.path)).size !== files.length ||
		files.reduce((total, file) => total + file.sizeBytes, 0) >
			skillHubDeliveryMaximumBytesV1
	)
		throw new WorkloadKubernetesError("policy");
	return {
		schemaVersion: 1 as const,
		agentId: binding.agentId,
		agentVersion: binding.agentVersion,
		configurationRevision: binding.configurationRevision,
		generationId: binding.generationId,
		files: files.map((file, i) => ({ key: `file-${i}`, ...file })),
	};
}

export function skillHubDeliveryIdentityV1(binding: RuntimeSkillHubBindingV1) {
	const manifest = skillHubDeliveryManifestV1(binding);
	const digest = sha(encode(manifest));
	return { manifest, digest, name: `skill-${digest.slice(0, 56)}` };
}

function validateData(
	binding: RuntimeSkillHubBindingV1,
	data: V1Secret["data"],
) {
	const { manifest } = skillHubDeliveryIdentityV1(binding);
	if (
		!data ||
		Object.keys(data).length !== manifest.files.length + 1 ||
		data["manifest.json"] !== encode(manifest).toString("base64") ||
		Buffer.byteLength(JSON.stringify(data)) > 900_000
	)
		throw new WorkloadKubernetesError("conflict");
	for (const file of manifest.files) {
		const encoded = data[file.key];
		if (typeof encoded !== "string")
			throw new WorkloadKubernetesError("conflict");
		const bytes = Buffer.from(encoded, "base64");
		if (
			bytes.toString("base64") !== encoded ||
			bytes.length !== file.sizeBytes ||
			sha(bytes) !== file.sha256
		)
			throw new WorkloadKubernetesError("conflict");
	}
}

/** Revalidate the immutable, Agent-scoped delivery before preparing a Runtime. */
export async function readSkillHubDeliveryV1(
	client: WorkerKubernetesClientV1,
	binding: RuntimeSkillHubBindingV1,
) {
	const { name, digest } = skillHubDeliveryIdentityV1(binding);
	const current = await client.read<V1Secret>("Secret", name);
	if (!current) return null;
	if (
		current.immutable !== true ||
		!current.metadata?.uid ||
		!current.metadata.resourceVersion ||
		current.metadata.name !== name ||
		current.metadata.namespace !== client.namespace ||
		current.metadata.deletionTimestamp ||
		current.type !== "Opaque" ||
		current.metadata.annotations?.["agent-infra.agora.io/agent-id"] !==
			binding.agentId ||
		current.metadata.annotations?.["agent-infra.agora.io/skill-delivery"] !==
			digest
	)
		throw new WorkloadKubernetesError("conflict");
	validateData(binding, current.data);
	return current;
}

/** Deliver already verified files before Store can record the materialization receipt. */
export async function writeSkillHubDeliveryV1(
	client: WorkerKubernetesClientV1,
	binding: RuntimeSkillHubBindingV1,
	assemblyRoot: string,
) {
	const { name, digest, manifest } = skillHubDeliveryIdentityV1(binding);
	const root = join(
		assemblyRoot,
		"generations",
		binding.generationId,
		".agents",
	);
	const data: Record<string, string> = {
		"manifest.json": encode(manifest).toString("base64"),
	};
	for (const file of manifest.files) {
		let parent = root;
		for (const part of file.path.split("/").slice(0, -1)) {
			const info = await lstat(parent);
			if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o222)
				throw new WorkloadKubernetesError("conflict");
			parent = join(parent, part);
		}
		const info = await lstat(parent);
		if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o222)
			throw new WorkloadKubernetesError("conflict");
		const handle = await open(
			join(root, file.path),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const before = await handle.stat();
			if (
				!before.isFile() ||
				before.nlink !== 1 ||
				before.mode & 0o222 ||
				before.size !== file.sizeBytes
			)
				throw new WorkloadKubernetesError("conflict");
			const bytes = await handle.readFile();
			if (bytes.length !== file.sizeBytes || sha(bytes) !== file.sha256)
				throw new WorkloadKubernetesError("conflict");
			data[file.key] = bytes.toString("base64");
		} finally {
			await handle.close();
		}
	}
	validateData(binding, data);
	const current = await readSkillHubDeliveryV1(client, binding);
	if (current) {
		if (!isDeepStrictEqual(current.data, data))
			throw new WorkloadKubernetesError("conflict");
		return;
	}
	await client.create<V1Secret>({
		apiVersion: "v1",
		kind: "Secret",
		metadata: {
			name,
			namespace: client.namespace,
			labels: { "agent-infra.agora.io/managed": "skill-generation-v1" },
			annotations: {
				"agent-infra.agora.io/agent-id": binding.agentId,
				"agent-infra.agora.io/skill-delivery": digest,
			},
		},
		type: "Opaque",
		immutable: true,
		data,
	});
	if (!(await readSkillHubDeliveryV1(client, binding)))
		throw new WorkloadKubernetesError("unavailable");
}

/** The init container alone sees transport bytes; Runtime gets sealed regular files. */
export function skillHubDeliveryProjectionV1(
	binding: RuntimeSkillHubBindingV1 | undefined,
	image: string | undefined,
): WorkspaceSnapshotPodProjectionV1 | undefined {
	if (
		image !== undefined &&
		!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image)
	)
		throw new WorkloadKubernetesError("policy");
	if (!image || !binding) return undefined;
	const { name, digest } = skillHubDeliveryIdentityV1(binding);
	return {
		manifest: "",
		volumes: [
			{ name: "skill-files", emptyDir: { medium: "Memory", sizeLimit: "2Mi" } },
			{
				name: "skill-package",
				secret: { secretName: name, defaultMode: 0o444, optional: false },
			},
		],
		initContainers: [
			{
				name: "skill-materializer",
				image,
				imagePullPolicy: "IfNotPresent",
				command: ["node", "/app/dist/skillHubInit.mjs"],
				args: [digest],
				resources: {
					requests: { cpu: "100m", memory: "64Mi" },
					limits: { cpu: "500m", memory: "128Mi" },
				},
				securityContext: {
					runAsUser: 1001,
					runAsGroup: 1000,
					runAsNonRoot: true,
					allowPrivilegeEscalation: false,
					readOnlyRootFilesystem: true,
					capabilities: { drop: ["ALL"] },
					seccompProfile: { type: "RuntimeDefault" },
				},
				volumeMounts: [
					{
						name: "skill-package",
						mountPath: "/run/skill-hub",
						readOnly: true,
					},
					{ name: "skill-files", mountPath: "/materialized" },
				],
			},
		],
		containerMounts: new Map([
			[
				"skills",
				[
					{
						name: "skill-files",
						mountPath: "/opt/agent-infra-skill-hub/.agents",
						subPath: ".agents",
						readOnly: true,
					},
				],
			],
		]),
	};
}
