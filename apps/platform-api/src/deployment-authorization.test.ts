import { describe, expect, it, vi } from "vitest";

import { createDeploymentAuthorizationAdmission } from "./deployment-authorization.js";
import {
	allocateDeploymentApplicationIds,
	createDeploymentIdentityScope,
} from "./deployment-identity.js";
import type { IdentityContext } from "./http/identity.js";

const identity: IdentityContext = {
	schemaVersion: 1,
	userId: "alice",
	displayName: "Alice",
	accountStatus: "active",
	organizationIds: ["org_01"],
	roles: ["employee"],
	authorizationRevision: "identity_01",
};
const scope = createDeploymentIdentityScope({
	async resolve() {
		return identity;
	},
	async hydrateUsers() {
		return [];
	},
});
const authorityContext = {
	schemaVersion: 1 as const,
	users: [{ userId: "alice", accountStatus: "active" as const }],
	organizationIds: ["org_01"],
};
const request = {
	schemaVersion: 1 as const,
	agentId: "agent_01",
	actorId: "alice",
	requestId: "request_01",
	traceId: "trace_01",
};

describe("deployment authorization admission", () => {
	it("admits initial creation only for the authenticated user's allocated ID", async () => {
		const readAuthority = vi.fn().mockResolvedValue({ outcome: "unavailable" });
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: scope,
			configurationQuery: { readAuthority },
			loadAuthorityContext: async () => authorityContext,
		});
		const ids = await allocateDeploymentApplicationIds({
			identity,
			idempotencyKey: "create_01",
		});
		await scope.requestScope(
			new Request("https://platform.test/api/v2/agent-applications", {
				method: "POST",
				headers: { "Idempotency-Key": "create_01" },
			}),
			async () => {
				expect(
					await admission.authorize({ ...request, agentId: ids.agentId }),
				).toMatchObject({
					status: "admitted",
					authorizationRevision: "identity_01",
					authorityContext,
				});
				expect(await admission.authorize(request)).toMatchObject({
					status: "rejected",
				});
				expect(
					await admission.authorize({
						...request,
						agentId: ids.agentId,
						actorId: "bob",
					}),
				).toMatchObject({ status: "rejected" });
			},
		);
		expect(readAuthority).not.toHaveBeenCalled();
	});

	it("checks persisted Owner authority for every existing Agent mutation", async () => {
		const readAuthority = vi.fn().mockResolvedValue({ outcome: "unavailable" });
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: scope,
			configurationQuery: { readAuthority },
			loadAuthorityContext: async () => authorityContext,
		});
		await scope.requestScope(
			new Request(
				"https://platform.test/api/v2/agents/agent_01/configuration",
				{ method: "PUT" },
			),
			async () => {
				expect(await admission.authorize(request)).toMatchObject({
					status: "rejected",
				});
			},
		);
		expect(readAuthority).toHaveBeenCalledWith({
			agentId: "agent_01",
			actorId: "alice",
			organizationIds: ["org_01"],
			isAdministrator: false,
		});
	});

	it("fails closed when the current directory cannot be loaded", async () => {
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: scope,
			configurationQuery: { readAuthority: vi.fn() },
			loadAuthorityContext: async () => {
				throw new Error("directory unavailable");
			},
		});
		await scope.requestScope(
			new Request(
				"https://platform.test/api/v2/agents/agent_01/configuration",
				{ method: "PUT" },
			),
			async () => {
				await expect(admission.authorize(request)).rejects.toThrow(
					"directory unavailable",
				);
			},
		);
	});
});
