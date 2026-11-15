import { isDeepStrictEqual } from "node:util";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	type StandardTemplateModelBindingV1,
	validateRuntimeModelProjectionV4,
	validateStandardTemplateModelBindingsV1,
} from "@agent-infra/model-catalog";
import type { V1PodSpec } from "@kubernetes/client-node";
import type { KubernetesWorkloadPolicyV1 } from "./kubernetes-runtime-adapter.js";
import {
	workloadImagePullSpecV1,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";
import { skillHubRuntimeBindingV1 } from "./kubernetes-runtime-skill-mount.js";
import {
	isMultiService,
	multiServiceWorkloadImageProjectionV1,
} from "./multi-service-runtime.js";
import { skillHubDeliveryProjectionV1 } from "./skill-hub-delivery.js";
import { workloadPodImagesV1 } from "./workload-image-projection.js";
import { requireWorkspaceSnapshotEgressV1 } from "./workload-network.js";
import {
	applyWorkspaceSnapshotProjectionV1,
	type WorkspaceSnapshotPodProjectionV1,
	workspaceSnapshotWorkloadProjectionV1,
} from "./workspace-snapshot-materializer.js";

/**
 * Expected parent resources only. Caller binds Desired/policy to current or retained Store CAS.
 * No Session, live-image attestation or Adapter/client calls.
 */
export function parentWorkloadImageProjectionV1(input: {
	readonly desired: unknown;
	readonly sourceKind: "standard" | "custom";
	readonly policy?: KubernetesWorkloadPolicyV1;
	readonly modelProjection?: unknown;
	readonly standardTemplateBinding?: StandardTemplateModelBindingV1;
	readonly workspaceSnapshotProjection?: WorkspaceSnapshotPodProjectionV1;
}) {
	const value = validateAgentWorkloadDesiredV1(input.desired);
	if (input.sourceKind !== "standard" && input.sourceKind !== "custom")
		throw new Error("WORKLOAD_IMAGE_BINDING_MISMATCH");
	if (value.workspaceSnapshots?.length && !input.workspaceSnapshotProjection)
		throw new Error("WORKLOAD_SNAPSHOT_PROJECTION_REQUIRED");
	const names = (value.workspaceSnapshots ?? [])
		.map((snapshot) => snapshot.name)
		.sort();
	const projectedNames = [
		...(input.workspaceSnapshotProjection?.containerMounts.keys() ?? []),
	].sort();
	if (!isDeepStrictEqual(names, projectedNames))
		throw new Error("WORKLOAD_SNAPSHOT_PROJECTION_REQUIRED");
	if (input.workspaceSnapshotProjection)
		requireWorkspaceSnapshotEgressV1(input.policy?.workspaceSnapshotEgress);
	const projection =
		input.modelProjection == null
			? undefined
			: validateRuntimeModelProjectionV4(input.modelProjection);
	const binding =
		input.standardTemplateBinding === undefined
			? projection?.standardTemplateBinding
			: validateStandardTemplateModelBindingsV1([
					input.standardTemplateBinding,
				])[0];
	if (input.sourceKind === "standard" && !binding)
		throw new Error("WORKLOAD_IMAGE_BINDING_MISMATCH");
	if (
		(binding && binding.imageDigest !== value.imageDigest) ||
		(projection &&
			(projection.agentId !== value.agentId ||
				projection.configurationRevision !== value.configRevision ||
				(binding &&
					!isDeepStrictEqual(projection.standardTemplateBinding, binding))))
	)
		throw new Error("WORKLOAD_IMAGE_BINDING_MISMATCH");
	if (isMultiService(value)) {
		if (!input.policy) throw new Error("WORKLOAD_IMAGE_POLICY_REQUIRED");
		return multiServiceWorkloadImageProjectionV1(value, {
			...input.policy,
			workspaceSnapshotProjection: input.workspaceSnapshotProjection,
		});
	}
	const repository =
		input.sourceKind === "standard"
			? (binding?.imageRepository ?? input.policy?.imageRepository)
			: input.policy?.imageRepository;
	if (!repository) throw new Error("WORKLOAD_IMAGE_REPOSITORY_REQUIRED");
	return [
		{
			resourceKind: "StatefulSet",
			resourceName: workloadResourceNameV1(value.agentId),
			images: workloadPodImagesV1(
				singleImageParentPodSpec(value, repository, input),
			),
		},
	];
}

/**
 * Image, pull and placement fields of the single-image parent Pod the adapter
 * renders: containers/initContainers, imagePullSecrets and scheduling. Same
 * trust checks as parentWorkloadImageProjectionV1; never env, volumes or Secrets.
 */
export function parentWorkloadPodImageSpecV1(
	input: Parameters<typeof parentWorkloadImageProjectionV1>[0],
) {
	const [group] = parentWorkloadImageProjectionV1(input);
	const value = validateAgentWorkloadDesiredV1(input.desired);
	if (!group || isMultiService(value) || input.sourceKind !== "custom")
		throw new Error("WORKLOAD_IMAGE_RESOURCE_FAMILY_UNSUPPORTED");
	const repository = input.policy?.imageRepository;
	if (!repository) throw new Error("WORKLOAD_IMAGE_REPOSITORY_REQUIRED");
	const spec = singleImageParentPodSpec(value, repository, input);
	const podSpec: V1PodSpec = {
		...workloadImagePullSpecV1(input.policy?.imagePullSecretName),
		containers: spec.containers,
		...(spec.initContainers ? { initContainers: spec.initContainers } : {}),
	};
	return {
		resourceKind: group.resourceKind,
		resourceName: group.resourceName,
		spec: podSpec,
	};
}

function singleImageParentPodSpec(
	value: ReturnType<typeof validateAgentWorkloadDesiredV1>,
	repository: string,
	input: Pick<
		Parameters<typeof parentWorkloadImageProjectionV1>[0],
		"workspaceSnapshotProjection"
	>,
) {
	let spec: V1PodSpec = {
		containers: [
			{ name: "agent", image: `${repository}@${value.imageDigest}` },
		],
	};
	const delivery = skillHubDeliveryProjectionV1(
		skillHubRuntimeBindingV1(value),
		value.skillDeliveryImage,
	);
	if (delivery) spec = applyWorkspaceSnapshotProjectionV1(spec, delivery);
	const snapshot = workspaceSnapshotWorkloadProjectionV1(
		value,
		input.workspaceSnapshotProjection,
	);
	if (snapshot) spec = applyWorkspaceSnapshotProjectionV1(spec, snapshot);
	return spec;
}
