import { z } from "zod";

import {
	WorkloadBoundaryErrorV1Schema,
	WorkloadFenceV1Schema,
	WorkloadOpaqueIdV1Schema,
	WorkloadRevisionV1Schema,
	WorkloadSchemaVersionV1Schema,
} from "./common.ts";
import {
	AgentWorkloadAppliedV1Schema,
	WorkloadCleanupResultV1Schema,
	WorkloadIdentityV1Schema,
} from "./kubernetes.ts";
import {
	ImageRegistryAdmissionResultV1Schema,
	validateImageRegistryAdmissionResultV1,
} from "./registry.ts";
import {
	SecretActivationObservationV1Schema,
	validateSecretActivationObservationV1,
} from "./secret.ts";

const workerCorrelationV1Shape = {
	schemaVersion: WorkloadSchemaVersionV1Schema,
	outboxItemId: WorkloadOpaqueIdV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	configRevision: WorkloadRevisionV1Schema,
	workloadRevision: WorkloadRevisionV1Schema,
	fence: WorkloadFenceV1Schema,
} as const;

const admitImageCorrelationV1Shape = {
	...workerCorrelationV1Shape,
	registryRequestId: WorkloadOpaqueIdV1Schema,
	registrySubjectRef: WorkloadOpaqueIdV1Schema,
	imageReference: z.string().min(1),
	usage: z.enum(["standard-template", "custom-agent"]),
	admissionPolicyRef: WorkloadOpaqueIdV1Schema,
} as const;

const activateSecretCorrelationV1Shape = {
	...workerCorrelationV1Shape,
	secretId: WorkloadOpaqueIdV1Schema,
	secretVersion: z.number().int().positive(),
	kubernetesSecretName: WorkloadOpaqueIdV1Schema,
	workloadUid: WorkloadOpaqueIdV1Schema,
	workloadGeneration: WorkloadRevisionV1Schema,
} as const;

const reconcileWorkloadCorrelationV1Shape = {
	...workerCorrelationV1Shape,
	expectedWorkload: WorkloadIdentityV1Schema.optional(),
} as const;

const cleanupWorkloadCorrelationV1Shape = {
	...workerCorrelationV1Shape,
	workloadUid: WorkloadOpaqueIdV1Schema,
	workloadGeneration: WorkloadRevisionV1Schema,
} as const;

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
		z.strictObject({
			...reconcileWorkloadCorrelationV1Shape,
			operation: z.literal("reconcile-workload"),
		}),
		z.strictObject({
			...cleanupWorkloadCorrelationV1Shape,
			operation: z.literal("cleanup-workload"),
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
	z.strictObject({
		...reconcileWorkloadCorrelationV1Shape,
		workloadUid: WorkloadOpaqueIdV1Schema,
		workloadGeneration: WorkloadRevisionV1Schema,
		status: z.literal("succeeded"),
		operation: z.literal("reconcile-workload"),
		outcome: AgentWorkloadAppliedV1Schema,
	}),
	z.strictObject({
		...cleanupWorkloadCorrelationV1Shape,
		status: z.literal("succeeded"),
		operation: z.literal("cleanup-workload"),
		outcome: WorkloadCleanupResultV1Schema,
	}),
] as const;

function createWorkerErrorResultSchemas<
	const TOperation extends string,
	const TShape extends Record<string, z.ZodType>,
>(operation: TOperation, correlationShape: TShape) {
	const commonShape = {
		...correlationShape,
		operation: z.literal(operation),
		error: WorkloadBoundaryErrorV1Schema,
	};
	return [
		z.strictObject({
			...commonShape,
			status: z.literal("stale"),
			currentConfigRevision: WorkloadRevisionV1Schema,
			currentWorkloadRevision: WorkloadRevisionV1Schema,
		}),
		z.strictObject({ ...commonShape, status: z.literal("rejected") }),
		z.strictObject({ ...commonShape, status: z.literal("failed") }),
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
	...createWorkerErrorResultSchemas(
		"reconcile-workload",
		reconcileWorkloadCorrelationV1Shape,
	),
	...createWorkerErrorResultSchemas(
		"cleanup-workload",
		cleanupWorkloadCorrelationV1Shape,
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

const correlationKeys = [
	"outboxItemId",
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
	if (correlationKeys.some((key) => result[key] !== expected[key])) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if (result.operation !== expected.operation) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if ("error" in result && result.error.traceId !== expected.traceId) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if (
		result.status === "stale" &&
		(result.currentConfigRevision < expected.configRevision ||
			result.currentWorkloadRevision < expected.workloadRevision ||
			(result.currentConfigRevision === expected.configRevision &&
				result.currentWorkloadRevision === expected.workloadRevision))
	) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if (
		expected.operation === "admit-image" &&
		(result.operation !== "admit-image" ||
			result.registryRequestId !== expected.registryRequestId ||
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
		expected.operation === "cleanup-workload" &&
		(result.operation !== "cleanup-workload" ||
			!("workloadUid" in result) ||
			result.workloadUid !== expected.workloadUid ||
			result.workloadGeneration !== expected.workloadGeneration)
	) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if (
		expected.operation === "reconcile-workload" &&
		(result.operation !== "reconcile-workload" ||
			JSON.stringify(result.expectedWorkload) !==
				JSON.stringify(expected.expectedWorkload))
	) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if (
		result.status === "succeeded" &&
		result.operation === "reconcile-workload" &&
		(expected.operation !== "reconcile-workload" ||
			result.outcome.traceId !== expected.traceId ||
			result.outcome.agentId !== expected.agentId ||
			result.outcome.configRevision !== expected.configRevision ||
			result.outcome.workloadRevision !== expected.workloadRevision ||
			result.outcome.fence !== expected.fence ||
			result.workloadUid !== result.outcome.workloadUid ||
			result.workloadGeneration !== result.outcome.observedGeneration ||
			(expected.expectedWorkload !== undefined &&
				(result.outcome.workloadUid !== expected.expectedWorkload.workloadUid ||
					result.outcome.observedGeneration <
						expected.expectedWorkload.workloadGeneration)))
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
	}
	if (
		result.status === "succeeded" &&
		result.operation === "cleanup-workload" &&
		(expected.operation !== "cleanup-workload" ||
			result.outcome.traceId !== expected.traceId ||
			result.outcome.agentId !== expected.agentId ||
			result.outcome.configRevision !== expected.configRevision ||
			result.outcome.workloadRevision !== expected.workloadRevision ||
			result.outcome.workloadUid !== expected.workloadUid ||
			result.outcome.workloadGeneration !== expected.workloadGeneration ||
			result.outcome.fence !== expected.fence ||
			result.workloadUid !== expected.workloadUid ||
			result.workloadGeneration !== expected.workloadGeneration)
	) {
		throw new Error("Worker result revision correlation mismatch");
	}
	if (
		result.status === "succeeded" &&
		result.operation === "activate-secret" &&
		(expected.operation !== "activate-secret" ||
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
		result.operation === "admit-image" &&
		expected.operation === "admit-image"
	) {
		validateImageRegistryAdmissionResultV1(
			{
				schemaVersion: expected.schemaVersion,
				requestId: expected.registryRequestId,
				traceId: expected.traceId,
				subjectRef: expected.registrySubjectRef,
				agentId: expected.agentId,
				imageReference: expected.imageReference,
				usage: expected.usage,
				admissionPolicyRef: expected.admissionPolicyRef,
			},
			result.outcome,
		);
		if (
			result.outcome.status === "rejected" &&
			result.outcome.error.traceId !== expected.traceId
		) {
			throw new Error("Worker result revision correlation mismatch");
		}
	}
	return result;
}
