import { describe, expect, it, vi } from "vitest";

import { createDeploymentAuthorizationAdmission } from "./deployment-authorization.js";
import {
	allocateDeploymentApplicationIds,
	allocateDeploymentDirectApplicationIds,
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
		await scope.requestScope(
			new Request("https://platform.test/api/v1/agent-applications", {
				method: "POST",
				headers: { "Idempotency-Key": "create_01" },
			}),
			async () => {
				expect(
					await admission.authorize({ ...request, agentId: ids.agentId }),
				).toMatchObject({ status: "rejected" });
			},
		);
		expect(readAuthority).toHaveBeenCalledOnce();
	});

	it("admits direct creation only for a bearer principal's allocated ID", async () => {
		const readAuthority = vi.fn().mockResolvedValue({ outcome: "unavailable" });
		const apiScope = createDeploymentIdentityScope({
			async resolve() {
				return identity;
			},
			async hydrateUsers() {
				return [];
			},
			async resolveApiCredential(credential) {
				const principal =
					credential === "application-key"
						? { kind: "application" as const, id: "application_01" }
						: { kind: "user" as const, id: "alice" };
				return {
					schemaVersion: 1,
					principal,
					accountStatus: "active",
					organizationIds: ["org_01"],
					authorizationRevision: "api_revision_01",
					ownerId: "alice",
					credential: {
						schemaVersion: 1,
						credentialId: "credential_01",
						principal,
						scopes: ["agent:create"],
						expiresAt: null,
						revokedAt: null,
						createdAt: new Date(),
					},
				};
			},
		});
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: apiScope,
			configurationQuery: { readAuthority },
			loadAuthorityContext: async () => authorityContext,
		});
		for (const [credential, kind, principalId] of [
			["application-key", "application", "application_01"],
			["user-key", "user", "alice"],
		] as const) {
			const ids = allocateDeploymentDirectApplicationIds(
				kind,
				principalId,
				"create_01",
			);
			await apiScope.requestScope(
				new Request("https://platform.test/api/v2/agents", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${credential}`,
						"Idempotency-Key": "create_01",
					},
				}),
				async () => {
					expect(
						await admission.authorize({ ...request, agentId: ids.agentId }),
					).toMatchObject({
						status: "admitted",
						authorizationRevision: "api_revision_01",
					});
					await expect(admission.authorize(request)).resolves.toMatchObject({
						status: "rejected",
					});
				},
			);
		}
		await apiScope.requestScope(
			new Request("https://platform.test/api/v2/agents", {
				method: "POST",
				headers: { "Idempotency-Key": "create_01" },
			}),
			async () => {
				await expect(
					admission.authorize({
						...request,
						agentId: allocateDeploymentDirectApplicationIds(
							"user",
							"alice",
							"create_01",
						).agentId,
					}),
				).resolves.toMatchObject({ status: "rejected" });
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

	it("supplies current application IDs for initial availability admission", async () => {
		const readAuthority = vi.fn().mockResolvedValue({ outcome: "unavailable" });
		const loadApplicationIds = vi
			.fn<() => Promise<readonly string[]>>()
			.mockResolvedValue(["application-active"]);
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: scope,
			configurationQuery: { readAuthority },
			loadAuthorityContext: async () => authorityContext,
			loadApplicationIds,
		});
		const ids = await allocateDeploymentApplicationIds({
			identity,
			idempotencyKey: "create-with-application-target",
		});
		await scope.requestScope(
			new Request("https://platform.test/api/v2/agent-applications", {
				method: "POST",
				headers: { "Idempotency-Key": "create-with-application-target" },
			}),
			async () => {
				await expect(
					admission.authorize({ ...request, agentId: ids.agentId }),
				).resolves.toMatchObject({
					status: "admitted",
					authorityContext: { applicationIds: ["application-active"] },
				});
			},
		);
		expect(loadApplicationIds).toHaveBeenCalledOnce();
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
