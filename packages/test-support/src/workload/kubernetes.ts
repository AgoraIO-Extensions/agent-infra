import {
	type KubernetesReconcileResultV1,
	KubernetesRuntimeCapabilitiesV1Schema,
	validateAgentWorkloadDesiredV1,
	validateKubernetesReconcileResultV1,
	validateWorkloadCleanupResultV1,
	WorkloadCleanupRequestV1Schema,
	type WorkloadCleanupResultV1,
} from "@agent-infra/contracts/workload";

export interface FakeKubernetesRuntimeAdapterV1 {
	capabilities(): ReturnType<
		typeof KubernetesRuntimeCapabilitiesV1Schema.parse
	>;
	reconcile(desired: unknown): Promise<KubernetesReconcileResultV1>;
	cleanup(request: unknown): Promise<WorkloadCleanupResultV1>;
}

export function createFakeKubernetesRuntimeAdapterV1(options: {
	capabilities: unknown;
	reconcile?: (desired: unknown) => unknown;
	cleanup?: (request: unknown) => unknown;
}): FakeKubernetesRuntimeAdapterV1 {
	const capabilities = KubernetesRuntimeCapabilitiesV1Schema.parse(
		options.capabilities,
	);
	return {
		capabilities() {
			return structuredClone(capabilities);
		},
		async reconcile(desiredInput) {
			const desired = validateAgentWorkloadDesiredV1(desiredInput);
			const configured = options.reconcile?.(structuredClone(desired)) ?? {
				schemaVersion: 1,
				status: "failed",
				requestId: desired.requestId,
				traceId: desired.traceId,
				agentId: desired.agentId,
				configRevision: desired.configRevision,
				workloadRevision: desired.workloadRevision,
				fence: desired.fence,
				error: {
					schemaVersion: 1,
					code: "FAKE_RECONCILE_RESULT_MISSING",
					message: "No Fake reconciliation result was configured",
					retryable: false,
					traceId: desired.traceId,
				},
			};
			return structuredClone(
				validateKubernetesReconcileResultV1(desired, configured),
			);
		},
		async cleanup(requestInput) {
			const request = WorkloadCleanupRequestV1Schema.parse(requestInput);
			const configured = options.cleanup?.(structuredClone(request)) ?? {
				...request,
				status: "failed",
				error: {
					schemaVersion: 1,
					code: "FAKE_CLEANUP_RESULT_MISSING",
					message: "No Fake cleanup result was configured",
					retryable: false,
					traceId: request.traceId,
				},
			};
			return structuredClone(
				validateWorkloadCleanupResultV1(request, configured),
			);
		},
	};
}
