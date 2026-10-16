import { describe, expect, it, vi } from "vitest";

import type { IdentityContext } from "./http/identity.js";
import { createPlatformProjectionReaders } from "./projection.js";

const identity: IdentityContext = {
	schemaVersion: 1,
	userId: "user_01",
	displayName: "Owner",
	accountStatus: "active",
	organizationIds: ["org_01"],
	roles: ["employee"],
	authorizationRevision: "authrev_01",
};

const configuration = {
	agentId: "agent_01",
	revision: 1,
	source: {
		kind: "standard" as const,
		templateId: "codex",
		connectionEnabled: false,
	},
	ownerIds: ["user_01", "user_02"],
	availability: [],
	modelOptions: [],
	defaultModelOptionId: null,
	defaultReasoningLevel: null,
	environment: [],
	channelKinds: [],
	secrets: [],
};

const management = {
	schemaVersion: 1 as const,
	applicationId: "application_01",
	agentId: "agent_01",
	applicantId: "user_01",
	status: "available" as const,
	revision: 1,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready" as const,
	desiredState: "running" as const,
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["user_01", "user_02"],
	availability: [],
	failureCode: null,
};

function readers() {
	const hydrateUsers = vi.fn(async (ids: readonly string[]) =>
		ids.map((userId) => ({
			userId,
			displayName: `Display ${userId}`,
			roles: ["employee"],
		})),
	);
	const projections = createPlatformProjectionReaders({
		identity: { resolve: vi.fn(), hydrateUsers },
		managementQuery: { getAgent: vi.fn() },
		configurationQuery: {
			read: vi.fn(async ({ agentId }: { agentId: string }) => ({
				outcome: "found" as const,
				configuration: {
					...configuration,
					agentId,
					// 第三个 Agent 有另一组 Owner：只能和同一组 Owner 共用解析结果。
					ownerIds:
						agentId === "agent_02" ? ["user_03"] : configuration.ownerIds,
				},
			})),
		} as never,
		presentAgent: vi.fn(async () => ({
			source: { kind: "standard" as const, templateId: "codex" },
			resourceProfile: {
				profileId: "profile_01",
				displayName: "Small",
				estimatedResources: {
					cpuMillicores: 100,
					memoryMiB: 128,
					storageGiB: 1,
				},
			},
			modelOptions: [],
			channels: [{ kind: "web" as const, status: "available" as const }],
			capabilities: {
				modelSelection: false,
				attachments: false,
				resultFiles: false,
				connection: false,
				supplementaryInstruction: false,
			},
			interactionUrl: null,
		})),
	});
	return { projections, hydrateUsers };
}

const agent = (agentId: string) => ({
	schemaVersion: 1 as const,
	agentId,
	applicationId: `application_${agentId}`,
	name: agentId,
	description: "Projection test",
	sourceReference: "sha256:custom",
	management: { ...management, agentId },
});

describe("Agent projection owners (#2632)", () => {
	it("hydrates the same owners once per request and again for the next request", async () => {
		const { projections, hydrateUsers } = readers();
		// 同一个请求：路由为这个请求解析一次身份，列表里的每一项都带着这个身份对象。
		const metadata = {
			identity,
			requestId: "request_01",
			traceId: "trace_01",
			requestScope: {},
		};
		const items = await Promise.all(
			["agent_00", "agent_01", "agent_02", "agent_03"].map((agentId) =>
				projections.readManagementAgentProjection({
					...metadata,
					agent: agent(agentId),
				}),
			),
		);
		expect(
			items.map((item) =>
				item.configuration.owners.map((owner) => owner.userId),
			),
		).toEqual([
			["user_01", "user_02"],
			["user_01", "user_02"],
			["user_03"],
			["user_01", "user_02"],
		]);
		// 之前每个 Agent 都解析一次 Owner（4 次）；现在两组不同的 Owner 各解析一次。
		expect(hydrateUsers).toHaveBeenCalledTimes(2);

		// 下一个请求有自己的身份对象：重新解析，不复用上一个请求的 Owner。
		await projections.readManagementAgentProjection({
			identity: { ...identity },
			requestId: "request_02",
			traceId: "trace_02",
			requestScope: {},
			agent: agent("agent_00"),
		});
		expect(hydrateUsers).toHaveBeenCalledTimes(3);
	});

	it("keeps requests apart even when they share one identity object (#2655)", async () => {
		const { projections, hydrateUsers } = readers();
		// 身份 Adapter 将来可能复用同一个身份对象实例；请求边界只能由每个请求唯一的 requestId 判定。
		const shared = { ...identity };
		const requestScope1 = {};
		const requestScope2 = {};
		const requestScope3 = {};
		hydrateUsers.mockRejectedValueOnce(new Error("PRIVATE_DIRECTORY_DETAIL"));
		await expect(
			projections.readManagementAgentProjection({
				identity: shared,
				requestId: "request_01",
				traceId: "trace_01",
				requestScope: requestScope1,
				agent: agent("agent_00"),
			}),
		).rejects.toMatchObject({ body: { code: "DEPENDENCY_UNAVAILABLE" } });
		// 第二个请求用同一个身份对象：不复用第一个请求失败的解析，重新解析一次。
		await expect(
			projections.readManagementAgentProjection({
				identity: shared,
				requestId: "request_02",
				traceId: "trace_02",
				requestScope: requestScope2,
				agent: agent("agent_00"),
			}),
		).resolves.toMatchObject({ agentId: "agent_00" });
		expect(hydrateUsers).toHaveBeenCalledTimes(2);
		// 同一个请求里仍然只解析一次。
		await Promise.all(
			["agent_01", "agent_03"].map((agentId) =>
				projections.readManagementAgentProjection({
					identity: shared,
					requestId: "request_02",
					traceId: "trace_02",
					requestScope: requestScope2,
					agent: agent(agentId),
				}),
			),
		);
		expect(hydrateUsers).toHaveBeenCalledTimes(2);
		// 第三个请求，同一个身份对象：重新解析。
		await projections.readManagementAgentProjection({
			identity: shared,
			requestId: "request_03",
			traceId: "trace_03",
			requestScope: requestScope3,
			agent: agent("agent_00"),
		});
		expect(hydrateUsers).toHaveBeenCalledTimes(3);
	});

	it("keeps interleaved request scopes from evicting each other", async () => {
		const { projections, hydrateUsers } = readers();
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let calls = 0;
		hydrateUsers.mockImplementation(async (ids) => {
			calls++;
			if (calls === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return ids.map((userId) => ({
				userId,
				displayName: `Display ${userId}`,
				roles: ["employee"],
			}));
		});
		const scopeA = {};
		const scopeB = {};
		const firstA = projections.readManagementAgentProjection({
			identity,
			requestId: "request_a",
			traceId: "trace_a",
			requestScope: scopeA,
			agent: agent("agent_00"),
		});
		await firstStarted.promise;
		await projections.readManagementAgentProjection({
			identity,
			requestId: "request_b",
			traceId: "trace_b",
			requestScope: scopeB,
			agent: agent("agent_00"),
		});
		const secondA = projections.readManagementAgentProjection({
			identity,
			requestId: "request_a",
			traceId: "trace_a",
			requestScope: scopeA,
			agent: agent("agent_01"),
		});
		releaseFirst.resolve();
		await Promise.all([firstA, secondA]);
		expect(calls).toBe(2);
	});

	it("does not reuse a failed owner hydration across requests", async () => {
		const { projections, hydrateUsers } = readers();
		hydrateUsers.mockRejectedValueOnce(new Error("PRIVATE_DIRECTORY_DETAIL"));
		await expect(
			projections.readManagementAgentProjection({
				identity,
				requestId: "request_01",
				traceId: "trace_01",
				requestScope: {},
				agent: agent("agent_00"),
			}),
		).rejects.toMatchObject({ body: { code: "DEPENDENCY_UNAVAILABLE" } });
		await expect(
			projections.readManagementAgentProjection({
				identity: { ...identity },
				requestId: "request_02",
				traceId: "trace_02",
				requestScope: {},
				agent: agent("agent_00"),
			}),
		).resolves.toMatchObject({ agentId: "agent_00" });
		expect(hydrateUsers).toHaveBeenCalledTimes(2);
	});
});
