import * as platformCore from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";

import { assemblePlatformApi } from "./assembly.js";

// 只包一层间谍，行为与真实实现完全一致：用来观察装配交给用例的依赖。
vi.mock("@agent-infra/platform-core", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@agent-infra/platform-core")>();
	return {
		...actual,
		createAgentConfigurationUseCaseV1: vi.fn(
			actual.createAgentConfigurationUseCaseV1,
		),
		createApplicationRevisionUseCaseV1: vi.fn(
			actual.createApplicationRevisionUseCaseV1,
		),
	};
});

const unavailable = async () => {
	throw new Error("unused test adapter");
};
const identity = {
	schemaVersion: 1 as const,
	userId: "user-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const],
	authorizationRevision: "authorization-1",
};

function assemble(agentDefaultRelayKeys?: {
	currentIdentity: () => Promise<never>;
	encrypt: () => never;
	candidates: () => Promise<never>;
}) {
	return assemblePlatformApi({
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
		identity: {
			resolve: vi.fn().mockResolvedValue(identity),
			hydrateUsers: vi.fn().mockResolvedValue([]),
			resolveUser: vi.fn().mockResolvedValue({
				schemaVersion: 1,
				userId: identity.userId,
				accountStatus: "active",
				organizationIds: identity.organizationIds,
				authorizationRevision: "directory-1",
			}),
		},
		...(agentDefaultRelayKeys ? { agentDefaultRelayKeys } : {}),
		admissions: {
			authorizationAdmission: { authorize: unavailable },
			imageAdmission: { admitImage: unavailable },
			modelAdmission: { admitModels: unavailable },
			keylessModelAdmission: { admitModels: unavailable },
			secretAdmission: { admitSecrets: unavailable },
			channelAdmission: { admitChannels: unavailable },
		},
		allocateApplicationIds: unavailable,
		prepareApplicationSecrets: unavailable,
		prepareConfigurationSecrets: unavailable,
		presentAgent: unavailable,
	});
}

describe("Platform API assembly of the default Relay Key ports (#2421)", () => {
	it("hands the same Key ports to creation, revision and configuration update", async () => {
		const ports = {
			currentIdentity: vi.fn(),
			encrypt: vi.fn(),
			candidates: vi.fn(),
		};
		vi.mocked(platformCore.createAgentConfigurationUseCaseV1).mockClear();
		vi.mocked(platformCore.createApplicationRevisionUseCaseV1).mockClear();
		const assembly = assemble(ports as never);
		try {
			// 创建申请本来就接收这组端口；修订和配置更新必须与它共用同一组，
			// 否则带 Key 的更换模型请求会在服务端因缺少依赖而失败。
			for (const create of [
				platformCore.createApplicationRevisionUseCaseV1,
				platformCore.createAgentConfigurationUseCaseV1,
			])
				expect(vi.mocked(create).mock.calls[0]?.[0]).toMatchObject({
					defaultRelayKey: ports,
					keylessModelAdmission: expect.anything(),
				});
		} finally {
			await assembly.close();
		}
	});

	it("does not invent Key ports when the deployment has none", async () => {
		vi.mocked(platformCore.createAgentConfigurationUseCaseV1).mockClear();
		vi.mocked(platformCore.createApplicationRevisionUseCaseV1).mockClear();
		const assembly = assemble();
		try {
			for (const create of [
				platformCore.createApplicationRevisionUseCaseV1,
				platformCore.createAgentConfigurationUseCaseV1,
			])
				expect(vi.mocked(create).mock.calls[0]?.[0]).not.toHaveProperty(
					"defaultRelayKey",
				);
		} finally {
			await assembly.close();
		}
	});
});
