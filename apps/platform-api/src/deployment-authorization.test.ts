import type { OperationalEvent } from "@agent-infra/observability";
import { createHttpObservability } from "@agent-infra/observability/http";
import { Hono } from "hono";
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
const administrator: IdentityContext = {
	...identity,
	userId: "administrator",
	displayName: "Administrator",
	roles: ["employee", "system_admin"],
};
const administratorScope = createDeploymentIdentityScope({
	async resolve() {
		return administrator;
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
		const readVersionedAuthority = vi
			.fn()
			.mockResolvedValue({ outcome: "unavailable" });
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: scope,
			configurationQuery: { readVersionedAuthority },
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
		expect(readVersionedAuthority).not.toHaveBeenCalled();
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
		expect(readVersionedAuthority).toHaveBeenCalledOnce();
	});

	it("checks persisted Owner authority for every existing Agent mutation", async () => {
		const readVersionedAuthority = vi
			.fn()
			.mockResolvedValue({ outcome: "unavailable" });
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: scope,
			configurationQuery: { readVersionedAuthority },
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
		expect(readVersionedAuthority).toHaveBeenCalledWith({
			agentId: "agent_01",
			actorId: "alice",
			organizationIds: ["org_01"],
			isAdministrator: false,
		});
	});

	it("admits the Owner of a keyless (V3) Agent and still rejects everyone else (#2401)", async () => {
		const readVersionedAuthority = vi.fn(async (query: { actorId: string }) =>
			query.actorId === "alice"
				? {
						outcome: "found" as const,
						configuration: { schemaVersion: 3 },
						management: { agentId: "agent_01", ownerIds: ["alice"] },
						authorizationRevision: "authorization_01",
					}
				: { outcome: "unavailable" as const },
		);
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: scope,
			configurationQuery: { readVersionedAuthority } as never,
			loadAuthorityContext: async () => authorityContext,
		});
		await scope.requestScope(
			new Request(
				"https://platform.test/api/v2/agents/agent_01/configuration",
				{
					method: "PUT",
				},
			),
			async () => {
				expect(await admission.authorize(request)).toMatchObject({
					status: "admitted",
					authorizationRevision: "authorization_01",
				});
				// 请求主体必须是当前登录身份，其他主体不会被放行。
				expect(
					await admission.authorize({ ...request, actorId: "bob" }),
				).toMatchObject({ status: "rejected" });
			},
		);
		expect(readVersionedAuthority).toHaveBeenCalledTimes(1);
	});

	it("marks only access-only administrator updates for Owner rescue", async () => {
		const readVersionedAuthority = vi.fn().mockResolvedValue({
			outcome: "found",
			configuration: {},
			management: { agentId: "agent_01", ownerIds: ["former-owner"] },
			authorizationRevision: "authorization_01",
		});
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: administratorScope,
			configurationQuery: { readVersionedAuthority },
			loadAuthorityContext: async () => authorityContext,
		});
		await administratorScope.requestScope(
			new Request(
				"https://platform.test/api/v2/agents/agent_01/configuration",
				{ method: "PUT" },
			),
			async () => {
				const adminRequest = { ...request, actorId: administrator.userId };
				expect(
					await admission.authorize({ ...adminRequest, accessOnly: true }),
				).toMatchObject({ status: "admitted" });
				expect(
					await admission.authorize({ ...adminRequest, accessOnly: false }),
				).toMatchObject({ status: "admitted" });
			},
		);
		expect(readVersionedAuthority).toHaveBeenNthCalledWith(1, {
			agentId: "agent_01",
			actorId: "administrator",
			organizationIds: ["org_01"],
			isAdministrator: true,
			allowAdministratorRescue: true,
		});
		expect(readVersionedAuthority).toHaveBeenNthCalledWith(2, {
			agentId: "agent_01",
			actorId: "administrator",
			organizationIds: ["org_01"],
			isAdministrator: true,
		});
	});

	it("fails closed when the current directory cannot be loaded", async () => {
		const admission = createDeploymentAuthorizationAdmission({
			identityScope: scope,
			configurationQuery: { readVersionedAuthority: vi.fn() },
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

	describe("failure context when the current authority cannot be loaded (#2696)", () => {
		/** 与生产一样：准入在 HTTP 观测中间件的请求上下文里运行，失败时返回 503。 */
		const observedSubmission = (
			loadAuthorityContext: () => Promise<typeof authorityContext>,
		) => {
			const events: OperationalEvent[] = [];
			const app = new Hono();
			app.use(
				"*",
				createHttpObservability({ record: (event) => events.push(event) }),
			);
			const admission = createDeploymentAuthorizationAdmission({
				identityScope: scope,
				configurationQuery: { readVersionedAuthority: vi.fn() },
				loadAuthorityContext,
			});
			app.post("/api/v2/agent-applications", (context) =>
				scope.requestScope(context.req.raw, async () => {
					const ids = await allocateDeploymentApplicationIds({
						identity,
						idempotencyKey: "create_2696",
					});
					try {
						await admission.authorize({ ...request, agentId: ids.agentId });
						return context.json({ status: "admitted" }, 201);
					} catch {
						return context.json(
							{
								schemaVersion: 1,
								code: "DEPENDENCY_UNAVAILABLE",
								message: "A required service is temporarily unavailable.",
								retryable: true,
								traceId: "trace",
							},
							503,
						);
					}
				}),
			);
			const submit = () =>
				app.request("/api/v2/agent-applications", {
					method: "POST",
					headers: { "Idempotency-Key": "create_2696" },
				});
			return { events, submit };
		};

		it("records the bounded authority.load step and error class without private details", async () => {
			const { events, submit } = observedSubmission(async () => {
				throw new TypeError("PRIVATE_DIRECTORY_MEMBER_alice@example.test");
			});
			const response = await submit();
			expect(response.status).toBe(503);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				outcome: "failed",
				status: 503,
				protocolCode: "DEPENDENCY_UNAVAILABLE",
				failureStep: "authority.load",
				errorClass: "TypeError",
			});
			expect(JSON.stringify(events)).not.toContain("PRIVATE_DIRECTORY_MEMBER");
			expect(JSON.stringify(events)).not.toContain("example.test");
		});

		it("leaves a successful admission without failure fields", async () => {
			const { events, submit } = observedSubmission(
				async () => authorityContext,
			);
			const response = await submit();
			expect(response.status).toBe(201);
			expect(events).toHaveLength(1);
			expect(events[0]).not.toHaveProperty("failureStep");
			expect(events[0]).not.toHaveProperty("errorClass");
		});
	});
});
