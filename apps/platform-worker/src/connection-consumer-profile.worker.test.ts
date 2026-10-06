import {
	connectionConsumerProfileFingerprintV1,
	validateConnectionConsumerProfileV1,
} from "@agent-infra/contracts";
import { describe, expect, it } from "vitest";
import { createProductionConversationRuntimeResolverV2 } from "./conversation-deployment.js";
import { createWorkerRuntimeHostClientV3 } from "./runtime-host-client.js";

describe("Worker Connection Consumer profile boundary", () => {
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

	it("propagates the approved target into the Runtime client without request overrides", () => {
		const profile = {
			schemaVersion: 1 as const,
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp",
			consumerId: "consumer-1",
			audience: "agent-1",
			egressProfile: { ref: "egress/default", revision: "r1" },
		};
		const target = validateConnectionConsumerProfileV1(profile, {
			schemaVersion: 1,
			configFingerprint: connectionConsumerProfileFingerprintV1(profile),
			egressEnforced: true,
			source: { ref: "main", revision: "abc" },
		});
		const client = createWorkerRuntimeHostClientV3({
			baseUrl: "https://runtime.example.test",
			serviceToken: "worker-token",
			connectionConsumer: target,
			fetch: async () => {
				throw new Error("request should not be sent");
			},
		});
		expect(client.connectionConsumerTarget()).toEqual(target);
	});
});
