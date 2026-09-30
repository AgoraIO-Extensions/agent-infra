import {
	type AgentManagementStateV1,
	createAgentConfigurationUseCaseV1,
} from "@agent-infra/platform-core";
import {
	FakeAgentConfigurationAdmissionsV1,
	FakeAgentConfigurationTransactionV1,
} from "@agent-infra/platform-core/testing";
import { describe, expect, it, vi } from "vitest";

import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
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
		for (const path of [
			"/api/v2/agent-applications",
			"/api/v2/agent-applications/default-key",
		]) {
			await scope.requestScope(
				new Request(`https://platform.test${path}`, {
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
		}
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

	it("uses current application authority for existing Agent access updates", async () => {
		const management: AgentManagementStateV1 = {
			schemaVersion: 1,
			applicationId: "application_01",
			agentId: request.agentId,
			applicantId: identity.userId,
			status: "available",
			revision: 1,
			approvalRevision: 1,
			decisionReason: null,
			serviceAvailability: "ready",
			desiredState: "running",
			workloadRevision: 1,
			fence: 1,
			ownerIds: [identity.userId],
			availability: [],
			failureCode: null,
		};
		await scope.requestScope(
			new Request(
				"https://platform.test/api/v2/agents/agent_01/configuration",
				{ method: "PUT" },
			),
			async () => {
				for (const removedDuringAdmission of [false, true]) {
					const loadApplicationIds = vi
						.fn<() => Promise<readonly string[]>>()
						.mockResolvedValue(["application-active"]);
					if (removedDuringAdmission)
						loadApplicationIds
							.mockResolvedValueOnce(["application-active"])
							.mockResolvedValue([]);
					const admission = createDeploymentAuthorizationAdmission({
						identityScope: scope,
						configurationQuery: {
							readAuthority: vi.fn().mockResolvedValue({
								outcome: "found",
								authorizationRevision: "agent_authority_01",
								management,
							}),
						},
						loadAuthorityContext: async () => authorityContext,
						loadApplicationIds,
					});
					const transaction = new FakeAgentConfigurationTransactionV1(
						agentConfigurationConformanceRecordV1,
						{
							managementState: management,
							authorizationRevision: "agent_authority_01",
						},
					);
					const admissions = new FakeAgentConfigurationAdmissionsV1({
						authorizations: [],
						models: [],
						modelCredentials: [],
					});
					const configuration = createAgentConfigurationUseCaseV1({
						transaction,
						authorizationAdmission: admission,
						imageAdmission: admissions,
						modelAdmission: admissions,
						secretAdmission: admissions,
						channelAdmission: admissions,
					});
					const update = configuration.update(
						{
							schemaVersion: 2,
							agentId: request.agentId,
							idempotencyKey: "update-application-target",
							requestId: request.requestId,
							traceId: request.traceId,
							changes: {
								availability: [
									{ kind: "application", applicationId: "application-active" },
								],
							},
						},
						{
							schemaVersion: 1,
							actorId: identity.userId,
							rawRequestDigest: "a".repeat(64),
						},
					);
					if (removedDuringAdmission) {
						await expect(update).rejects.toMatchObject({
							code: "not_admitted",
						});
						expect(transaction.snapshot().commitCount).toBe(0);
					} else {
						await expect(update).resolves.toMatchObject({
							changedFields: ["availability"],
						});
						expect(
							transaction.snapshot().managementState?.availability,
						).toEqual([
							{ kind: "application", applicationId: "application-active" },
						]);
					}
				}
			},
		);
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
