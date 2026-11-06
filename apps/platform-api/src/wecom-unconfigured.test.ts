import { PilotProtocolErrorV1Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it, vi } from "vitest";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi } from "./assembly.js";

const owner = {
	schemaVersion: 1,
	userId: "owner",
	displayName: "Owner",
	accountStatus: "active",
	organizationIds: ["organization"],
	roles: ["employee"],
	authorizationRevision: "current",
};

async function unconfigured(identity: unknown) {
	const fixture = await import(
		new URL(
			"../../../tests/fixtures/platform-api-deployment.mjs",
			import.meta.url,
		).href
	);
	const input = fixture.createPlatformApiAssemblyInput();
	input.identity.resolve = async () => identity;
	const assembly = assemblePlatformApi(input);
	expect(assembly.dependencies.wecomSetup).toBeUndefined();
	const read = vi
		.spyOn(assembly.dependencies.configuration.configurationQuery, "read")
		.mockImplementation(async ({ agentId, actorId, isAdministrator }) =>
			agentId === "agent" && (actorId === "owner" || isAdministrator)
				? {
						outcome: "found",
						configuration: {
							agentId,
							revision: 1,
							source: {
								kind: "standard",
								templateId: "codex",
								connectionEnabled: false,
							},
							ownerIds: ["owner"],
							availability: [],
							modelOptions: [],
							defaultModelOptionId: null,
							defaultReasoningLevel: null,
							environment: [],
							channelKinds: [],
							secrets: [],
						},
					}
				: { outcome: "unavailable" },
		);
	return { assembly, read, app: createPlatformApp(assembly.dependencies) };
}

describe("unconfigured WeCom status in the complete Platform app (#2911)", () => {
	it.each([
		["Owner", owner, "agent", 503, "DEPENDENCY_UNAVAILABLE"],
		["anonymous", null, "agent", 401, "AUTHENTICATION_REQUIRED"],
		[
			"disabled Owner",
			{ ...owner, accountStatus: "disabled" },
			"agent",
			403,
			"AUTHORIZATION_REVOKED",
		],
		[
			"non-Owner",
			{ ...owner, userId: "other" },
			"agent",
			404,
			"RESOURCE_UNAVAILABLE",
		],
		[
			"non-Owner administrator",
			{ ...owner, userId: "other", roles: ["employee", "system_admin"] },
			"agent",
			404,
			"RESOURCE_UNAVAILABLE",
		],
		["missing Agent", owner, "missing", 404, "RESOURCE_UNAVAILABLE"],
	] as const)(
		"returns the published error for %s",
		async (_, identity, id, status, code) => {
			const { assembly, read, app } = await unconfigured(identity);
			try {
				const response = await app.request(
					`/api/v2/agents/${id}/wecom-bot?actorId=owner&isAdministrator=true`,
				);
				expect(response.status).toBe(status);
				const body = PilotProtocolErrorV1Schema.parse(await response.json());
				expect(body.code).toBe(code);
				expect(body).not.toHaveProperty("qrAvailable");
				expect(body).not.toHaveProperty("state");
				if (status === 401 || status === 403)
					expect(read).not.toHaveBeenCalled();
				else
					expect(read).toHaveBeenCalledWith({
						agentId: id,
						actorId: identity?.userId,
						organizationIds: ["organization"],
						isAdministrator: false,
						intent: "manage",
					});
			} finally {
				await assembly.close();
			}
		},
	);

	it("keeps an Owner-query failure unavailable without exposing its details", async () => {
		const { assembly, read, app } = await unconfigured(owner);
		read.mockRejectedValueOnce(new Error("private dependency sentinel"));
		try {
			const response = await app.request("/api/v2/agents/agent/wecom-bot");
			expect(response.status).toBe(503);
			const body = await response.text();
			expect(PilotProtocolErrorV1Schema.parse(JSON.parse(body)).code).toBe(
				"DEPENDENCY_UNAVAILABLE",
			);
			expect(body).not.toContain("private dependency sentinel");
		} finally {
			await assembly.close();
		}
	});
});
