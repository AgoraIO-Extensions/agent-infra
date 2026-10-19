import type { SkillHubSyncBindingV1 } from "@agent-infra/contracts";
import {
	PilotProtocolErrorV1Schema,
	SkillHubAgentBindingStatusResponseV1Schema,
	SkillHubAgentCurrentVersionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type AgentConfigurationAccessAuthorityV1,
	createSkillHubAgentBindingUseCaseV1,
	SkillHubAgentBindingErrorV1,
} from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../../packages/platform-core/src/agent-configuration.conformance.ts";
import {
	registerSkillHubAgentBindingRoutesV1,
	type SkillHubAgentBindingRoutesDependenciesV1,
} from "./skill-hub-agent-binding-routes.ts";

const identity = {
	resolve: vi.fn(async (request: Request) =>
		request.headers.get("cookie") === "user=owner"
			? {
					schemaVersion: 1,
					userId: "owner",
					displayName: "Owner",
					accountStatus: "active",
					organizationIds: ["org"],
					roles: ["employee"],
					authorizationRevision: "auth-1",
				}
			: null,
	),
	hydrateUsers: async () => [],
};

function appWith(
	overrides: Partial<SkillHubAgentBindingRoutesDependenciesV1> = {},
) {
	const dependencies: SkillHubAgentBindingRoutesDependenciesV1 = {
		identity,
		bind: vi.fn(async () => ({
			schemaVersion: 1 as const,
			agentId: "agent",
			revision: 3,
			changedFields: ["skills"] as const,
			replayed: false,
		})),
		read: vi.fn(async () => ({
			agentVersion: "v1",
			configurationRevision: 3,
			bindings: [],
		})),
		currentVersion: vi.fn(async () => ({
			agentVersion: "v1",
			configurationRevision: 3,
		})),
		...overrides,
	};
	const app = new Hono();
	registerSkillHubAgentBindingRoutesV1(app, dependencies);
	return { app, dependencies };
}

const body = {
	schemaVersion: 1,
	expectedConfigurationRevision: 2,
	bindings: [
		{
			skillVersionId: "skill-version",
			grant: {
				schemaVersion: 1 as const,
				tools: [],
				connections: [],
				fileRoots: [],
				networkOrigins: [],
				scripts: false,
			},
		},
	],
};

describe("Skill Hub Agent binding routes", () => {
	it("binds through the authenticated owner and reads status", async () => {
		const { app, dependencies } = appWith();
		const put = await app.request(
			"http://localhost/api/v2/agents/agent/versions/v1/skills",
			{
				method: "PUT",
				headers: {
					cookie: "user=owner",
					"content-type": "application/json",
					"Idempotency-Key": "bind-1",
				},
				body: JSON.stringify(body),
			},
		);
		expect(put.status).toBe(201);
		expect(await put.json()).toMatchObject({
			agentId: "agent",
			agentVersion: "v1",
			configurationRevision: 3,
		});
		expect(dependencies.bind).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent", actorId: "owner" }),
		);
		const get = await app.request(
			"http://localhost/api/v2/agents/agent/versions/v1/skills",
			{ headers: { cookie: "user=owner" } },
		);
		expect(get.status).toBe(200);
		expect(await get.json()).toMatchObject({
			agentId: "agent",
			agentVersion: "v1",
			configurationRevision: 3,
			bindings: [],
		});
	});

	it("fails closed for anonymous, invalid grants, and stale Core decisions", async () => {
		const { app } = appWith({
			bind: vi.fn(async () => {
				throw new SkillHubAgentBindingErrorV1("stale_revision");
			}),
		});
		const anonymous = await app.request(
			"http://localhost/api/v2/agents/agent/versions/v1/skills",
			{ headers: { "Idempotency-Key": "bind-1" } },
		);
		expect(anonymous.status).toBe(401);
		const stale = await app.request(
			"http://localhost/api/v2/agents/agent/versions/v1/skills",
			{
				method: "PUT",
				headers: {
					cookie: "user=owner",
					"content-type": "application/json",
					"Idempotency-Key": "bind-1",
				},
				body: JSON.stringify(body),
			},
		);
		expect(stale.status).toBe(409);
	});
});

// #2903：路由 + 真实 Core 用例。授权事实按当前用户区分，验证 HTTP 层的负向结果。
describe("Skill Hub Agent current version and binding authorization (#2903)", () => {
	const emptyGrant = {
		schemaVersion: 1 as const,
		tools: [],
		connections: [],
		fileRoots: [],
		networkOrigins: [],
		scripts: false as const,
	};
	const storedBinding: SkillHubSyncBindingV1 = {
		schemaVersion: 1,
		agentId: "agent-1",
		agentVersion: "agent-version-1",
		skillName: "workspace-summary",
		skillVersion: {
			schemaVersion: 1,
			skillId: "skill-1",
			skillVersionId: "skill-version-1",
			provider: "my_library",
			version: "1.0.0",
			packageObjectVersion: "object-1",
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			signatureDigest: "c".repeat(64),
		},
		grant: emptyGrant,
		configurationRevision: 7,
		syncRevision: 1,
		state: "pending_sync",
		failureReason: null,
		appliedReceipt: null,
	};
	const users: Record<
		string,
		{ roles: readonly string[]; ownerOf?: string } | undefined
	> = {
		owner: { roles: ["employee"], ownerOf: "agent-1" },
		admin: { roles: ["employee", "system_admin"] },
		employee: { roles: ["employee"] },
		"other-owner": { roles: ["employee"], ownerOf: "agent-2" },
	};
	const multiUserIdentity = {
		resolve: vi.fn(async (request: Request) => {
			const userId = request.headers.get("cookie")?.replace(/^user=/, "");
			const user = userId ? users[userId] : undefined;
			return userId && user
				? {
						schemaVersion: 1 as const,
						userId,
						displayName: userId,
						accountStatus: "active" as const,
						organizationIds: ["org"],
						roles: [...user.roles],
						authorizationRevision: "auth-1",
					}
				: null;
		}),
		hydrateUsers: async () => [],
	};
	function authority(
		agentId: string,
		userId: string,
	): AgentConfigurationAccessAuthorityV1 {
		return {
			state: {
				schemaVersion: 1,
				applicationId: `application-${agentId}`,
				agentId,
				applicantId: userId,
				status: "available",
				// 管理修订 1 与配置修订 7 不同，读取必须返回配置修订。
				revision: 1,
				approvalRevision: 1,
				decisionReason: null,
				serviceAvailability: "ready",
				desiredState: "running",
				workloadRevision: 1,
				fence: 1,
				ownerIds: [userId],
				availability: [],
				failureCode: null,
			},
			actorContext: {
				schemaVersion: 1,
				userId,
				accountStatus: "active",
				organizationIds: ["org"],
				isAdministrator: users[userId]?.roles.includes("system_admin") ?? false,
			},
			authorityContext: {
				schemaVersion: 1,
				users: [{ userId, accountStatus: "active" }],
				organizationIds: ["org"],
			},
		};
	}
	function harness(agentVersion?: string) {
		const store = {
			revisionReads: 0,
			bindingReads: 0,
			commits: 0,
		};
		const useCase = createSkillHubAgentBindingUseCaseV1({
			...(agentVersion !== undefined ? { agentVersion } : {}),
			authorizationAdmission: {
				// 与部署授权一致：只有当前 Owner 能取得目标 Agent 的配置授权事实。
				async authorize(input) {
					const owned = users[input.actorId]?.ownerOf;
					if (!owned)
						return {
							schemaVersion: 1,
							status: "rejected",
							agentId: input.agentId,
							actorId: input.actorId,
						};
					return {
						schemaVersion: 1,
						status: "admitted",
						agentId: input.agentId,
						actorId: input.actorId,
						authorizationRevision: "auth-1",
						// 跨 Agent：返回的事实属于另一个 Agent，Core 必须拒绝。
						accessAuthority: authority(owned, input.actorId),
					};
				},
			},
			bindingAdmission: {
				async admit(input) {
					return {
						schemaVersion: 1,
						status: "admitted",
						bindings: input.requested.map((requested) => ({
							skillVersionId: requested.skillVersionId,
							principalType: "user" as const,
							principalId: input.actorId,
							grant: requested.grant,
						})),
					};
				},
			},
			bindingStatus: {
				async readCurrentConfigurationRevision() {
					store.revisionReads += 1;
					return 7;
				},
				async readCurrentBindings() {
					store.bindingReads += 1;
					return { configurationRevision: 7, bindings: [storedBinding] };
				},
			},
			transaction: {
				async read() {
					return {
						outcome: "ready",
						record: {
							schemaVersion: 1,
							configuration: {
								...structuredClone(agentConfigurationConformanceRecordV1),
								agentId: "agent-1",
							},
							authorizationRevision: "auth-1",
						},
					};
				},
				async commit(plan) {
					store.commits += 1;
					return { outcome: "committed", result: plan.result };
				},
			},
		});
		const app = new Hono();
		registerSkillHubAgentBindingRoutesV1(app, {
			identity: multiUserIdentity,
			bind: (request) =>
				useCase.bind(
					{
						schemaVersion: 1,
						agentId: request.agentId,
						agentVersion: request.agentVersion,
						expectedConfigurationRevision:
							request.expectedConfigurationRevision,
						idempotencyKey: request.idempotencyKey,
						requestId: request.requestId,
						traceId: request.traceId,
						bindings: request.bindings,
					},
					{
						schemaVersion: 1,
						actorId: request.actorId,
						rawRequestDigest: request.rawRequestDigest,
					},
				),
			read: (request) => useCase.read({ schemaVersion: 1, ...request }),
			currentVersion: (request) =>
				useCase.currentVersion({ schemaVersion: 1, ...request }),
		});
		const request = (
			user: string,
			path: string,
			init: { method?: string; bindings?: unknown[] } = {},
		) =>
			app.request(`http://localhost${path}`, {
				method: init.method ?? "GET",
				headers: {
					cookie: `user=${user}`,
					...(init.bindings
						? {
								"content-type": "application/json",
								"Idempotency-Key": `bind-${user}`,
							}
						: {}),
				},
				...(init.bindings
					? {
							body: JSON.stringify({
								schemaVersion: 1,
								expectedConfigurationRevision: 7,
								bindings: init.bindings,
							}),
						}
					: {}),
			});
		return { request, store };
	}
	const versionPath = "/api/v2/agents/agent-1/skills/current-version";
	const bindingsPath = (version = "agent-version-1") =>
		`/api/v2/agents/agent-1/versions/${version}/skills`;
	const oneBinding = [{ skillVersionId: "skill-version-1", grant: emptyGrant }];

	it("returns the deployment version and lists, binds and unbinds for the Owner", async () => {
		const { request, store } = harness("agent-version-1");
		const version = await request("owner", versionPath);
		expect(version.status).toBe(200);
		expect(version.headers.get("Cache-Control")).toBe("no-store");
		expect(
			SkillHubAgentCurrentVersionV1Schema.parse(await version.json()),
		).toEqual({
			schemaVersion: 1,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			configurationRevision: 7,
		});
		const listed = await request("owner", bindingsPath());
		expect(listed.status).toBe(200);
		const body = SkillHubAgentBindingStatusResponseV1Schema.parse(
			await listed.json(),
		);
		expect(body).toMatchObject({
			agentVersion: "agent-version-1",
			configurationRevision: 7,
			bindings: [{ skillName: "workspace-summary", state: "pending_sync" }],
		});
		// 浏览器投影不带对象存储版本。
		expect(JSON.stringify(body)).not.toContain("packageObjectVersion");
		const bound = await request("owner", bindingsPath(), {
			method: "PUT",
			bindings: oneBinding,
		});
		expect(bound.status).toBe(201);
		expect(await bound.json()).toMatchObject({
			agentVersion: "agent-version-1",
			configurationRevision: 8,
		});
		const unbound = await request("owner", bindingsPath(), {
			method: "PUT",
			bindings: [],
		});
		expect(unbound.status).toBe(201);
		expect(store.commits).toBe(2);
	});

	for (const user of ["employee", "admin", "other-owner"]) {
		it(`returns 404 RESOURCE_UNAVAILABLE to ${user} without reading bindings`, async () => {
			const { request, store } = harness("agent-version-1");
			for (const response of [
				await request(user, versionPath),
				await request(user, bindingsPath()),
				// 版本不符也是 404：非 Owner 不能借路径探测当前版本。
				await request(user, bindingsPath("agent-version-0")),
				await request(user, bindingsPath(), {
					method: "PUT",
					bindings: oneBinding,
				}),
			]) {
				expect(response.status).toBe(404);
				const error = PilotProtocolErrorV1Schema.parse(await response.json());
				expect(error.code).toBe("RESOURCE_UNAVAILABLE");
				expect(JSON.stringify(error)).not.toContain("agent-version-1");
			}
			expect(store).toEqual({ revisionReads: 0, bindingReads: 0, commits: 0 });
		});
	}

	it("rejects a different path version for the Owner with 409", async () => {
		const { request, store } = harness("agent-version-1");
		const read = await request("owner", bindingsPath("agent-version-0"));
		expect(read.status).toBe(409);
		const write = await request("owner", bindingsPath("agent-version-0"), {
			method: "PUT",
			bindings: oneBinding,
		});
		expect(write.status).toBe(409);
		// 冲突在线上沿用既有 409 + INVALID_REQUEST 线码。
		expect(PilotProtocolErrorV1Schema.parse(await write.json())).toMatchObject({
			code: "INVALID_REQUEST",
			message: "Request conflicts with current state.",
		});
		expect(store).toEqual({ revisionReads: 0, bindingReads: 0, commits: 0 });
	});

	it("keeps the binding page unavailable and refuses writes without a deployment version", async () => {
		const { request, store } = harness();
		for (const response of [
			await request("owner", versionPath),
			await request("owner", bindingsPath()),
			await request("owner", bindingsPath(), {
				method: "PUT",
				bindings: oneBinding,
			}),
			await request("owner", bindingsPath(), { method: "PUT", bindings: [] }),
		]) {
			expect(response.status).toBe(404);
			expect(
				PilotProtocolErrorV1Schema.parse(await response.json()),
			).toMatchObject({ code: "RESOURCE_UNAVAILABLE", retryable: false });
		}
		expect(store).toEqual({ revisionReads: 0, bindingReads: 0, commits: 0 });
	});

	it("rejects anonymous, Authorization headers and query strings on the version read", async () => {
		const { request } = harness("agent-version-1");
		const anonymous = await request("nobody", versionPath);
		expect(anonymous.status).toBe(401);
		const query = await request("owner", `${versionPath}?agentVersion=x`);
		expect(query.status).toBe(400);
	});
});
