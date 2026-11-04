import type { V1ObjectMeta, V1Secret } from "@kubernetes/client-node";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
} from "./kubernetes-client.js";
import type { WorkspaceSnapshotPodProjectionV1 } from "./workspace-snapshot-materializer.js";

/** Short-lived signing material is written only to the deployment's namespace. */
export async function writeWorkspaceSnapshotSecretV1(
	client: WorkerKubernetesClientV1,
	projection: WorkspaceSnapshotPodProjectionV1,
	metadata: V1ObjectMeta,
) {
	const name = projection.volumes.find(
		(v) => v.name === "workspace-snapshot-credentials",
	)?.secret?.secretName;
	if (
		!name ||
		!projection.manifest ||
		(metadata.namespace !== undefined &&
			metadata.namespace !== client.namespace)
	)
		throw new WorkloadKubernetesError("policy");
	const current = await client.read<V1Secret>("Secret", name);
	const ownerKey = "agent-infra.agora.io/agent-id";
	if (!metadata.annotations?.[ownerKey])
		throw new WorkloadKubernetesError("policy");
	if (
		current &&
		(current.immutable ||
			current.metadata?.namespace !== client.namespace ||
			current.metadata?.annotations?.[ownerKey] !==
				metadata.annotations[ownerKey])
	)
		throw new WorkloadKubernetesError("conflict");
	const secret: V1Secret = {
		apiVersion: "v1",
		kind: "Secret",
		metadata: {
			...current?.metadata,
			...metadata,
			annotations: {
				...current?.metadata?.annotations,
				...metadata.annotations,
			},
			labels: { ...current?.metadata?.labels, ...metadata.labels },
			name,
			namespace: client.namespace,
			resourceVersion: current?.metadata?.resourceVersion,
		},
		type: "Opaque",
		stringData: { "manifest.json": projection.manifest },
	};
	if (current) await client.replace(secret);
	else await client.create(secret);
}
