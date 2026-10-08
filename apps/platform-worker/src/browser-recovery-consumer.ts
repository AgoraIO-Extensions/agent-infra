import type {
	BrowserActionExecutionBindingV1,
	BrowserActionRecordV1,
} from "@agent-infra/agent-runtime";

export type BrowserRecoveryBindingV1 = BrowserActionExecutionBindingV1;

export type BrowserRecoveryStatusV1 =
	| "completed"
	| "failed"
	| "rejected"
	| "unknown"
	| "missing";

export type BrowserRecoveryResultV1 =
	| { readonly status: "missing" }
	| {
			readonly status: Exclude<BrowserRecoveryStatusV1, "missing">;
			readonly record: BrowserActionRecordV1;
	  };

function sameBinding(
	left: BrowserRecoveryBindingV1,
	right: BrowserRecoveryBindingV1,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.conversationId === right.conversationId &&
		left.executionId === right.executionId &&
		left.capabilityVersion === right.capabilityVersion &&
		left.pageRevision === right.pageRevision &&
		left.sessionGeneration === right.sessionGeneration &&
		left.resourceFence === right.resourceFence
	);
}

function assertBinding(binding: BrowserRecoveryBindingV1): void {
	if (
		![binding.agentId, binding.conversationId, binding.executionId].every(
			(value) => typeof value === "string" && value.length > 0,
		) ||
		![
			"capabilityVersion",
			"pageRevision",
			"sessionGeneration",
			"resourceFence",
		].every((key) => {
			const value = binding[key as keyof BrowserRecoveryBindingV1];
			return Number.isSafeInteger(value) && (value as number) >= 1;
		})
	)
		throw new Error("BROWSER_ACTION_RECOVERY_BINDING_INVALID");
}

export function createBrowserRecoveryConsumerV1(input: {
	readonly controller: {
		readonly readAction: (request: {
			readonly actionId?: string;
			readonly idempotencyKey?: string;
			readonly executionBinding: BrowserRecoveryBindingV1;
		}) => BrowserActionRecordV1 | null;
	};
}) {
	return {
		read(request: {
			readonly actionId: string;
			readonly idempotencyKey?: string;
			readonly binding: BrowserRecoveryBindingV1;
		}): BrowserRecoveryResultV1 {
			assertBinding(request.binding);
			let record: BrowserActionRecordV1 | null;
			try {
				record = input.controller.readAction({
					actionId: request.actionId,
					idempotencyKey: request.idempotencyKey,
					executionBinding: request.binding,
				});
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "BROWSER_ACTION_READBACK_BINDING_CONFLICT"
				)
					throw new Error("BROWSER_ACTION_RECOVERY_BINDING_CONFLICT");
				throw error;
			}
			if (!record) return { status: "missing" };
			if (
				record.executionBinding === undefined ||
				!sameBinding(record.executionBinding, request.binding)
			)
				throw new Error("BROWSER_ACTION_RECOVERY_BINDING_CONFLICT");
			if (record.status === "accepted" || record.status === "processing")
				return { status: "unknown", record };
			return { status: record.status, record };
		},
	};
}
