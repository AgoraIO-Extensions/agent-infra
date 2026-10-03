import { isDeepStrictEqual } from "node:util";
import type { WorkloadReconciliationStateV1 } from "./workload-reconciliation.js";

/** Narrow current-state projection, read under the same Agent lock as the reservation. */
interface CapacityState {
	readonly agentId: string;
	readonly modelConfigurationRevision: number | null;
	readonly configurationRevision: number;
	readonly status: string | null;
	readonly desiredState: string | null;
	readonly serviceAvailability: string | null;
	readonly workloadRevision: number;
	readonly fence: number;
	readonly workload: WorkloadReconciliationStateV1;
	/** Validated transport deployment mapped into the fields needed by this use case. */
	readonly deployment: {
		readonly agentId: string;
		readonly configurationRevision: number;
		readonly interactionMode: string;
		readonly imageDigest: string;
		readonly resourceProfileRef: string;
	};
	readonly occupancy: {
		readonly processing: number;
		readonly unknown: number;
	};
}

/** Recovery and controls do not call this new-execution admission decision. */
export function decideConversationDispatchCapacityV1(
	state: CapacityState,
): "admit" | "capacity_wait" | "capacity_unavailable" {
	const { workload, deployment } = state;
	const verified = workload.verified;
	const capacity = verified?.executionCapacity;
	const modelConfigurationMatches =
		verified?.configuration.source.kind === "standard"
			? workload?.sourceConfigurationRevision ===
				state.modelConfigurationRevision
			: state.modelConfigurationRevision === null;
	if (
		!verified ||
		!capacity ||
		state.status !== "available" ||
		state.desiredState !== "running" ||
		state.serviceAvailability !== "ready" ||
		workload.agentId !== state.agentId ||
		workload.phase !== "ready" ||
		!workload.identity ||
		workload.verifiedRevision !== workload.revision ||
		workload.sourceConfigurationRevision !== state.configurationRevision ||
		workload.sourceConfigurationRevision !== verified.configuration.revision ||
		!modelConfigurationMatches ||
		workload.sourceLifecycleRevision !== state.workloadRevision ||
		workload.fence !== state.fence ||
		!isDeepStrictEqual(workload.candidate, verified) ||
		deployment.agentId !== state.agentId ||
		deployment.configurationRevision !== verified.configuration.revision ||
		deployment.interactionMode !== "platform-adapter" ||
		deployment.imageDigest !== verified.configuration.source.imageDigest ||
		capacity.imageDigest !== deployment.imageDigest ||
		capacity.resourceProfileRef !== deployment.resourceProfileRef ||
		!Number.isSafeInteger(capacity.maximumConcurrentExecutions) ||
		capacity.maximumConcurrentExecutions < 1 ||
		Object.values(state.occupancy).some(
			(count) => !Number.isSafeInteger(count) || count < 0,
		)
	) {
		return "capacity_unavailable";
	}
	return state.occupancy.processing + state.occupancy.unknown >=
		capacity.maximumConcurrentExecutions
		? "capacity_wait"
		: "admit";
}
