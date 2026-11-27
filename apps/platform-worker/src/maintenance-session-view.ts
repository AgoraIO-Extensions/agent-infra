import type { V1Job, V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { agentWorkloadPodPlacementV1 } from "./agent-workload-placement.js";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import {
	ensureMaintenanceResource,
	type MaintenanceWorkloadOptions,
	maintenanceWorkload,
} from "./maintenance-terminal-workload.js";
import { workloadResourceNameV1 } from "./workload-resource-name.js";

export const maintenanceViewClaim = (agentId: string) =>
	`${workloadResourceNameV1(agentId)}-views`;
export interface MaintenanceViewBinding {
	agentId: string;
	sessionId: string;
	sandboxId: string;
}
export function createSessionMaintenanceViews(
	client: WorkerKubernetesClientV1,
	settings: Omit<MaintenanceWorkloadOptions, "directoryId">,
	consumerImage: string,
	source: (scope: MaintenanceViewBinding) => Promise<string | null>,
) {
	const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
	function metadata(agentId: string, name: string) {
		return {
			namespace: client.namespace,
			name,
			labels: {
				"app.kubernetes.io/component": "agent-maintenance-view",
				"agent-infra.agora.io/maintenance-directory":
					workloadResourceNameV1(agentId),
			},
		};
	}
	async function reserve(agentId: string) {
		const claim: V1PersistentVolumeClaim = {
			apiVersion: "v1",
			kind: "PersistentVolumeClaim",
			metadata: metadata(agentId, maintenanceViewClaim(agentId)),
			spec: {
				storageClassName: settings.storageClass,
				accessModes: ["ReadWriteMany"],
				resources: { requests: { storage: "1Gi" } },
			},
		};
		const actual = await ensureMaintenanceResource(client, claim);
		if (
			actual.metadata?.deletionTimestamp ||
			actual.spec?.storageClassName !== settings.storageClass ||
			!actual.spec.accessModes?.includes("ReadWriteMany") ||
			actual.spec.dataSource ||
			actual.spec.dataSourceRef
		)
			throw new Error("Invalid maintenance view volume");
	}
	if (
		!consumerImage.includes("@sha256:") &&
		!/^sha256:[0-9a-f]{64}$/.test(consumerImage)
	)
		throw new Error("Invalid maintenance consumer digest");
	return {
		consumerImage,
		reserve,
		async bind(scope: MaintenanceViewBinding) {
			if (!uuid.test(scope.sandboxId))
				throw new Error("Invalid maintenance Sandbox");
			const directory = await source(scope);
			await reserve(scope.agentId);
			const name = `maint-view-${scope.sandboxId}`;
			const meta = metadata(scope.agentId, name);
			let sourceVolume:
				| {
						name: string;
						persistentVolumeClaim: { claimName: string; readOnly: true };
				  }
				| { name: string; emptyDir: Record<string, never> } = {
				name: "source",
				emptyDir: {},
			};
			if (directory) {
				const sourceClaim = maintenanceWorkload({
					...settings,
					directoryId: directory,
				}).claim;
				const actual = await ensureMaintenanceResource(client, sourceClaim);
				if (
					actual.spec?.storageClassName !== settings.storageClass ||
					actual.spec.dataSource ||
					actual.spec.dataSourceRef ||
					actual.metadata?.deletionTimestamp
				)
					throw new Error("Invalid deployment source");
				sourceVolume = {
					name: "source",
					persistentVolumeClaim: {
						claimName: `maint-${directory}`,
						readOnly: true,
					},
				};
			}
			const command = [
				"node",
				"/app/dist/maintenance-view.mjs",
				scope.sandboxId,
			];
			const job: V1Job = {
				apiVersion: "batch/v1",
				kind: "Job",
				metadata: meta,
				spec: {
					backoffLimit: 3,
					activeDeadlineSeconds: 180,
					template: {
						metadata: { labels: meta.labels },
						spec: {
							automountServiceAccountToken: false,
							enableServiceLinks: false,
							restartPolicy: "Never",
							...agentWorkloadPodPlacementV1(settings.placement),
							securityContext: {
								runAsNonRoot: true,
								runAsUser: 1000,
								runAsGroup: 1000,
								seccompProfile: { type: "RuntimeDefault" },
							},
							containers: [
								{
									name: "snapshot",
									image: settings.image,
									command,
									securityContext: {
										allowPrivilegeEscalation: false,
										readOnlyRootFilesystem: true,
										capabilities: { drop: ["ALL"] },
									},
									resources: {
										requests: { cpu: "100m", memory: "128Mi" },
										limits: { cpu: "1", memory: "256Mi" },
									},
									volumeMounts: [
										{ name: "source", mountPath: "/source", readOnly: true },
										{ name: "views", mountPath: "/views" },
									],
								},
							],
							volumes: [
								sourceVolume,
								{
									name: "views",
									persistentVolumeClaim: {
										claimName: maintenanceViewClaim(scope.agentId),
									},
								},
							],
						},
					},
				},
			};
			const actual = await ensureMaintenanceResource(client, job);
			const spec = actual.spec?.template.spec;
			if (
				spec?.automountServiceAccountToken !== false ||
				spec.containers.length !== 1 ||
				spec.initContainers?.length ||
				spec.containers[0]?.image !== settings.image ||
				JSON.stringify(spec.containers[0]?.command) !==
					JSON.stringify(command) ||
				spec.volumes?.length !== 2 ||
				!spec.volumes.some(
					(v) =>
						v.name === "views" &&
						v.persistentVolumeClaim?.claimName ===
							maintenanceViewClaim(scope.agentId),
				) ||
				!spec.volumes.some(
					(v) =>
						v.name === "source" &&
						(directory
							? v.persistentVolumeClaim?.claimName === `maint-${directory}` &&
								v.persistentVolumeClaim.readOnly === true
							: v.emptyDir != null),
				)
			)
				throw new Error("Invalid maintenance view binding");
			if (
				actual.status?.conditions?.some(
					(c) => c.type === "Failed" && c.status === "True",
				)
			)
				throw new Error("Maintenance view preparation failed");
			return (
				actual.status?.conditions?.some(
					(c) => c.type === "Complete" && c.status === "True",
				) === true
			);
		},
	};
}
