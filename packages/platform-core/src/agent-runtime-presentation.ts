import { isDeepStrictEqual } from "node:util";

import type { AgentConfigurationRecordV2 } from "./agent-configuration.js";
import {
	type AgentManagementActorContextV1,
	type AgentManagementStateV1,
	isAgentAccessAllowedV1,
} from "./agent-management.js";
import {
	AgentManagementError,
	parseAgentManagementPortState,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import type { WorkloadReconciliationStateV1 } from "./workload-reconciliation.js";

export interface AgentRuntimePresentationExpectationV1 {
	readonly configurationRevision: number;
	readonly management: AgentManagementStateV1;
}

export type AgentRuntimePresentationDecisionV1 =
	| {
			readonly outcome: "found";
			readonly sourceReference: string;
			readonly capabilities: Readonly<Record<string, boolean>> | null;
			readonly interactionUrl: null;
	  }
	| { readonly outcome: "unavailable" | "stale" };

/** Only decoded deployment facts used by the presentation policy. */
export interface AgentRuntimePresentationDeploymentV1 {
	readonly agentId: string;
	readonly configRevision: number;
	readonly workloadRevision: number;
	readonly fence: number;
	readonly desiredState: "running" | "stopped" | "disabled";
	readonly imageDigest: string;
	readonly runtimeManifest: {
		readonly interactionMode: "platform-adapter" | "self-managed";
	};
	readonly route: {
		readonly exposure: "internal-only" | "platform-auth" | "self-managed";
	};
}

export interface AgentRuntimePresentationFactsV1 {
	readonly management: AgentManagementStateV1;
	readonly configuration: AgentConfigurationRecordV2;
	readonly sourceReference: string;
	readonly runtime: null | {
		readonly revision: number;
		readonly state: WorkloadReconciliationStateV1;
		readonly verifiedConfiguration: AgentConfigurationRecordV2;
		readonly verifiedSourceReference: string;
		readonly deployment: AgentRuntimePresentationDeploymentV1;
	};
}

export function isAgentRuntimePresentationVisibleV1(
	management: AgentManagementStateV1 | null,
	actor: AgentManagementActorContextV1,
): boolean {
	return (
		management !== null &&
		actor.accountStatus === "active" &&
		(actor.isAdministrator ||
			isAgentAccessAllowedV1(management, actor, "discover"))
	);
}

/** Capture before awaiting Store reads so the upstream snapshot cannot drift in place. */
export function snapshotAgentRuntimePresentationExpectationV1(
	input: AgentRuntimePresentationExpectationV1,
): AgentRuntimePresentationExpectationV1 {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, [
		"configurationRevision",
		"management",
	]);
	if (
		!Number.isSafeInteger(value.configurationRevision) ||
		(value.configurationRevision as number) < 1
	)
		throw new AgentManagementError("invalid_input");
	return {
		configurationRevision: value.configurationRevision as number,
		management: parseAgentManagementPortState(
			value.management as AgentManagementStateV1,
		),
	};
}

/** A browser projection must describe one authorized configuration/management snapshot. */
export function decideAgentRuntimePresentationV1(input: {
	readonly agentId: string;
	readonly actor: AgentManagementActorContextV1;
	readonly expected: AgentRuntimePresentationExpectationV1;
	readonly facts: AgentRuntimePresentationFactsV1 | null;
}): AgentRuntimePresentationDecisionV1 {
	const facts = input.facts;
	if (
		!facts ||
		!isAgentRuntimePresentationVisibleV1(facts.management, input.actor)
	)
		return { outcome: "unavailable" };
	const management = parseAgentManagementPortState(facts.management);
	if (management.agentId !== input.agentId) return { outcome: "unavailable" };
	if (
		facts.configuration.agentId !== input.agentId ||
		facts.configuration.revision !== input.expected.configurationRevision ||
		!isDeepStrictEqual(management, input.expected.management)
	)
		return { outcome: "stale" };
	const unavailable: AgentRuntimePresentationDecisionV1 = {
		outcome: "found",
		sourceReference: facts.sourceReference,
		capabilities: null,
		interactionUrl: null,
	};
	const runtime = facts.runtime;
	if (
		!runtime ||
		management.status !== "available" ||
		management.serviceAvailability !== "ready" ||
		management.desiredState !== "running"
	)
		return unavailable;
	const { state, deployment, verifiedConfiguration: configuration } = runtime;
	if (
		state.agentId !== input.agentId ||
		state.phase !== "ready" ||
		!state.verified ||
		!state.identity ||
		!state.capabilities ||
		state.fence !== management.fence ||
		state.sourceLifecycleRevision !== management.workloadRevision ||
		state.sourceConfigurationRevision !== facts.configuration.revision ||
		state.revision !== runtime.revision ||
		state.verifiedRevision !== state.revision ||
		!isDeepStrictEqual(state.candidate, state.verified) ||
		!isDeepStrictEqual(configuration, state.verified.configuration) ||
		!isDeepStrictEqual(configuration, facts.configuration) ||
		runtime.verifiedSourceReference !== facts.sourceReference ||
		deployment.agentId !== input.agentId ||
		deployment.configRevision !== configuration.revision ||
		deployment.workloadRevision !== state.revision ||
		deployment.fence !== state.fence ||
		deployment.desiredState !== "running" ||
		deployment.imageDigest !== configuration.source.imageDigest
	)
		return unavailable;
	const mode =
		configuration.source.kind === "standard"
			? "platform-adapter"
			: configuration.source.interactionMode;
	const exposure =
		mode === "platform-adapter"
			? "internal-only"
			: configuration.source.kind === "custom" &&
					configuration.source.identityResponsibility === "platform-managed"
				? "platform-auth"
				: "self-managed";
	if (
		deployment.runtimeManifest.interactionMode !== mode ||
		deployment.route.exposure !== exposure
	)
		return unavailable;
	return {
		outcome: "found",
		sourceReference: facts.sourceReference,
		capabilities: { ...state.capabilities },
		interactionUrl: null,
	};
}
