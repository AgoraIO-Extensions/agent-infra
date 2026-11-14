import { createHash } from "node:crypto";
import type { V1PodSpec } from "@kubernetes/client-node";

/** Image metadata only; callers must not serialize the source Pod/env/Secret objects. */
export function workloadPodImagesV1(
	spec: Pick<V1PodSpec, "containers" | "initContainers">,
) {
	const names = new Set<string>();
	const result = [];
	for (const [kind, entries] of [
		["containers", spec.containers],
		["initContainers", spec.initContainers ?? []],
	] as const) {
		for (const [index, value] of entries.entries()) {
			if (
				names.has(value.name) ||
				typeof value.image !== "string" ||
				!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(
					value.image,
				)
			)
				throw new Error("WORKLOAD_IMAGE_PROJECTION_INVALID");
			names.add(value.name);
			result.push({
				name: value.name,
				kind:
					kind === "initContainers" ? "init" : index === 0 ? "main" : "sidecar",
				image: value.image,
				digest: value.image.slice(value.image.lastIndexOf("@") + 1),
				entrypointSource:
					value.command === undefined && value.args === undefined
						? "image-default-unverified"
						: "pod-override",
				entrypointShapeHash: createHash("sha256")
					.update(JSON.stringify([value.command ?? null, value.args ?? null]))
					.digest("hex"),
			});
		}
	}
	if (result.length === 0) throw new Error("WORKLOAD_IMAGE_PROJECTION_INVALID");
	return result;
}
