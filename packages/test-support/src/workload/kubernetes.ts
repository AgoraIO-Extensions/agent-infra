import {
	KubernetesRuntimeCapabilitiesV1Schema,
	validateAgentWorkloadDesiredV1,
	validateKubernetesReconcileResultV1,
	validateWorkloadCleanupResultV1,
	validateWorkloadRouteSwitchRequestV1,
	validateWorkloadRouteSwitchResultV1,
	WorkloadCleanupRequestV1Schema,
} from "@agent-infra/contracts/workload";

export function createFakeKubernetesRuntimeAdapterV1(options: {
	capabilities: unknown;
	reconcile?: (desired: unknown, attempt: number) => unknown;
	switchRoute?: (request: unknown, attempt: number) => unknown;
	cleanup?: (request: unknown, attempt: number) => unknown;
}) {
	const capabilities = KubernetesRuntimeCapabilitiesV1Schema.parse(
		options.capabilities,
	);
	const reconcileAttempts = new Map<string, number>();
	const routeSwitchAttempts = new Map<string, number>();
	const cleanupAttempts = new Map<string, number>();
	const nextAttempt = (attempts: Map<string, number>, requestId: string) => {
		const attempt = attempts.get(requestId) ?? 0;
		attempts.set(requestId, attempt + 1);
		return attempt;
	};
	return {
		capabilities() {
			return structuredClone(capabilities);
		},
		async reconcile(desiredInput: unknown) {
			const desired = validateAgentWorkloadDesiredV1(desiredInput);
			const configured = options.reconcile?.(
				structuredClone(desired),
				nextAttempt(reconcileAttempts, desired.requestId),
			) ?? {
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
					code: "KUBERNETES_ADAPTER_UNAVAILABLE",
					message: "Kubernetes reconciliation is temporarily unavailable",
					retryable: true,
					traceId: desired.traceId,
				},
			};
			return structuredClone(
				validateKubernetesReconcileResultV1(desired, configured),
			);
		},
		async switchRoute(requestInput: unknown) {
			const request = validateWorkloadRouteSwitchRequestV1(requestInput);
			const configured = options.switchRoute?.(
				structuredClone(request),
				nextAttempt(routeSwitchAttempts, request.requestId),
			) ?? {
				schemaVersion: request.schemaVersion,
				requestId: request.requestId,
				traceId: request.traceId,
				agentId: request.agentId,
				fence: request.fence,
				action: request.action,
				status: "failed",
				routedWorkloads: request.previousRoute ? [request.previousRoute] : [],
				error: {
					schemaVersion: 1,
					code: "KUBERNETES_ROUTE_SWITCH_FAILED",
					message: "Kubernetes route switch did not converge",
					retryable: true,
					traceId: request.traceId,
				},
			};
			return structuredClone(
				validateWorkloadRouteSwitchResultV1(request, configured),
			);
		},
		async cleanup(requestInput: unknown) {
			const request = WorkloadCleanupRequestV1Schema.parse(requestInput);
			const configured = options.cleanup?.(
				structuredClone(request),
				nextAttempt(cleanupAttempts, request.requestId),
			) ?? {
				...request,
				status: "failed",
				phase: "closing-route",
				routeClosed: false,
				removed: {
					workload: false,
					service: false,
					serviceAccount: false,
					networkPolicy: false,
					configuration: false,
					secrets: false,
					persistentVolume: false,
				},
				error: {
					schemaVersion: 1,
					code: "KUBERNETES_CLEANUP_FAILED",
					message: "Kubernetes Workload cleanup did not complete",
					retryable: true,
					traceId: request.traceId,
				},
			};
			return structuredClone(
				validateWorkloadCleanupResultV1(request, configured),
			);
		},
		restart() {
			return this;
		},
	};
}
