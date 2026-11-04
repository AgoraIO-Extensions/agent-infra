import type { V1Container } from "@kubernetes/client-node";

/** A deployment may forbid network pulls of an already pinned image. */
export function immutableImagePullPolicyMatches(
	actual: Pick<V1Container, "image" | "imagePullPolicy">,
	expected: Pick<V1Container, "image" | "imagePullPolicy">,
): boolean {
	return (
		actual.image === expected.image &&
		(actual.imagePullPolicy === expected.imagePullPolicy ||
			(expected.imagePullPolicy === "IfNotPresent" &&
				actual.imagePullPolicy === "Never" &&
				/@sha256:[a-f0-9]{64}$/u.test(expected.image ?? "")))
	);
}
