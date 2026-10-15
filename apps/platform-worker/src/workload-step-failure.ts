import {
	WorkloadPreflightRejectedErrorV1,
	type WorkloadStepFailureV1,
} from "@agent-infra/platform-core";
import {
	WorkloadKubernetesError,
	type WorkloadKubernetesFailureDetailsV1,
} from "./kubernetes-client.js";

/** 调谐步骤里已知、原因固定的错误；`message` 与 `reason` 都是静态文本，不含外部内容。 */
export class WorkloadStepErrorV1 extends Error {
	constructor(
		readonly reason: "capabilities_unavailable",
		message: string,
	) {
		super(message);
	}
}

/** 有界的失败原因，只能是这些取值，不携带任何外部文本。 */
export type WorkloadStepFailureReasonV1 =
	| "kubernetes_unauthorized"
	| "kubernetes_forbidden"
	| "kubernetes_not_found"
	| "kubernetes_conflict"
	| "kubernetes_invalid"
	| "kubernetes_throttled"
	| "kubernetes_server_error"
	| "kubernetes_unreachable"
	| "kubernetes_policy"
	| "preflight_rejected"
	| "capabilities_unavailable"
	| "unexpected_error";

export interface WorkloadStepFailureClassV1 {
	readonly reason: WorkloadStepFailureReasonV1;
	/** 仅 Kubernetes 错误：HTTP 状态、资源种类与动词，不含响应体或资源名。 */
	readonly kubernetes?: WorkloadKubernetesFailureDetailsV1;
	/** 仅 `unexpected_error`：错误类名，已按标识符规则过滤。 */
	readonly errorName?: string;
}

function kubernetesReason(
	error: WorkloadKubernetesError,
): WorkloadStepFailureReasonV1 {
	if (error.code === "policy") return "kubernetes_policy";
	if (error.code === "conflict") return "kubernetes_conflict";
	const status = error.details.status;
	if (status === undefined) return "kubernetes_unreachable";
	if (status === 401) return "kubernetes_unauthorized";
	if (status === 403) return "kubernetes_forbidden";
	if (status === 404) return "kubernetes_not_found";
	if (status === 409) return "kubernetes_conflict";
	if (status === 400 || status === 422) return "kubernetes_invalid";
	if (status === 429) return "kubernetes_throttled";
	if (status >= 500) return "kubernetes_server_error";
	return "kubernetes_unreachable";
}

/** 把调谐步骤里被吞掉的异常归类成有界原因；绝不读取 `message`、响应体或堆栈。 */
export function classifyWorkloadStepFailureV1(
	error: unknown,
): WorkloadStepFailureClassV1 {
	if (error instanceof WorkloadKubernetesError) {
		const { status, kind, verb } = error.details;
		return {
			reason: kubernetesReason(error),
			kubernetes: {
				...(status === undefined ? {} : { status }),
				...(kind === undefined ? {} : { kind }),
				...(verb === undefined ? {} : { verb }),
			},
		};
	}
	if (error instanceof WorkloadPreflightRejectedErrorV1)
		return { reason: "preflight_rejected" };
	if (error instanceof WorkloadStepErrorV1) return { reason: error.reason };
	const name =
		typeof error === "object" && error !== null
			? error.constructor?.name
			: undefined;
	return {
		reason: "unexpected_error",
		...(typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
			? { errorName: name }
			: {}),
	};
}

/**
 * 记录被吞掉的步骤异常：同一个 Agent、阶段、原因在 `intervalMs` 内只记一条（附带被合并的
 * 次数），终态失败总是记录。记录里只有有界原因、HTTP 状态、资源种类和动词。
 */
export function createWorkloadStepFailureLoggerV1(options: {
	readonly log: (message: string) => void;
	readonly intervalMs?: number;
	readonly now?: () => number;
	readonly maximumKeys?: number;
}) {
	const intervalMs = options.intervalMs ?? 30_000;
	const now = options.now ?? Date.now;
	const maximumKeys = options.maximumKeys ?? 2_000;
	const seen = new Map<string, { at: number; suppressed: number }>();
	return (failure: WorkloadStepFailureV1) => {
		const at = now();
		const classified = classifyWorkloadStepFailureV1(failure.error);
		const key = `${failure.agentId}\0${failure.phase}\0${classified.reason}`;
		const previous = seen.get(key);
		if (
			!failure.terminal &&
			previous !== undefined &&
			at - previous.at < intervalMs
		) {
			previous.suppressed++;
			return;
		}
		seen.delete(key);
		seen.set(key, { at, suppressed: 0 });
		if (seen.size > maximumKeys) {
			// Map 按插入顺序迭代：先清理过期的，再丢最旧的。
			for (const [oldKey, entry] of seen) {
				if (seen.size <= maximumKeys) break;
				if (at - entry.at >= intervalMs * 10) seen.delete(oldKey);
			}
			for (const oldKey of seen.keys()) {
				if (seen.size <= maximumKeys) break;
				seen.delete(oldKey);
			}
		}
		options.log(
			JSON.stringify({
				service: "platform-worker",
				code: "WORKLOAD_STEP_FAILED",
				agentId: failure.agentId,
				phase: failure.phase,
				attempts: failure.attempts,
				terminal: failure.terminal,
				reason: classified.reason,
				...(classified.kubernetes ? { kubernetes: classified.kubernetes } : {}),
				...(classified.errorName ? { errorName: classified.errorName } : {}),
				...(previous && previous.suppressed > 0
					? { suppressed: previous.suppressed }
					: {}),
			}),
		);
	};
}
