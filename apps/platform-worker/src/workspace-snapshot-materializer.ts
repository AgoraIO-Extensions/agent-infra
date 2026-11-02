import type {
	V1Container,
	V1EmptyDirVolumeSource,
	V1PodSpec,
	V1Volume,
	V1VolumeMount,
} from "@kubernetes/client-node";

export interface WorkspaceSnapshotMaterializerInputV1 {
	readonly snapshotId: string;
	readonly name: string;
	readonly digest: string;
	readonly sizeBytes: number;
	readonly objectRef: string;
	readonly signedUrl: string;
	readonly expiresAt: string;
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
	readonly manifest: string;
}

const volumeName = "workspace-snapshots";
const credentialsVolumeName = "workspace-snapshot-credentials";
const materializerMount = "/materialized";
const manifestPath = "/run/workspace-snapshots/manifest.json";

function assertSignedUrl(input: WorkspaceSnapshotMaterializerInputV1) {
	if (!input.objectRef || input.sizeBytes <= 0)
		throw new Error("workspace snapshot object metadata is incomplete");
	let expiresAt: number;
	try {
		const url = new URL(input.signedUrl);
		if (url.protocol !== "https:" || url.username || url.password)
			throw new Error();
		expiresAt = Date.parse(input.expiresAt);
	} catch {
		throw new Error("workspace snapshot signed URL is invalid");
	}
	if (
		!Number.isFinite(expiresAt) ||
		expiresAt <= Date.now() ||
		expiresAt > Date.now() + 15 * 60_000
	)
		throw new Error("workspace snapshot signed URL has an invalid expiry");
}

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
		assertSignedUrl(snapshot);
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
	const manifest = JSON.stringify({
		schemaVersion: 1,
		snapshots: snapshots.map((snapshot) => ({
			snapshotId: snapshot.snapshotId,
			name: snapshot.name,
			digest: snapshot.digest,
			sizeBytes: snapshot.sizeBytes,
			objectRef: snapshot.objectRef,
			signedUrl: snapshot.signedUrl,
			expiresAt: snapshot.expiresAt,
		})),
	});
	return {
		volumes: [
			{ name: volumeName, emptyDir },
			{
				name: credentialsVolumeName,
				secret: {
					secretName: policy.credentialSecretName,
					optional: false,
					items: [{ key: "manifest.json", path: "manifest.json" }],
				},
			},
		],
		initContainers: [
			{
				name: "workspace-snapshot-materializer",
				image: policy.imageDigest,
				imagePullPolicy: "IfNotPresent",
				command: ["/bin/materialize"],
				args: [`--manifest=${manifestPath}`],
				volumeMounts: [
					{ name: volumeName, mountPath: materializerMount },
					{
						name: credentialsVolumeName,
						mountPath: "/run/workspace-snapshots",
						readOnly: true,
					},
				],
			},
		],
		containerMounts: mounts,
		manifest,
	};
}

/** Apply the platform projection to an existing trusted PodSpec. */
export function applyWorkspaceSnapshotProjectionV1(
	spec: V1PodSpec,
	projection: WorkspaceSnapshotPodProjectionV1,
): V1PodSpec {
	if (!projection.containerMounts.size) return spec;
	const existingVolumes = new Set(
		(spec.volumes ?? []).map((volume) => volume.name),
	);
	for (const volume of projection.volumes) {
		if (existingVolumes.has(volume.name))
			throw new Error(
				"workspace snapshot volume collides with workload volume",
			);
		existingVolumes.add(volume.name);
	}
	const existingInitNames = new Set(
		(spec.initContainers ?? []).map((container) => container.name),
	);
	for (const init of projection.initContainers) {
		if (existingInitNames.has(init.name))
			throw new Error(
				"workspace snapshot init container collides with workload init",
			);
		existingInitNames.add(init.name);
	}
	const mounts = [...projection.containerMounts.values()].flat();
	return {
		...spec,
		initContainers: [
			...(spec.initContainers ?? []),
			...projection.initContainers,
		],
		volumes: [...(spec.volumes ?? []), ...projection.volumes],
		containers: spec.containers.map((container) => {
			if (
				mounts.some((mount) =>
					(container.volumeMounts ?? []).some(
						(existing) =>
							existing.mountPath === mount.mountPath ||
							existing.name === mount.name,
					),
				)
			)
				throw new Error(
					"workspace snapshot mount collides with workload mount",
				);
			return {
				...container,
				volumeMounts: [...(container.volumeMounts ?? []), ...mounts],
			};
		}),
	};
}

/** Fail closed when a live Pod loses any platform-owned snapshot materialization shape. */
export function workspaceSnapshotPodSpecMatchesV1(
	spec: V1PodSpec | undefined,
	projection: WorkspaceSnapshotPodProjectionV1,
): boolean {
	if (!spec) return false;
	for (const expected of projection.initContainers) {
		const actual = (spec.initContainers ?? []).find(
			(container) => container.name === expected.name,
		);
		if (!actual || JSON.stringify(actual) !== JSON.stringify(expected))
			return false;
	}
	const volumes = new Map(
		(spec.volumes ?? []).map((volume) => [volume.name, volume]),
	);
	for (const expected of projection.volumes) {
		if (JSON.stringify(volumes.get(expected.name)) !== JSON.stringify(expected))
			return false;
	}
	for (const container of spec.containers) {
		for (const mounts of projection.containerMounts.values()) {
			for (const mount of mounts) {
				const actual = (container.volumeMounts ?? []).find(
					(candidate) =>
						candidate.name === mount.name &&
						candidate.mountPath === mount.mountPath,
				);
				if (actual?.readOnly !== true || actual?.subPath !== mount.subPath)
					return false;
			}
		}
	}
	return true;
}
