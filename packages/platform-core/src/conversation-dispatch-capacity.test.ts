import { describe, expect, it } from "vitest";
import type { AgentConfigurationRecordV2 } from "./agent-configuration.js";
import { decideConversationDispatchCapacityV1 } from "./conversation-dispatch-capacity.js";

function snapshot(
	sourceKind: "standard" | "custom" = "standard",
): Parameters<typeof decideConversationDispatchCapacityV1>[0] {
	const imageDigest = `sha256:${"a".repeat(64)}`;
	const version = {
		configuration: {
			schemaVersion: 2,
			agentId: "agent",
			revision: 4,
			source: { kind: sourceKind, imageDigest },
		} as AgentConfigurationRecordV2,
		deployment: { validatedDeployment: "version-4" },
		executionCapacity: {
			schemaVersion: 1 as const,
			imageDigest,
			resourceProfileRef: "standard",
			resourceConfigurationHash: "b".repeat(64),
			conformanceEvidenceHash: "c".repeat(64),
			maximumConcurrentExecutions: 2,
		},
	};
	return {
		agentId: "agent",
		modelConfigurationRevision: sourceKind === "standard" ? 4 : null,
		configurationRevision: 4,
		status: "available",
		desiredState: "running",
		serviceAvailability: "ready",
		workloadRevision: 5,
		fence: 9,
		deployment: {
			agentId: "agent",
			configurationRevision: 4,
			interactionMode: "platform-adapter",
			imageDigest,
			resourceProfileRef: "standard",
		},
		workload: {
			schemaVersion: 1,
			agentId: "agent",
			sourceConfigurationRevision: 4,
			sourceLifecycleRevision: 5,
			revision: 7,
			fence: 9,
			phase: "ready",
			candidate: version,
			verified: structuredClone(version),
			verifiedRevision: 7,
			identity: { uid: "workload", generation: 1 },
			rollback: false,
			failureCode: null,
			attempts: 0,
		},
		occupancy: { processing: 0, unknown: 0 },
	};
}

describe("Core dispatch capacity decision", () => {
	it("admits a custom Agent without a Platform model configuration", () => {
		expect(decideConversationDispatchCapacityV1(snapshot("custom"))).toBe(
			"admit",
		);
	});
	it.each([
		["standard", null],
		["standard", 3],
		["custom", 4],
	] as const)(
		"rejects %s model revision %s that contradicts its source configuration",
		(kind, modelConfigurationRevision) => {
			expect(
				decideConversationDispatchCapacityV1({
					...snapshot(kind),
					modelConfigurationRevision,
				}),
			).toBe("capacity_unavailable");
		},
	);
	it.each([
		[0, 0, "admit"],
		[1, 0, "admit"],
		[0, 1, "admit"],
		[1, 1, "capacity_wait"],
		[0, 2, "capacity_wait"],
		[2, 0, "capacity_wait"],
	] as const)(
		"preserves processing=%s and unknown=%s occupancy",
		(processing, unknown, expected) => {
			expect(
				decideConversationDispatchCapacityV1({
					...snapshot(),
					occupancy: { processing, unknown },
				}),
			).toBe(expected);
		},
	);
	it("rejects a stopped Agent even when its prior Workload and capacity are ready", () => {
		expect(
			decideConversationDispatchCapacityV1({
				...snapshot(),
				desiredState: "stopped",
			}),
		).toBe("capacity_unavailable");
	});
	it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		"does not admit work from invalid occupancy %s",
		(unknown) => {
			expect(
				decideConversationDispatchCapacityV1({
					...snapshot(),
					occupancy: { processing: 0, unknown },
				}),
			).toBe("capacity_unavailable");
		},
	);
	it("does not dispatch the original model selection on a newer configuration", () => {
		expect(
			decideConversationDispatchCapacityV1({
				...snapshot(),
				configurationRevision: 5,
			}),
		).toBe("capacity_unavailable");
	});
	it("does not use a stale lifecycle fence or another Agent's proof", () => {
		expect(
			decideConversationDispatchCapacityV1({ ...snapshot(), fence: 10 }),
		).toBe("capacity_unavailable");
		expect(
			decideConversationDispatchCapacityV1({ ...snapshot(), agentId: "other" }),
		).toBe("capacity_unavailable");
	});
	it("requires a verified current candidate and current resource/image binding", () => {
		const state = snapshot();
		expect(
			decideConversationDispatchCapacityV1({
				...state,
				workload: { ...state.workload, verified: null },
			}),
		).toBe("capacity_unavailable");
		expect(
			decideConversationDispatchCapacityV1({
				...state,
				workload: {
					...state.workload,
					candidate: {
						...state.workload.candidate,
						deployment: { changed: true },
					},
				},
			}),
		).toBe("capacity_unavailable");
		expect(
			decideConversationDispatchCapacityV1({
				...state,
				deployment: { ...state.deployment, resourceProfileRef: "unverified" },
			}),
		).toBe("capacity_unavailable");
	});
});
