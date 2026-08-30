import {
	ImageRegistryAdmissionRequestV1Schema,
	type ImageRegistryAdmissionResultV1,
	validateImageRegistryAdmissionResultV1,
} from "@agent-infra/contracts/workload";

export interface FakeImageRegistryAdapterV1 {
	admit(request: unknown): Promise<ImageRegistryAdmissionResultV1>;
}

export function createFakeImageRegistryAdapterV1(
	outcomesByImageReference: Readonly<Record<string, unknown>>,
): FakeImageRegistryAdapterV1 {
	return {
		async admit(requestInput) {
			const request = ImageRegistryAdmissionRequestV1Schema.parse(requestInput);
			const hasConfiguredOutcome = Object.hasOwn(
				outcomesByImageReference,
				request.imageReference,
			);
			const configured = outcomesByImageReference[request.imageReference];
			const outcome = !hasConfiguredOutcome
				? {
						status: "rejected",
						error: {
							schemaVersion: 1,
							code: "IMAGE_NOT_ADMITTED",
							message: "The image is not admitted by deployment policy",
							retryable: false,
							traceId: request.traceId,
						},
					}
				: configured;
			const rejected =
				typeof outcome === "object" &&
				outcome !== null &&
				"status" in outcome &&
				outcome.status === "rejected" &&
				"error" in outcome &&
				typeof outcome.error === "object" &&
				outcome.error !== null &&
				!Array.isArray(outcome.error);
			const result =
				typeof outcome === "object" && outcome !== null
					? {
							...outcome,
							...(rejected
								? { error: { ...outcome.error, traceId: request.traceId } }
								: {}),
							schemaVersion: 1,
							requestId: request.requestId,
							traceId: request.traceId,
						}
					: outcome;
			return validateImageRegistryAdmissionResultV1(request, result);
		},
	};
}
