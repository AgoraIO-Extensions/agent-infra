import type {
	V1Container,
	V1EmptyDirVolumeSource,
	V1Volume,
	V1VolumeMount,
} from "@kubernetes/client-node";

export interface WorkspaceSnapshotMaterializerInputV1 {
	readonly snapshotId: string;
	readonly name: string;
	readonly digest: string;
	readonly sizeBytes: number;
}

export interface WorkspaceSnapshotMaterializerPolicyV1 {
	readonly imageDigest: string;
	readonly cacheSizeLimit: string;
	readonly credentialSecretName: string;
}

export interface WorkspaceSnapshotPodProjectionV1 {
	readonly volumes: readonly V1Volume[];
	readonly initContainers: readonly V1Container[];
	readonly containerMounts: ReadonlyMap<string, readonly V1VolumeMount[]>;
}

const volumeName = "workspace-snapshots";
const materializerMount = "/materialized";

export function projectWorkspaceSnapshotMaterializerV1(
	snapshots: readonly WorkspaceSnapshotMaterializerInputV1[],
	policy: WorkspaceSnapshotMaterializerPolicyV1,
): WorkspaceSnapshotPodProjectionV1 {
	if (!/^sha256:[a-f0-9]{64}$/.test(policy.imageDigest))
		throw new Error("workspace snapshot materializer image must be immutable");
	if (!policy.credentialSecretName || !policy.cacheSizeLimit)
		throw new Error("workspace snapshot materializer policy is incomplete");
	const names = new Set<string>();
	const mounts = new Map<string, readonly V1VolumeMount[]>();
	for (const snapshot of snapshots) {
		if (names.has(snapshot.name))
			throw new Error("workspace snapshot names must be unique");
		names.add(snapshot.name);
		if (!/^sha256:[a-f0-9]{64}$/.test(snapshot.digest))
			throw new Error("workspace snapshot digest is invalid");
		const path = `/opt/agent/workspaces/${snapshot.name}`;
		mounts.set(snapshot.name, [
			{
				name: volumeName,
				mountPath: path,
				subPath: snapshot.name,
				readOnly: true,
			},
		]);
	}
	const emptyDir: V1EmptyDirVolumeSource = { sizeLimit: policy.cacheSizeLimit };
	return {
		volumes: [
			{ name: volumeName, emptyDir },
			{
				name: "workspace-snapshot-credentials",
				secret: { secretName: policy.credentialSecretName, optional: false },
			},
		],
		initContainers: [
			{
				name: "workspace-snapshot-materializer",
				image: policy.imageDigest,
				imagePullPolicy: "IfNotPresent",
				command: ["/bin/materialize"],
				args: ["--manifest=/run/workspace-snapshots/manifest.json"],
				volumeMounts: [
					{ name: volumeName, mountPath: materializerMount },
					{
						name: "workspace-snapshot-credentials",
						mountPath: "/run/workspace-snapshots",
						readOnly: true,
					},
				],
			},
		],
		containerMounts: mounts,
	};
}
