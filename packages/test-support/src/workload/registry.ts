import {
	ImageRegistryAdmissionRequestV1Schema,
	validateImageRegistryAdmissionResultV1,
} from "@agent-infra/contracts/workload";

export function createFakeImageRegistryAdapterV1(
	outcomesByImageReference: Readonly<Record<string, unknown>>,
) {
	return {
		async admit(requestInput: unknown) {
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
			const rejectedError =
				typeof outcome === "object" &&
				outcome !== null &&
				"status" in outcome &&
				outcome.status === "rejected" &&
				"error" in outcome &&
				typeof outcome.error === "object" &&
				outcome.error !== null &&
				!Array.isArray(outcome.error)
					? outcome.error
					: undefined;
			const result =
				typeof outcome === "object" && outcome !== null
					? {
							...outcome,
							...(rejectedError
								? { error: { ...rejectedError, traceId: request.traceId } }
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
