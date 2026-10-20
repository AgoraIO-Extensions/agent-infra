import { describe, expect, it } from "vitest";
import {
	AgentDetailProjectionV1Schema,
	AgentOwnerProjectionV1Schema,
	agentDetailOpenApiPathsV1,
} from "./agent-detail.ts";
import { AgentProjectionV2Schema } from "./browser.ts";

const agentV2 = {
	schemaVersion: 2,
	agentId: "agent-a",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	managementStatus: "available",
	serviceAvailability: "ready",
	configuration: {
		owners: [{ userId: "user-a", displayName: "Owner A", roles: ["employee"] }],
		availability: [{ kind: "organization", organizationId: "org-a" }],
		modelOptions: [],
		defaultModelOptionId: null,
		defaultReasoningLevel: null,
		environment: [],
		channels: [{ kind: "web", status: "available" }],
		secrets: [],
	},
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
};
const detail = {
	...agentV2,
	schemaVersion: 1,
	configuration: {
		...agentV2.configuration,
		owners: [
			{ userId: "user-a", displayName: "Owner A", status: "active" },
			{ userId: "user-b", displayName: "Owner B", status: "disabled" },
			{ userId: "user-c", displayName: null, status: "departed" },
			{ userId: "user-d", displayName: null, status: "unavailable" },
		],
	},
};

describe("Agent detail projection contract (#2910)", () => {
	it("accepts every server-resolved Owner status and a missing display name", () => {
		expect(
			AgentDetailProjectionV1Schema.parse(detail).configuration.owners.map(
				(owner) => owner.status,
			),
		).toEqual(["active", "disabled", "departed", "unavailable"]);
	});

	it("rejects unknown statuses, extra Owner fields and an empty Owner list", () => {
		for (const owner of [
			{ userId: "user-a", displayName: "Owner A", status: "unknown" },
			{ userId: "user-a", displayName: "Owner A" },
			{ userId: "user-a", displayName: "", status: "active" },
			{
				userId: "user-a",
				displayName: "Owner A",
				status: "active",
				roles: ["employee"],
			},
			{
				userId: "user-a",
				displayName: "Owner A",
				status: "disabled",
				email: "owner@example.test",
			},
		])
			expect(AgentOwnerProjectionV1Schema.safeParse(owner).success).toBe(false);
		expect(
			AgentDetailProjectionV1Schema.safeParse({
				...detail,
				configuration: { ...detail.configuration, owners: [] },
			}).success,
		).toBe(false);
		expect(
			AgentDetailProjectionV1Schema.safeParse({ ...detail, extra: true })
				.success,
		).toBe(false);
	});

	it("keeps the published V2 projection and the detail projection mutually exclusive", () => {
		// 旧 strict reader 不会收到新字段：V2 仍拒绝带状态的 Owner，详情也不接受旧 Owner 形状。
		expect(AgentProjectionV2Schema.safeParse(agentV2).success).toBe(true);
		expect(
			AgentProjectionV2Schema.safeParse({ ...detail, schemaVersion: 2 })
				.success,
		).toBe(false);
		expect(
			AgentDetailProjectionV1Schema.safeParse({ ...agentV2, schemaVersion: 1 })
				.success,
		).toBe(false);
	});

	it("declares a browser-session-only read", () => {
		const operation =
			agentDetailOpenApiPathsV1["/api/v2/agents/{agentId}/detail"].get;
		expect(operation.operationId).toBe("getAgentDetailV1");
		expect(operation.security).toEqual([{ PlatformSession: [] }]);
		expect(
			operation.requestParams.path.safeParse({ agentId: "agent-a", x: "y" })
				.success,
		).toBe(false);
	});
});
