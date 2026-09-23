import { describe, expect, it } from "vitest";

import { agentConfigurationConformanceRecordV1 } from "./agent-configuration.conformance.js";
import {
	type AgentManagementStateV1,
	isAgentAccessAllowedV1,
} from "./agent-management.js";
import {
	type AgentRuntimePresentationFactsV1,
	decideAgentRuntimePresentationV1,
	snapshotAgentRuntimePresentationExpectationV1,
} from "./agent-runtime-presentation.js";

const management: AgentManagementStateV1 = {
	schemaVersion: 1,
	applicationId: "application_01",
	agentId: "agent_01",
	applicantId: "owner_01",
	status: "available",
	revision: 11,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready",
	desiredState: "running",
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["owner_01"],
	availability: [],
	failureCode: null,
};
const actor = {
	schemaVersion: 1 as const,
	userId: "owner_01",
	accountStatus: "active" as const,
	organizationIds: [],
	isAdministrator: false,
};

function fixture() {
	const configuration = structuredClone(agentConfigurationConformanceRecordV1);
	const deployment = {
		agentId: "agent_01",
		configRevision: configuration.revision,
		workloadRevision: 1,
		fence: 1,
		desiredState: "running" as const,
		imageDigest: configuration.source.imageDigest,
		runtimeManifest: { interactionMode: "platform-adapter" as const },
		route: { exposure: "internal-only" as const },
	};
	const version = {
		configuration,
		deployment,
	} as unknown as import("./workload-reconciliation.js").WorkloadVersionV1;
	const facts: AgentRuntimePresentationFactsV1 = {
		management: structuredClone(management),
		configuration,
		sourceReference: "template_01",
		runtime: {
			revision: 1,
			verifiedConfiguration: configuration,
			verifiedSourceReference: "template_01",
			deployment,
			state: {
				schemaVersion: 1,
				agentId: "agent_01",
				sourceConfigurationRevision: configuration.revision,
				sourceLifecycleRevision: 1,
				revision: 1,
				fence: 1,
				phase: "ready",
				candidate: version,
				verified: version,
				verifiedRevision: 1,
				identity: { uid: "workload_01", generation: 1 },
				rollback: false,
				failureCode: null,
				attempts: 0,
				capabilities: { modelSelection: true },
			},
		},
	};
	return {
		agentId: "agent_01",
		actor,
		facts,
		expected: snapshotAgentRuntimePresentationExpectationV1({
			configurationRevision: configuration.revision,
			management,
		}),
	};
}

describe("Agent runtime presentation policy", () => {
	it.each([false, true])(
		"rejects another Agent's configuration before projecting source or capabilities (runtime present: %s)",
		(hasRuntime) => {
			const input = fixture();
			expect(
				decideAgentRuntimePresentationV1({
					...input,
					facts: {
						...input.facts,
						configuration: {
							...input.facts.configuration,
							agentId: "another-agent",
						},
						sourceReference: "another-agent-source",
						runtime: hasRuntime ? input.facts.runtime : null,
					},
				}),
			).toEqual({ outcome: "stale" });
		},
	);

	it("keeps administrator visibility separate from Owner authority and hides stale resources from unrelated or disabled subjects", () => {
		const input = fixture();
		const administrator = {
			...actor,
			userId: "administrator",
			isAdministrator: true,
		};
		expect(isAgentAccessAllowedV1(management, administrator, "manage")).toBe(
			false,
		);
		expect(
			decideAgentRuntimePresentationV1({ ...input, actor: administrator }),
		).toMatchObject({
			outcome: "found",
			capabilities: { modelSelection: true },
		});
		const stale = {
			...input,
			expected: { ...input.expected, configurationRevision: 1 },
		};
		for (const forbidden of [
			{ ...actor, userId: "unrelated" },
			{ ...administrator, accountStatus: "disabled" as const },
		])
			expect(
				decideAgentRuntimePresentationV1({ ...stale, actor: forbidden }),
			).toEqual({ outcome: "unavailable" });
	});

	it("does not attach an older active runtime to the currently selected configuration after rollback", () => {
		const input = fixture();
		const runtime = input.facts.runtime;
		if (!runtime) throw new Error("Expected verified fixture");
		const revision = input.facts.configuration.revision + 1;
		const facts = {
			...input.facts,
			configuration: { ...input.facts.configuration, revision },
			runtime: {
				...runtime,
				state: {
					...runtime.state,
					sourceConfigurationRevision: revision,
					rollback: true,
				},
			},
		};
		expect(
			decideAgentRuntimePresentationV1({
				...input,
				facts,
				expected: { ...input.expected, configurationRevision: revision },
			}),
		).toEqual({
			outcome: "found",
			sourceReference: "template_01",
			capabilities: null,
			interactionUrl: null,
		});
	});

	it("captures the full upstream management snapshot before asynchronous reads", () => {
		const input = fixture();
		const callerManagement = {
			...management,
			ownerIds: [...management.ownerIds],
		};
		const expected = snapshotAgentRuntimePresentationExpectationV1({
			configurationRevision: input.facts.configuration.revision,
			management: callerManagement,
		});
		callerManagement.ownerIds = ["different-owner"];
		expect(expected.management.ownerIds).toEqual(["owner_01"]);
		expect(
			decideAgentRuntimePresentationV1({
				...input,
				expected,
				facts: {
					...input.facts,
					management: { ...management, serviceAvailability: "updating" },
				},
			}),
		).toEqual({ outcome: "stale" });
	});
});
