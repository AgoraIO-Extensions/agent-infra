import { isDeepStrictEqual } from "node:util";
import type {
	V1Container,
	V1EmptyDirVolumeSource,
	V1PodSpec,
	V1Volume,
	V1VolumeMount,
} from "@kubernetes/client-node";
import { immutableImagePullPolicyMatches } from "./immutable-image-pull-policy.js";

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
	readonly allowedOrigins: readonly string[];
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

export function projectWorkspaceSnapshotPodShapeV1(
	snapshots: readonly Omit<
		WorkspaceSnapshotMaterializerInputV1,
		"signedUrl" | "expiresAt"
	>[],
	policy: WorkspaceSnapshotMaterializerPolicyV1,
): Omit<WorkspaceSnapshotPodProjectionV1, "manifest"> {
	if (
		!/^([a-z0-9.-]+(?::[0-9]+)?\/)[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(
			policy.imageDigest,
		)
	)
		throw new Error("workspace snapshot materializer image must be immutable");
	if (!policy.credentialSecretName || !policy.cacheSizeLimit)
		throw new Error("workspace snapshot materializer policy is incomplete");
	const names = new Set<string>();
	const mounts = new Map<string, readonly V1VolumeMount[]>();
	for (const snapshot of snapshots) {
		if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(snapshot.name))
			throw new Error("workspace snapshot name is invalid");
		if (names.has(snapshot.name))
			throw new Error("workspace snapshot names must be unique");
		names.add(snapshot.name);
		if (!/^sha256:[a-f0-9]{64}$/.test(snapshot.digest))
			throw new Error("workspace snapshot digest is invalid");
		if (
			!snapshot.objectRef ||
			!Number.isSafeInteger(snapshot.sizeBytes) ||
			snapshot.sizeBytes <= 0
		)
			throw new Error("workspace snapshot object metadata is incomplete");
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
				command: ["node", "/app/dist/workspaceSnapshotInit.mjs"],
				securityContext: {
					runAsNonRoot: true,
					runAsUser: 1000,
					runAsGroup: 1000,
					readOnlyRootFilesystem: true,
					allowPrivilegeEscalation: false,
					capabilities: { drop: ["ALL"] },
					seccompProfile: { type: "RuntimeDefault" },
				},
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
	};
}

export function projectWorkspaceSnapshotMaterializerV1(
	snapshots: readonly WorkspaceSnapshotMaterializerInputV1[],
	policy: WorkspaceSnapshotMaterializerPolicyV1,
): WorkspaceSnapshotPodProjectionV1 {
	for (const snapshot of snapshots) {
		assertSignedUrl(snapshot);
		if (!policy.allowedOrigins.includes(new URL(snapshot.signedUrl).origin))
			throw new Error("workspace snapshot origin is not approved");
	}
	const manifest = JSON.stringify({
		schemaVersion: 1,
		allowedOrigins: [...policy.allowedOrigins],
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
	return { ...projectWorkspaceSnapshotPodShapeV1(snapshots, policy), manifest };
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

function sameWire(left: unknown, right: unknown) {
	return isDeepStrictEqual(
		JSON.parse(JSON.stringify(left)),
		JSON.parse(JSON.stringify(right)),
	);
}
function normalizedMount(mount: V1VolumeMount) {
	return {
		...mount,
		readOnly: mount.readOnly ?? false,
		subPath: mount.subPath ?? "",
		subPathExpr: mount.subPathExpr ?? "",
		mountPropagation: mount.mountPropagation ?? "None",
		recursiveReadOnly: mount.recursiveReadOnly ?? "Disabled",
	};
}
function normalizedContainer(container: V1Container) {
	return {
		...container,
		args: container.args ?? [],
		env: container.env ?? [],
		envFrom: container.envFrom ?? [],
		ports: container.ports ?? [],
		resources: container.resources ?? {},
		terminationMessagePath:
			container.terminationMessagePath ?? "/dev/termination-log",
		terminationMessagePolicy: container.terminationMessagePolicy ?? "File",
		volumeMounts: (container.volumeMounts ?? []).map(normalizedMount),
	};
}
function normalizedVolume(volume: V1Volume) {
	return {
		...volume,
		...(volume.secret
			? {
					secret: {
						...volume.secret,
						optional: volume.secret.optional ?? false,
						defaultMode: volume.secret.defaultMode ?? 420,
					},
				}
			: {}),
		...(volume.emptyDir
			? {
					emptyDir: {
						...volume.emptyDir,
						medium: volume.emptyDir.medium ?? "",
					},
				}
			: {}),
	};
}
/** Compare the complete trusted projection, including Kubernetes API defaults. */
export function workspaceSnapshotPodSpecMatchesV1(
	spec: V1PodSpec | undefined,
	projection: WorkspaceSnapshotPodProjectionV1,
): boolean {
	if (!spec) return false;
	for (const expected of projection.initContainers) {
		const actual = (spec.initContainers ?? []).filter(
			(x) => x.name === expected.name,
		);
		if (
			actual.length !== 1 ||
			!actual[0] ||
			!immutableImagePullPolicyMatches(actual[0], expected) ||
			!sameWire(
				normalizedContainer({
					...actual[0],
					imagePullPolicy: expected.imagePullPolicy,
				}),
				normalizedContainer(expected),
			)
		)
			return false;
	}
	for (const expected of projection.volumes) {
		const actual = (spec.volumes ?? []).filter((x) => x.name === expected.name);
		if (
			actual.length !== 1 ||
			!sameWire(normalizedVolume(actual[0]!), normalizedVolume(expected))
		)
			return false;
	}
	for (const container of spec.containers)
		for (const mount of [...projection.containerMounts.values()].flat()) {
			const actual = (container.volumeMounts ?? []).filter(
				(x) => x.name === mount.name && x.mountPath === mount.mountPath,
			);
			if (
				actual.length !== 1 ||
				!sameWire(normalizedMount(actual[0]!), normalizedMount(mount))
			)
				return false;
		}
	return true;
}
/** Validate platform additions before checking the remaining Pod with the existing policy. */
export function withoutVerifiedWorkspaceSnapshotProjectionV1(
	spec: V1PodSpec | undefined,
	projection: WorkspaceSnapshotPodProjectionV1 | undefined,
): V1PodSpec | undefined {
	if (!projection) return spec;
	if (!spec || !workspaceSnapshotPodSpecMatchesV1(spec, projection))
		return undefined;
	const initNames = new Set(projection.initContainers.map((x) => x.name));
	const volumeNames = new Set(projection.volumes.map((x) => x.name));
	const mounts = [...projection.containerMounts.values()].flat();
	return {
		...spec,
		initContainers: (spec.initContainers ?? []).filter(
			(x) => !initNames.has(x.name),
		),
		volumes: (spec.volumes ?? []).filter((x) => !volumeNames.has(x.name)),
		containers: spec.containers.map((c) => ({
			...c,
			volumeMounts: (c.volumeMounts ?? []).filter(
				(x) =>
					!mounts.some((m) => m.name === x.name && m.mountPath === x.mountPath),
			),
		})),
	};
}
