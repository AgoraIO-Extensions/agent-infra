import { isDeepStrictEqual } from "node:util";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import { validateStandardTemplateModelBindingsV1 } from "@agent-infra/model-catalog";
import { parentWorkloadImageProjectionV1 } from "./parent-workload-image-projection.js";

export { projectWorkspaceSnapshotDemandImagesV1 } from "./workspace-snapshot-demand-images.js";
export {
	createWorkspaceSnapshotResolverV1,
	workspaceSnapshotResolverImagePolicyV1,
} from "./workspace-snapshot-resolver.js";

/** The normal H reader and its builder recompute this same image-only contract. */
export function projectStandardParentDemandImagesV1(
	desired: unknown,
	standardTemplateBinding: unknown,
	normal: Omit<
		Parameters<typeof parentWorkloadImageProjectionV1>[0],
		"desired" | "sourceKind" | "standardTemplateBinding"
	> = {},
) {
	const value = validateAgentWorkloadDesiredV1(desired);
	const binding = validateStandardTemplateModelBindingsV1([
		standardTemplateBinding,
	])[0];
	const admission = value.registryAdmission;
	if (
		!binding?.imageRepository ||
		binding.imageDigest !== value.imageDigest ||
		admission?.immutableDigest !== value.imageDigest ||
		admission.policyEvidence.agentId !== value.agentId ||
		admission.policyEvidence.imageDigest !== value.imageDigest ||
		!isDeepStrictEqual(admission.runtimeManifest, value.runtimeManifest)
	)
		throw new Error("PARENT_DEMAND_IMAGE_AUTHORITY_MISMATCH");
	const mainImage = `${binding.imageRepository}@${value.imageDigest}`;
	if (value.workspaceSnapshots?.length && !normal.workspaceSnapshotProjection)
		return {
			source: "AgentWorkloadDesiredV1" as const,
			completeness: "MAIN_ONLY" as const,
			images: [mainImage],
			mainImage,
			auxiliaryImages: [] as string[],
			containers: [],
		};
	const groups = parentWorkloadImageProjectionV1({
		...normal,
		desired: value,
		sourceKind: "standard",
		standardTemplateBinding: binding,
	});
	const images = [
		...new Set(
			groups.flatMap((group) => group.images.map((image) => image.image)),
		),
	];
	if (!images.includes(mainImage))
		throw new Error("PARENT_DEMAND_MAIN_IMAGE_MISSING");
	return {
		source: "AgentWorkloadDesiredV1" as const,
		completeness: "COMPLETE" as const,
		images,
		mainImage,
		auxiliaryImages: images.filter((image) => image !== mainImage),
		containers: groups.flatMap((group) =>
			group.images.map((image) => ({
				resourceKind: group.resourceKind,
				resourceName: group.resourceName,
				...image,
			})),
		),
	};
}
