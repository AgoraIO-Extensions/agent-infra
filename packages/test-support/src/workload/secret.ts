import {
	type PlatformSecretRecordV1,
	type SecretActivationFenceV1,
	SecretActivationFenceV1Schema,
	validatePlatformSecretRecordV1,
	validateSecretActivationObservationV1,
} from "@agent-infra/contracts/workload";

export interface FakeSecretActivationAdapterV1 {
	read(record: unknown): PlatformSecretRecordV1;
	observe(
		record: unknown,
		expectedFence: unknown,
		observation: unknown,
	): PlatformSecretRecordV1;
	activate(record: unknown, expectedFence: unknown): PlatformSecretRecordV1;
	recover(records: readonly unknown[]): PlatformSecretRecordV1[];
}

function validateRecordFence(
	recordInput: unknown,
	expectedInput: unknown,
): {
	record: PlatformSecretRecordV1;
	expected: SecretActivationFenceV1;
} {
	const expected = SecretActivationFenceV1Schema.parse(expectedInput);
	const record = validatePlatformSecretRecordV1(recordInput, expected);
	return { record, expected };
}

export function createFakeSecretActivationAdapterV1(): FakeSecretActivationAdapterV1 {
	return {
		read(recordInput) {
			return structuredClone(validatePlatformSecretRecordV1(recordInput));
		},
		observe(recordInput, expectedInput, observationInput) {
			const { record, expected } = validateRecordFence(
				recordInput,
				expectedInput,
			);
			const observation = validateSecretActivationObservationV1(
				expected,
				observationInput,
			);
			if (
				record.lifecycleState !== "applying" &&
				record.lifecycleState !== "observed"
			) {
				throw new Error("Secret is not awaiting activation observation");
			}
			return validatePlatformSecretRecordV1(
				observation.status === "observed"
					? {
							...record,
							lifecycleState: "observed",
							kubernetesSecretRef: observation.kubernetesSecretRef,
							activationFence: observation.activationFence,
						}
					: {
							...record,
							lifecycleState: "failed",
							kubernetesSecretRef: observation.kubernetesSecretRef,
							activationFence: observation.activationFence,
							error: observation.error,
						},
			);
		},
		activate(recordInput, expectedInput) {
			const { record, expected } = validateRecordFence(
				recordInput,
				expectedInput,
			);
			if (record.lifecycleState === "active") return structuredClone(record);
			if (record.lifecycleState !== "observed") {
				throw new Error("Secret has not been observed healthy");
			}
			validateSecretActivationObservationV1(expected, {
				schemaVersion: 1,
				status: "observed",
				kubernetesSecretRef: record.kubernetesSecretRef,
				activationFence: record.activationFence,
				health: "healthy",
			});
			return validatePlatformSecretRecordV1(
				{
					...record,
					lifecycleState: "active",
				},
				expected,
			);
		},
		recover(recordsInput) {
			return recordsInput.map((record) =>
				structuredClone(validatePlatformSecretRecordV1(record)),
			);
		},
	};
}
