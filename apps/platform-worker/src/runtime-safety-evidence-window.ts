import {
	type RuntimeSafetyEvidenceWindowV1,
	RuntimeSafetyEvidenceWindowV1Schema,
} from "@agent-infra/contracts/runtime";

/**
 * Engineering Spec §18.5.1 验收场景: the deployment-injected, default-off acceptance window of
 * the Worker evidence reader. Kept apart from the reader so a Worker without a window never
 * loads it.
 */
export const workerRuntimeSafetyEvidenceWindowEnvironmentV1 =
	"AGENT_INFRA_RUNTIME_SAFETY_EVIDENCE_WINDOW";
const maximumWindowBytes = 32_768;

export function readWorkerRuntimeSafetyEvidenceWindowV1(
	environment: NodeJS.ProcessEnv,
):
	| { readonly status: "disabled" }
	| { readonly status: "invalid" }
	| {
			readonly status: "enabled";
			readonly window: RuntimeSafetyEvidenceWindowV1;
	  } {
	const value = environment[workerRuntimeSafetyEvidenceWindowEnvironmentV1];
	if (value === undefined) return { status: "disabled" };
	if (Buffer.byteLength(value) > maximumWindowBytes)
		return { status: "invalid" };
	try {
		const parsed = RuntimeSafetyEvidenceWindowV1Schema.safeParse(
			JSON.parse(value),
		);
		return parsed.success
			? { status: "enabled", window: parsed.data }
			: { status: "invalid" };
	} catch {
		return { status: "invalid" };
	}
}
