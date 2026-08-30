import { z } from "zod";

import {
	WorkloadBoundaryErrorV1Schema,
	WorkloadFenceV1Schema,
	WorkloadOpaqueIdV1Schema,
	WorkloadRevisionV1Schema,
	WorkloadSchemaVersionV1Schema,
} from "./common.ts";
import {
	ImageRegistryAdmissionResultV1Schema,
	OciImageReferenceV1Schema,
	validateImageRegistryAdmissionResultV1,
} from "./registry.ts";
import {
	KubernetesResourceNameV1Schema,
	SecretActivationObservationV1Schema,
	validateSecretActivationObservationV1,
} from "./secret.ts";

const workerCorrelationV1Shape = {
	schemaVersion: WorkloadSchemaVersionV1Schema,
	outboxItemId: WorkloadOpaqueIdV1Schema,
	requestId: WorkloadOpaqueIdV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	configRevision: WorkloadRevisionV1Schema,
	workloadRevision: WorkloadRevisionV1Schema,
	fence: WorkloadFenceV1Schema,
} as const;

const admitImageCorrelationV1Shape = {
	...workerCorrelationV1Shape,
	registrySubjectRef: WorkloadOpaqueIdV1Schema,
	imageReference: OciImageReferenceV1Schema,
	usage: z.enum(["standard-template", "custom-agent"]),
	admissionPolicyRef: WorkloadOpaqueIdV1Schema,
} as const;

const activateSecretCorrelationV1Shape = {
	...workerCorrelationV1Shape,
	secretId: WorkloadOpaqueIdV1Schema,
	secretVersion: z.number().int().positive(),
	kubernetesSecretName: KubernetesResourceNameV1Schema,
	workloadUid: WorkloadOpaqueIdV1Schema,
	workloadGeneration: WorkloadRevisionV1Schema,
} as const;

const workerWorkloadErrorV1Schema = <
	const Code extends string,
	const Message extends string,
	const Retryable extends boolean,
>(
	code: Code,
	message: Message,
	retryable: Retryable,
) =>
	WorkloadBoundaryErrorV1Schema.extend({
		code: z.literal(code),
		message: z.literal(message),
		retryable: z.literal(retryable),
	});

const staleWorkerWorkloadErrorV1Schema = workerWorkloadErrorV1Schema(
	"WORKER_RESULT_STALE",
	"The Worker result is stale",
	false,
);
const rejectedWorkerWorkloadErrorV1Schema = workerWorkloadErrorV1Schema(
	"WORKER_REQUEST_REJECTED",
	"The Worker request was rejected",
	false,
);
const failedWorkerWorkloadErrorV1Schema = workerWorkloadErrorV1Schema(
	"WORKER_REQUEST_FAILED",
	"The Worker request failed",
	true,
);

export const WorkerWorkloadErrorV1Schema = z.discriminatedUnion("code", [
	staleWorkerWorkloadErrorV1Schema,
	rejectedWorkerWorkloadErrorV1Schema,
	failedWorkerWorkloadErrorV1Schema,
]);

export const WorkerWorkloadExpectedRevisionV1Schema = z.discriminatedUnion(
	"operation",
	[
		z.strictObject({
			...admitImageCorrelationV1Shape,
			operation: z.literal("admit-image"),
		}),
		z.strictObject({
			...activateSecretCorrelationV1Shape,
			operation: z.literal("activate-secret"),
		}),
	],
);

const succeededWorkerResults = [
	z.strictObject({
		...admitImageCorrelationV1Shape,
		status: z.literal("succeeded"),
		operation: z.literal("admit-image"),
		outcome: ImageRegistryAdmissionResultV1Schema,
	}),
	z.strictObject({
		...activateSecretCorrelationV1Shape,
		status: z.literal("succeeded"),
		operation: z.literal("activate-secret"),
		outcome: SecretActivationObservationV1Schema,
	}),
] as const;

function createWorkerErrorResultSchemas<
	const TOperation extends string,
	const TShape extends Record<string, z.ZodType>,
>(operation: TOperation, correlationShape: TShape) {
	const commonShape = {
		...correlationShape,
		operation: z.literal(operation),
	};
	return [
		z.strictObject({
			...commonShape,
			status: z.literal("stale"),
			currentConfigRevision: WorkloadRevisionV1Schema,
			currentWorkloadRevision: WorkloadRevisionV1Schema,
			currentFence: WorkloadFenceV1Schema,
			error: staleWorkerWorkloadErrorV1Schema,
		}),
		z.strictObject({
			...commonShape,
			status: z.literal("rejected"),
			error: rejectedWorkerWorkloadErrorV1Schema,
		}),
		z.strictObject({
			...commonShape,
			status: z.literal("failed"),
			error: failedWorkerWorkloadErrorV1Schema,
		}),
	] as const;
}

const errorWorkerResults = [
	...createWorkerErrorResultSchemas(
		"admit-image",
		admitImageCorrelationV1Shape,
	),
	...createWorkerErrorResultSchemas(
		"activate-secret",
		activateSecretCorrelationV1Shape,
	),
] as const;

export const WorkerWorkloadResultV1Schema = z.union([
	...succeededWorkerResults,
	...errorWorkerResults,
]);

export type WorkerWorkloadExpectedRevisionV1 = z.infer<
	typeof WorkerWorkloadExpectedRevisionV1Schema
>;
export type WorkerWorkloadResultV1 = z.infer<
	typeof WorkerWorkloadResultV1Schema
>;
export type WorkerWorkloadErrorV1 = z.infer<typeof WorkerWorkloadErrorV1Schema>;

const correlationKeys = [
	"outboxItemId",
	"requestId",
	"traceId",
	"agentId",
	"configRevision",
	"workloadRevision",
	"fence",
] as const;

export function validateWorkerWorkloadResultV1(
	expectedInput: unknown,
	resultInput: unknown,
): WorkerWorkloadResultV1 {
	const expected = WorkerWorkloadExpectedRevisionV1Schema.parse(expectedInput);
	const result = WorkerWorkloadResultV1Schema.parse(resultInput);
	if (
		correlationKeys.some((key) => result[key] !== expected[key]) ||
		result.operation !== expected.operation ||
		("error" in result && result.error.traceId !== expected.traceId)
	) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if (result.status === "stale") {
		const revisionsRegressed =
			result.currentConfigRevision < expected.configRevision ||
			result.currentWorkloadRevision < expected.workloadRevision;
		const revisionsAdvanced =
			result.currentConfigRevision > expected.configRevision ||
			result.currentWorkloadRevision > expected.workloadRevision;
		const fenceRegressed = result.currentFence < expected.fence;
		const fenceAdvanced = result.currentFence > expected.fence;
		if (
			revisionsRegressed ||
			fenceRegressed ||
			(!revisionsAdvanced && !fenceAdvanced)
		) {
			throw new Error("Worker result revision correlation mismatch");
		}
	}
	if (
		expected.operation === "admit-image" &&
		(result.operation !== "admit-image" ||
			result.registrySubjectRef !== expected.registrySubjectRef ||
			result.imageReference !== expected.imageReference ||
			result.usage !== expected.usage ||
			result.admissionPolicyRef !== expected.admissionPolicyRef)
	) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if (
		expected.operation === "activate-secret" &&
		(result.operation !== "activate-secret" ||
			!("secretId" in result) ||
			result.secretId !== expected.secretId ||
			result.secretVersion !== expected.secretVersion ||
			result.kubernetesSecretName !== expected.kubernetesSecretName ||
			result.workloadUid !== expected.workloadUid ||
			result.workloadGeneration !== expected.workloadGeneration)
	) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if (
		result.status === "succeeded" &&
		result.operation === "activate-secret" &&
		expected.operation === "activate-secret"
	) {
		validateSecretActivationObservationV1(
			{
				schemaVersion: expected.schemaVersion,
				agentId: expected.agentId,
				secretId: expected.secretId,
				secretVersion: expected.secretVersion,
				configRevision: expected.configRevision,
				kubernetesSecretName: expected.kubernetesSecretName,
				workloadUid: expected.workloadUid,
				workloadGeneration: expected.workloadGeneration,
				fence: expected.fence,
			},
			result.outcome,
		);
		if (
			result.outcome.status === "failed" &&
			result.outcome.error.traceId !== expected.traceId
		) {
			throw new Error("Worker result revision correlation mismatch");
		}
	}
	if (
		result.status === "succeeded" &&
		result.operation === "admit-image" &&
		expected.operation === "admit-image"
	) {
		validateImageRegistryAdmissionResultV1(
			{
				schemaVersion: expected.schemaVersion,
				requestId: expected.requestId,
				traceId: expected.traceId,
				subjectRef: expected.registrySubjectRef,
				agentId: expected.agentId,
				imageReference: expected.imageReference,
				usage: expected.usage,
				admissionPolicyRef: expected.admissionPolicyRef,
			},
			result.outcome,
		);
	}
	return result;
}
