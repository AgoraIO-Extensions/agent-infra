import { resolveApprovedConnectionConsumerProfileV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { describe, expect, it } from "vitest";
import { createProductionConversationRuntimeResolverV2 } from "./conversation-deployment.js";
import { createWorkerRuntimeHostClientV3 } from "./runtime-host-client.js";

describe("Worker Connection Consumer profile boundary", () => {
	it.each([
		["profile missing", { connectionConsumerApproval: {} }],
		["approval missing", { connectionConsumerProfile: {} }],
	])("fails closed when %s", (_label, input) => {
		expect(() =>
			createProductionConversationRuntimeResolverV2({
				workload: {} as never,
				signing: {} as never,
				serviceToken: "worker-token",
				requireConnectionConsumerProfile: true,
				...input,
			}),
		).toThrow("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	});

	it("fails closed before Runtime routing when approval is stale", () => {
		expect(() =>
			createProductionConversationRuntimeResolverV2({
				workload: {} as never,
				signing: {} as never,
				serviceToken: "worker-token",
				requireConnectionConsumerProfile: true,
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

	it("propagates the approved target into the Runtime client without request overrides", async () => {
		const profile = {
			schemaVersion: 1 as const,
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp",
			consumerId: "consumer-1",
			audience: "agent-1",
			egressProfile: { ref: "egress/default", revision: "r1" },
		};
		const approved = resolveApprovedConnectionConsumerProfileV1(profile, {
			schemaVersion: 1,
			configFingerprint:
				"a49b5046695f402af20fa26f761db632d3f1317dc2c3d069afb09b570700e78e",
			egressEnforced: true,
			source: { ref: "platform-deployment", revision: "r1" },
		});
		if (approved.status !== "available") throw new Error("approval missing");
		const target = {
			...approved,
			url: "https://connection.example.test/mcp",
		};
		let received: Headers | undefined;
		const client = createWorkerRuntimeHostClientV3({
			baseUrl: "https://runtime.example.test",
			serviceToken: "worker-token",
			connectionConsumer: target,
			fetch: async (_input, init) => {
				received = new Headers(init?.headers);
				return new Response(
					JSON.stringify({
						schemaVersion: 3,
						executionId: "execution",
						outcome: "not_found",
						hostSessionRef: null,
					}),
				);
			},
		});
		await client.recoverStatus({
			schemaVersion: 3,
			requestId: "request",
			traceId: "trace",
			principal: { kind: "user", id: "actor" },
			channelId: "channel",
			agentId: "agent-1",
			conversationId: "conversation",
			executionId: "execution",
			turnId: "turn",
			sessionGeneration: 1,
			operation: {
				kind: "execution",
				id: "execution",
				deliveryFence: 1,
				executionDeliveryFence: 1,
			},
			hostSessionRef: null,
			originalOperationDigest: "a".repeat(43),
			grant: {
				schemaVersion: 2,
				format: "runtime-execution-jws",
				token: "a.b.c",
			},
		} as never);
		expect(received?.get("x-agent-infra-connection-consumer")).toBe(
			JSON.stringify(target),
		);
	});
});
