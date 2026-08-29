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
			const configured = outcomesByImageReference[request.imageReference];
			const outcome =
				configured === undefined
					? {
							status: "rejected",
							error: {
								schemaVersion: 1,
								code: "IMAGE_NOT_ADMITTED",
								message: "The image is not admitted by the configured Fake",
								retryable: false,
								traceId: request.traceId,
							},
						}
					: configured;
			const result =
				typeof outcome === "object" && outcome !== null
					? {
							...outcome,
							schemaVersion: 1,
							requestId: request.requestId,
							traceId: request.traceId,
						}
					: outcome;
			return validateImageRegistryAdmissionResultV1(request, result);
		},
	};
}
