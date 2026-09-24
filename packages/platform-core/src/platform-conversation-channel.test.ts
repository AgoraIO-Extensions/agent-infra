import { describe, expect, it } from "vitest";
import type { AgentConfigurationRecordV2 } from "./agent-configuration.js";
import {
	isPlatformConversationChannelCurrentV1,
	type TaskRuntimeAuthorizationRecordV1,
} from "./task-runtime-authorization.js";

function record(
	kind: "standard" | "custom" = "standard",
): TaskRuntimeAuthorizationRecordV1 {
	const configuration = {
		schemaVersion: 2,
		agentId: "agent",
		revision: 1,
		source: {
			kind,
			imageDigest: `sha256:${"a".repeat(64)}`,
			interactionMode: "platform-adapter",
		},
	} as AgentConfigurationRecordV2;
	return {
		authorizationRecordId: "authorization",
		executionId: "execution",
		revokedAt: null,
		agent: {
			schemaVersion: 1,
			applicationId: "application",
			agentId: "agent",
			applicantId: "user",
			status: "available",
			revision: 1,
			approvalRevision: 1,
			decisionReason: null,
			serviceAvailability: "ready",
			desiredState: "running",
			workloadRevision: 1,
			fence: 1,
			ownerIds: ["user"],
			availability: [],
			failureCode: null,
		},
		boundary: {
			schemaVersion: 1,
			principal: { kind: "user", id: "user" },
			agentId: "agent",
			channelId: "web",
			identityRevision: "identity",
			agentAuthorizationRevision: "authority",
			accessSources: [{ kind: "owner", userId: "user" }],
		},
		configurationRevision: 1,
		workload: {
			schemaVersion: 1,
			agentId: "agent",
			sourceLifecycleRevision: 1,
			revision: 1,
			fence: 1,
			verifiedRevision: 1,
			identity: { uid: "workload", generation: 1 },
			rollback: false,
			failureCode: null,
			attempts: 0,
			sourceConfigurationRevision: 1,
			candidate: { configuration, deployment: {} },
			verified: {
				configuration: structuredClone(configuration),
				deployment: {},
			},
			capabilities: { supplementaryInstruction: false },
			phase: "ready",
		},
	};
}
describe("current platform conversation channel", () => {
	it.each(["standard", "custom"] as const)(
		"uses current %s platform compatibility facts",
		(kind) => {
			expect(isPlatformConversationChannelCurrentV1(record(kind))).toBe(true);
		},
	);
	it("keeps a standard template's channel during temporary workload unavailability", () => {
		const current = record();
		const workload = current.workload;
		if (!workload) throw Error();
		expect(
			isPlatformConversationChannelCurrentV1({
				...current,
				workload: {
					...workload,
					phase: "preflight",
					verified: null,
					capabilities: undefined,
				},
			}),
		).toBe(true);
	});
	it("confirms a current custom self-managed configuration cannot use the platform channel", () => {
		const current = record("custom");
		if (!current.workload) throw Error();
		const source = current.workload.candidate.configuration.source;
		if (source.kind !== "custom") throw Error();
		Object.assign(source, { interactionMode: "self-managed" });
		expect(isPlatformConversationChannelCurrentV1(current)).toBe(false);
	});
	it.each([
		"unknown-channel",
		"missing-workload",
		"stale-config",
		"other-agent",
		"unverified-custom",
		"foreign-verified-agent",
	])("treats %s as unavailable without inventing revocation", (failure) => {
		const current = record("custom");
		const workload = current.workload;
		if (!workload) throw Error();
		if (failure === "unknown-channel")
			Object.assign(current.boundary, { channelId: "unconfigured" });
		if (failure === "missing-workload")
			Object.assign(current, { workload: null });
		if (failure === "stale-config")
			Object.assign(current, { configurationRevision: 2 });
		if (failure === "other-agent")
			Object.assign(current.boundary, { agentId: "other" });
		if (failure === "unverified-custom")
			Object.assign(workload, { verified: null });
		if (failure === "foreign-verified-agent")
			Object.assign(workload.verified?.configuration ?? {}, {
				agentId: "other",
			});
		expect(() => isPlatformConversationChannelCurrentV1(current)).toThrow();
	});
});
