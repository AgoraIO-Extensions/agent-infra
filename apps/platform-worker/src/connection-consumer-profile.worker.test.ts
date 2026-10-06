import { describe, expect, it } from "vitest";
import {
	createProductionConversationRuntimeResolverV2,
	resolveApprovedConnectionConsumerTargetV1,
} from "./conversation-deployment.js";

describe("Worker Connection Consumer profile boundary", () => {
	it("does not prepare a Connection target when the deployment has no profile", () => {
		expect(
			resolveApprovedConnectionConsumerTargetV1(undefined, undefined),
		).toBeUndefined();
	});
	it.each(["consumer", "audience", "egress"] as const)(
		"rejects a %s change against the original approval before Runtime routing",
		(field) => {
			const profile = {
				schemaVersion: 1,
				publicOrigin: "https://connection.example.test",
				mcpPath: "/mcp/v1",
				consumerId: "platform-worker",
				audience: "connection-api",
				egressProfile: { ref: "egress-platform", revision: "r1" },
			};
			if (field === "consumer") profile.consumerId = "other-consumer";
			if (field === "audience") profile.audience = "other-audience";
			if (field === "egress") profile.egressProfile.revision = "r2";
			expect(() =>
				createProductionConversationRuntimeResolverV2({
					workload: {} as never,
					signing: {} as never,
					serviceToken: "synthetic-transport-proof",
					connectionConsumerProfile: profile,
					connectionConsumerApproval: {
						schemaVersion: 1,
						configFingerprint:
							"26062a8f8e5a003ff8047fead83d76c254d9b54834ca5348fb7e4ceee67d205b",
						egressEnforced: true,
						source: { ref: "platform-deployment", revision: "r1" },
					},
				}),
			).toThrow("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
		},
	);
	it("fails closed before Runtime routing when approval is stale", () => {
		expect(() =>
			createProductionConversationRuntimeResolverV2({
				workload: {} as never,
				signing: {} as never,
				serviceToken: "worker-token",
				connectionConsumerProfile: {
					schemaVersion: 1,
					publicOrigin: "https://connection.example.test",
					mcpPath: "/mcp",
					consumerId: "consumer-1",
					audience: "agent-1",
					egressProfile: { ref: "egress/default", revision: "r1" },
				},
				connectionConsumerApproval: {
					schemaVersion: 1,
					configFingerprint: "0".repeat(64),
					egressEnforced: true,
					source: { ref: "main", revision: "abc" },
				},
			}),
		).toThrow("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	});

	it("returns the approved snapshot and exact endpoint target", () => {
		const profile = {
			schemaVersion: 1 as const,
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp/v1",
			consumerId: "platform-worker",
			audience: "connection-api",
			egressProfile: { ref: "egress-platform", revision: "r1" },
		};
		const approved = resolveApprovedConnectionConsumerTargetV1(profile, {
			schemaVersion: 1,
			configFingerprint:
				"26062a8f8e5a003ff8047fead83d76c254d9b54834ca5348fb7e4ceee67d205b",
			egressEnforced: true,
			source: { ref: "platform-deployment", revision: "r1" },
		});
		expect(approved?.profile).toEqual(profile);
		expect(approved?.source).toEqual({
			ref: "platform-deployment",
			revision: "r1",
		});
		expect(approved?.url).toBe("https://connection.example.test/mcp/v1");
	});
});
