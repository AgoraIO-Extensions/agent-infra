import { createHash } from "node:crypto";
import {
	AgentApiLifecycleAcceptedResponseV1Schema,
	AgentApplicationProjectionV2Schema,
	AgentCreationFailureProjectionV1Schema,
	AgentProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import type { OperationalEvent } from "@agent-infra/observability";
import {
	ApplicationRevisionError,
	createPersonalApiAgentReadUseCaseV1,
	type PersonalApiAgentReadAuditV1,
	type PersonalApiAgentReadUseCaseV1,
} from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createPlatformHealthApp } from "../app.js";
import { StaleProjectionError } from "./common.js";
import { registerV2ManagementRoutes } from "./v2-management-routes.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const],
	authorizationRevision: "authorization-1",
};

const management = {
	schemaVersion: 1 as const,
	applicationId: "application-1",
	agentId: "agent-1",
	applicantId: "user-1",
	status: "pending_approval" as const,
	revision: 3,
	approvalRevision: null,
	decisionReason: null,
	serviceAvailability: null,
	desiredState: "running" as const,
	workloadRevision: 0,
	fence: 0,
	ownerIds: ["user-1"],
	availability: [{ kind: "organization" as const, organizationId: "org-1" }],
	failureCode: null,
};

const configuration = {
	owners: [
		{ userId: "user-1", displayName: "Ada", roles: ["employee" as const] },
	],
	availability: management.availability,
	modelOptions: [],
	defaultModelOptionId: null,
	defaultReasoningLevel: null,
	actions: [],
	environment: [],
	channels: [{ kind: "web" as const, status: "available" as const }],
	secrets: [],
};

const applicationRecord = {
	schemaVersion: 1 as const,
	applicationId: "application-1",
	agentId: "agent-1",
	applicantId: "user-1",
	name: "Release assistant",
	description: "Helps the release team",
	sourceReference: "template-1",
	management,
	submittedAt: new Date("2026-09-01T00:00:00Z"),
	decision: null,
};

const agentRecord = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	applicationId: "application-1",
	name: "Release assistant",
	description: "Helps the release team",
	sourceReference: "template-1",
	management,
};

const applicationProjection = {
	schemaVersion: 1 as const,
	applicationId: "application-1",
	agentId: "agent-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard" as const, templateId: "template-1" },
	status: "pending_approval" as const,
	resourceProfile: {
		profileId: "standard-medium",
		displayName: "Standard medium",
		estimatedResources: {
			cpuMillicores: 2000,
			memoryMiB: 4096,
			storageGiB: 20,
		},
	},
	configuration,
	submittedAt: "2026-09-01T00:00:00.000Z",
	decision: null,
};

const agentProjection = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard" as const, templateId: "template-1" },
	managementStatus: "available" as const,
	serviceAvailability: "ready" as const,
	configuration,
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
};

function createApp(
	options: {
		administrator?: boolean;
		identityFailure?: boolean;
		identityValue?: unknown;
		queryFailure?: boolean;
		projectionFailure?: boolean;
		projectionFailureAfterCommand?: boolean;
		personalApiAgentRead?: PersonalApiAgentReadUseCaseV1;
		/** 与生产应用一样挂上 HTTP 遥测，事件收集到这个数组里（#2569）。 */
		telemetry?: OperationalEvent[];
	} = {},
) {
	const app = options.telemetry
		? createPlatformHealthApp({
				record: (event) => options.telemetry?.push(event),
				status: () => ({
					enabled: true,
					state: "active" as const,
					captureFailures: 0,
					exportFailures: 0,
					lastExportFailureAt: undefined,
					droppedLogs: 0,
					invalidRecords: 0,
				}),
			})
		: new Hono();
	const submit = vi.fn().mockResolvedValue({});
	const executeManagementCommand = vi.fn().mockResolvedValue({
		outcome: "accepted",
		result: {
			schemaVersion: 1,
			applicationId: "application-1",
			agentId: "agent-private-1",
			status: "available",
			revision: 2,
		},
		writePlan: {},
	});
	const listApplications = vi.fn().mockResolvedValue({
		items: [applicationRecord],
		nextAfterId: null,
	});
	const getApplication = vi.fn().mockResolvedValue(applicationRecord);
	const listAgents = options.queryFailure
		? vi.fn().mockRejectedValue(new Error("private query detail"))
		: vi.fn().mockResolvedValue({ items: [agentRecord], nextAfterId: null });
	const getAgent = vi.fn().mockResolvedValue(agentRecord);
	const readApplicationProjection = vi
		.fn()
		.mockResolvedValue(applicationProjection);
	let projectionReads = 0;
	const readAgentProjection = vi.fn().mockImplementation(async () => {
		projectionReads += 1;
		if (
			options.projectionFailure ||
			(options.projectionFailureAfterCommand && projectionReads > 1)
		)
			throw new Error("private projection detail");
		return agentProjection;
	});
	const readApiAgentProjection = options.projectionFailure
		? vi.fn().mockRejectedValue(new Error("private API projection detail"))
		: vi.fn().mockResolvedValue(agentProjection);
	const allocateApplicationIds = vi
		.fn()
		.mockResolvedValue({ applicationId: "application-1", agentId: "agent-1" });
	const revise = vi.fn().mockResolvedValue({});
	const upgradeCustomImage = vi.fn().mockResolvedValue({});

	const resolve = options.identityFailure
		? vi.fn().mockRejectedValue(new Error("private identity detail"))
		: vi.fn().mockResolvedValue(
				options.identityValue === undefined
					? {
							...identity,
							roles: options.administrator
								? (["employee", "system_admin"] as const)
								: identity.roles,
						}
					: options.identityValue,
			);

	registerV2ManagementRoutes(app, {
		personalApiAgentRead: options.personalApiAgentRead,
		readApiAgentProjection,
		identity: {
			resolve,
			hydrateUsers: vi.fn().mockResolvedValue([]),
		},
		foundation: { submit },
		revision: { revise },
		management: { executeManagementCommand },
		configuration: { upgradeCustomImage },
		query: { listApplications, getApplication, listAgents, getAgent },
		allocateApplicationIds,
		prepareSecretReplacements: vi.fn().mockResolvedValue({ secrets: [] }),
		validateDefaultRelayKey: vi.fn().mockResolvedValue("valid"),
		enforceDefaultRelayKey: true,
		readApplicationProjection,
		readAgentProjection,
	});

	return {
		app,
		submit,
		revise,
		executeManagementCommand,
		listAgents,
		getAgent,
		listApplications,
		getApplication,
		resolve,
		readAgentProjection,
		readApplicationProjection,
		readApiAgentProjection,
		upgradeCustomImage,
	};
}

function apiReader() {
	const material = `papi_${"b".repeat(43)}`;
	const credentialHash = createHash("sha256").update(material).digest("hex");
	const credential = {
		credentialId: "credential-used",
		principalType: "user" as const,
		principalId: "user-api",
		scopes: ["agent:read" as const],
		expiresAt: null,
		revokedAt: null as string | null,
		createdAt: "2026-10-01T00:00:00Z",
		lastUsedAt: null,
	};
	const audits: PersonalApiAgentReadAuditV1[] = [];
	const recordAudit = vi.fn().mockImplementation(async (event) => {
		audits.push(event);
	});
	const {
		displayName: _displayName,
		roles: _roles,
		...browserFacts
	} = identity;
	const resolveUser = vi
		.fn()
		.mockResolvedValue({ ...browserFacts, userId: "user-api" });
	const reader = createPersonalApiAgentReadUseCaseV1({
		userDirectory: { resolveUser },
		transaction: {
			async executeAgentRead(work) {
				return work({
					async lockUsedCredential(hash) {
						return hash === credentialHash ? { ...credential } : null;
					},
					async lockUserDisabled() {
						return false;
					},
					async lockAgentGrants() {},
					async databaseTime() {
						return new Date("2026-10-01T00:00:01Z");
					},
					async markCredentialUsed() {},
					recordAudit,
				});
			},
			recordAgentReadAudit: recordAudit,
		},
	});
	return {
		reader,
		material,
		credentialHash,
		credential,
		audits,
		recordAudit,
		resolveUser,
	};
}

describe("personal Bearer GET Agents boundary", () => {
	it("uses the actual credential's user and explicit API scope with no browser or Owner projection", async () => {
		const api = apiReader();
		const h = createApp({
			personalApiAgentRead: api.reader,
			administrator: true,
		});
		const response = await h.app.request(
			"/api/v2/agents?limit=10&cursor=agent-0",
			{
				headers: {
					Authorization: `Bearer ${api.material}`,
				},
			},
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = (await response.json()) as { items: unknown[] };
		const projected = AgentProjectionV2Schema.parse(body.items[0]);
		expect(projected.schemaVersion).toBe(2);
		expect(projected.configuration).not.toHaveProperty("actions");
		expect(h.listAgents).toHaveBeenCalledExactlyOnceWith(
			{ kind: "api_user", userId: "user-api" },
			{ limit: 10, afterId: "agent-0" },
		);
		expect(h.resolve).not.toHaveBeenCalled();
		expect(h.readAgentProjection).not.toHaveBeenCalled();
		expect(api.resolveUser).toHaveBeenCalledWith("user-api");
		expect(api.audits[0]).toMatchObject({
			userId: "user-api",
			credentialId: "credential-used",
			outcome: "succeeded",
		});
		expect(JSON.stringify(body)).not.toContain(api.material);
		expect(JSON.stringify(body)).not.toContain(api.credentialHash);
	});

	it("rejects the same material after individual revocation and does not substitute browser authority", async () => {
		const api = apiReader();
		const h = createApp({
			personalApiAgentRead: api.reader,
			administrator: true,
		});
		const headers = { Authorization: `Bearer ${api.material}` };
		expect((await h.app.request("/api/v2/agents", { headers })).status).toBe(
			200,
		);
		api.credential.revokedAt = "2026-10-01T00:00:01Z";
		const rejected = await h.app.request("/api/v2/agents", { headers });
		expect(rejected.status).toBe(401);
		expect(PilotProtocolErrorV1Schema.parse(await rejected.json()).code).toBe(
			"AUTHENTICATION_REQUIRED",
		);
		expect(h.listAgents).toHaveBeenCalledTimes(1);
		expect(h.resolve).not.toHaveBeenCalled();
	});

	it("rejects Owner/admin scopes, mixed Cookie and every unsupported Authorization scheme", async () => {
		const api = apiReader();
		const h = createApp({
			personalApiAgentRead: api.reader,
			administrator: true,
		});
		for (const [url, headers] of [
			[
				"/api/v2/agents?scope=owner",
				{ Authorization: `Bearer ${api.material}` },
			],
			["/api/v2/admin/agents", { Authorization: `Bearer ${api.material}` }],
			[
				"/api/v2/agents",
				{
					Authorization: `Bearer ${api.material}`,
					Cookie: "__Host-platform-session=admin",
				},
			],
			["/api/v2/agents", { Authorization: "Basic caller-submitted" }],
			["/api/v2/agents", { Authorization: "Bearer unknown" }],
		] as const)
			expect((await h.app.request(url, { headers })).status).toBe(401);
		expect(h.listAgents).not.toHaveBeenCalled();
		expect(h.resolve).not.toHaveBeenCalled();
		expect(api.resolveUser).not.toHaveBeenCalled();
	});

	it("retains strict API paging and rejects self-reported principal or grant fields", async () => {
		const api = apiReader();
		const h = createApp({ personalApiAgentRead: api.reader });
		for (const query of [
			"userId=user-other",
			"applicationId=application-other",
			"principal=user-other",
			"recipient=user-other",
			"role=system_admin",
			"grant=manage",
			"limit=101",
			"limit=2&limit=3",
			"cursor=first&cursor=second",
		]) {
			expect(
				(
					await h.app.request(`/api/v2/agents?${query}`, {
						headers: { Authorization: `Bearer ${api.material}` },
					})
				).status,
			).toBe(400);
		}
		expect(h.listAgents).not.toHaveBeenCalled();
		expect(h.resolve).not.toHaveBeenCalled();
	});

	it.each([
		"x-user-id",
		"x-application-id",
		"x-principal",
		"x-principal-id",
		"x-recipient",
		"x-recipient-user-id",
		"x-role",
		"x-roles",
		"x-scope",
		"x-agent-id",
		"x-identity-context",
	])("rejects self-reported authority in %s", async (header) => {
		const api = apiReader();
		const h = createApp({ personalApiAgentRead: api.reader });
		const response = await h.app.request("/api/v2/agents", {
			headers: {
				Authorization: `Bearer ${api.material}`,
				[header]: "untrusted-authority",
			},
		});
		expect(response.status).toBe(400);
		expect(h.listAgents).not.toHaveBeenCalled();
		expect(api.resolveUser).not.toHaveBeenCalled();
		expect(api.audits[0]).toMatchObject({
			userId: null,
			credentialId: null,
			outcome: "rejected",
			details: { reason: "invalid_input" },
		});
	});

	it("withholds authorized results on required audit failure and keeps revoked requests rejected", async () => {
		const api = apiReader();
		api.recordAudit.mockRejectedValue(
			new Error(`private audit ${api.material}`),
		);
		const h = createApp({ personalApiAgentRead: api.reader });
		const headers = { Authorization: `Bearer ${api.material}` };
		const unavailable = await h.app.request("/api/v2/agents", { headers });
		expect(unavailable.status).toBe(503);
		expect(await unavailable.text()).not.toContain(api.material);
		api.credential.revokedAt = "2026-10-01T00:00:01Z";
		expect((await h.app.request("/api/v2/agents", { headers })).status).toBe(
			401,
		);
	});
});

const headers = {
	"content-type": "application/json",
	"Idempotency-Key": "Command.Aa-01",
};

const applicationBody = {
	schemaVersion: 2,
	defaultRelayKey: "agent-default-relay-key",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "template-1" },
	coOwnerIds: [],
	availability: [{ kind: "organization", organizationId: "org-1" }],
	environment: [],
	secrets: [],
	modelConfiguration: {
		options: [
			{
				optionId: "option-a",
				endpointId: "endpoint-a",
				modelId: "model-a",
				reasoningLevels: ["medium"],
			},
		],
		defaultOptionId: "option-a",
		defaultReasoningLevel: "medium",
	},
};

describe("V2 management routes", () => {
	it("reads the administrator page through Core without expanding the ordinary list scope", async () => {
		const { app, listAgents, submit, executeManagementCommand } = createApp({
			administrator: true,
		});
		listAgents.mockResolvedValueOnce({
			items: [agentRecord],
			nextAfterId: "agent-1",
		});
		const response = await app.request(
			"/api/v2/admin/agents?limit=1&cursor=agent-0",
		);
		expect(response.status).toBe(200);
		expect(listAgents).toHaveBeenCalledWith(
			{ kind: "administrator" },
			{ limit: 1, afterId: "agent-0" },
		);
		const page = (await response.json()) as {
			items: unknown[];
			nextCursor: string;
		};
		expect(page.nextCursor).toBe("agent-1");
		expect(AgentProjectionV2Schema.parse(page.items[0])).toMatchObject({
			agentId: "agent-1",
			configuration: { owners: configuration.owners },
		});
		expect(page.items[0]).not.toHaveProperty("applicant");
		expect(submit).not.toHaveBeenCalled();
		expect(executeManagementCommand).not.toHaveBeenCalled();

		expect((await app.request("/api/v2/agents")).status).toBe(200);
		expect(listAgents).toHaveBeenLastCalledWith(
			{ kind: "user", userId: identity.userId, organizationIds: ["org-1"] },
			{ limit: 50 },
		);
	});

	it("rejects employees and disabled or absent current identities before querying", async () => {
		for (const [identityValue, status, code] of [
			[identity, 403, "RESOURCE_UNAVAILABLE"],
			[
				{ ...identity, roles: ["system_admin"], accountStatus: "disabled" },
				403,
				"AUTHORIZATION_REVOKED",
			],
			[null, 401, "AUTHENTICATION_REQUIRED"],
		] as const) {
			const { app, listAgents } = createApp({ identityValue });
			const response = await app.request("/api/v2/admin/agents", {
				headers: { "x-user-id": "admin", "x-role": "system_admin" },
			});
			expect(response.status).toBe(status);
			expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
				code,
			);
			expect(listAgents).not.toHaveBeenCalled();
		}
	});

	it("rejects API credentials even alongside a resolved administrator browser identity", async () => {
		const { app, listAgents, resolve } = createApp({ administrator: true });
		const response = await app.request("/api/v2/admin/agents", {
			headers: {
				Authorization: "Bearer fixture-api-credential",
				Cookie: "fixture-browser-session=admin",
			},
		});
		expect(response.status).toBe(401);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"AUTHENTICATION_REQUIRED",
		);
		expect(resolve).not.toHaveBeenCalled();
		expect(listAgents).not.toHaveBeenCalled();
	});

	it("rechecks the current administrator role and rejects caller-selected identities or scopes", async () => {
		const { app, listAgents, resolve } = createApp({ administrator: true });
		for (const query of [
			"scope=administrator",
			"userId=admin",
			"role=system_admin",
		]) {
			expect((await app.request(`/api/v2/admin/agents?${query}`)).status).toBe(
				400,
			);
		}
		expect(listAgents).not.toHaveBeenCalled();
		expect((await app.request("/api/v2/admin/agents")).status).toBe(200);
		resolve.mockResolvedValueOnce(identity);
		expect((await app.request("/api/v2/admin/agents")).status).toBe(403);
		expect(listAgents).toHaveBeenCalledTimes(1);
	});

	it("fails closed for administrator read dependencies without exposing private details", async () => {
		for (const failure of [
			{ identityFailure: true },
			{ queryFailure: true },
			{ projectionFailure: true },
		]) {
			const { app } = createApp({ administrator: true, ...failure });
			const response = await app.request("/api/v2/admin/agents");
			expect(response.status).toBe(503);
			const error = PilotProtocolErrorV1Schema.parse(await response.json());
			expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
			expect(JSON.stringify(error)).not.toContain("private");
		}
	});

	// #3033：管理员读取单个 Agent，供不在使用范围内的管理员进入配置页与停用。
	it("reads one Agent in administrator scope with the list projection and leaves the ordinary read in user scope", async () => {
		const { app, getAgent, readAgentProjection, executeManagementCommand } =
			createApp({ administrator: true });
		const response = await app.request("/api/v2/admin/agents/agent-1");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(getAgent).toHaveBeenCalledExactlyOnceWith(
			{ kind: "administrator" },
			"agent-1",
		);
		const body = await response.json();
		const projected = AgentProjectionV2Schema.parse(body);
		// Owner 来自服务端投影，与管理员列表项相同；不带旧 Action 或申请人字段。
		expect(projected).toMatchObject({
			agentId: "agent-1",
			configuration: { owners: configuration.owners },
		});
		expect(projected.configuration).not.toHaveProperty("actions");
		expect(body).not.toHaveProperty("applicant");
		expect(readAgentProjection).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				agent: agentRecord,
				identity: expect.objectContaining({
					userId: identity.userId,
					roles: ["employee", "system_admin"],
				}),
			}),
		);
		expect(executeManagementCommand).not.toHaveBeenCalled();

		// 普通读取的范围不随管理员入口扩大。
		expect((await app.request("/api/v2/agents/agent-1")).status).toBe(200);
		expect(getAgent).toHaveBeenLastCalledWith(
			{ kind: "user", userId: identity.userId, organizationIds: ["org-1"] },
			"agent-1",
		);
	});

	// #3070：浏览器授予或撤销用户 API 授权要带管理修订号；只有当前 Owner 能从详情拿到它。
	it("returns the management revision only to a current Owner (#3070)", async () => {
		const owner = createApp();
		const ownerBody = AgentProjectionV2Schema.parse(
			await (await owner.app.request("/api/v2/agents/agent-1")).json(),
		);
		expect(ownerBody.managementRevision).toBe(management.revision);
		const ownerList = (await (
			await owner.app.request("/api/v2/agents")
		).json()) as { items: unknown[] };
		expect(
			AgentProjectionV2Schema.parse(ownerList.items[0]).managementRevision,
		).toBe(management.revision);

		// 非 Owner（包括不是 Owner 的系统管理员）即使能读到这个 Agent，也拿不到修订号。
		for (const roles of [["employee"], ["employee", "system_admin"]]) {
			const other = createApp({
				identityValue: { ...identity, userId: "user-2", roles },
			});
			const response = await other.app.request("/api/v2/agents/agent-1");
			expect(response.status).toBe(200);
			expect(await response.json()).not.toHaveProperty("managementRevision");
			const admin = await other.app.request("/api/v2/admin/agents/agent-1");
			if (admin.status === 200)
				expect(await admin.json()).not.toHaveProperty("managementRevision");
		}
	});

	it("returns the ordinary unavailable result when the administrator scope has no such Agent", async () => {
		const { app, getAgent, readAgentProjection } = createApp({
			administrator: true,
		});
		getAgent.mockResolvedValueOnce(undefined);
		const response = await app.request("/api/v2/admin/agents/agent-missing");
		expect(response.status).toBe(404);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"RESOURCE_UNAVAILABLE",
		);
		expect(getAgent).toHaveBeenCalledExactlyOnceWith(
			{ kind: "administrator" },
			"agent-missing",
		);
		expect(readAgentProjection).not.toHaveBeenCalled();
	});

	it("rejects employees, forged identity headers and disabled or absent identities before querying one Agent", async () => {
		for (const [identityValue, status, code] of [
			[identity, 403, "RESOURCE_UNAVAILABLE"],
			[
				{ ...identity, organizationIds: ["org-other"] },
				403,
				"RESOURCE_UNAVAILABLE",
			],
			[
				{ ...identity, roles: ["system_admin"], accountStatus: "disabled" },
				403,
				"AUTHORIZATION_REVOKED",
			],
			[null, 401, "AUTHENTICATION_REQUIRED"],
		] as const) {
			const { app, getAgent, readAgentProjection } = createApp({
				identityValue,
			});
			const response = await app.request("/api/v2/admin/agents/agent-1", {
				headers: {
					"x-user-id": "admin",
					"x-role": "system_admin",
					"x-roles": "system_admin",
					"x-identity-context": "administrator",
				},
			});
			expect(response.status).toBe(status);
			expect(response.headers.get("cache-control")).toBe("no-store");
			const error = PilotProtocolErrorV1Schema.parse(await response.json());
			expect(error.code).toBe(code);
			expect(JSON.stringify(error)).not.toContain("Release assistant");
			expect(getAgent).not.toHaveBeenCalled();
			expect(readAgentProjection).not.toHaveBeenCalled();
		}
	});

	it("accepts only the browser session and rejects caller-selected scopes or identities on one Agent", async () => {
		const { app, getAgent, resolve } = createApp({ administrator: true });
		const bearer = await app.request("/api/v2/admin/agents/agent-1", {
			headers: {
				Authorization: "Bearer fixture-api-credential",
				Cookie: "fixture-browser-session=admin",
			},
		});
		expect(bearer.status).toBe(401);
		expect(PilotProtocolErrorV1Schema.parse(await bearer.json()).code).toBe(
			"AUTHENTICATION_REQUIRED",
		);
		expect(resolve).not.toHaveBeenCalled();
		for (const query of [
			"scope=administrator",
			"userId=admin",
			"role=system_admin",
		]) {
			const response = await app.request(
				`/api/v2/admin/agents/agent-1?${query}`,
			);
			expect(response.status).toBe(400);
			expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
				"INVALID_REQUEST",
			);
		}
		expect(getAgent).not.toHaveBeenCalled();
		// 每次请求都重新确认当前角色：角色被撤销后同一会话立即被拒绝。
		expect((await app.request("/api/v2/admin/agents/agent-1")).status).toBe(
			200,
		);
		resolve.mockResolvedValueOnce(identity);
		expect((await app.request("/api/v2/admin/agents/agent-1")).status).toBe(
			403,
		);
		expect(getAgent).toHaveBeenCalledTimes(1);
	});

	it("fails closed for single administrator read dependencies without exposing private details", async () => {
		for (const failure of [
			{ identityFailure: true },
			{ projectionFailure: true },
		]) {
			const { app } = createApp({ administrator: true, ...failure });
			const response = await app.request("/api/v2/admin/agents/agent-1");
			expect(response.status).toBe(503);
			const error = PilotProtocolErrorV1Schema.parse(await response.json());
			expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
			expect(JSON.stringify(error)).not.toContain("private");
		}
		const { app, getAgent } = createApp({ administrator: true });
		getAgent.mockRejectedValueOnce(new Error("private query detail"));
		const response = await app.request("/api/v2/admin/agents/agent-1");
		expect(response.status).toBe(503);
		const error = PilotProtocolErrorV1Schema.parse(await response.json());
		expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
		expect(JSON.stringify(error)).not.toContain("private");
	});

	it("uses owner scope and returns an action-free V2 agent projection", async () => {
		const { app, listAgents } = createApp();
		const response = await app.request("/api/v2/agents?scope=owner&limit=10");

		expect(response.status).toBe(200);
		expect(listAgents).toHaveBeenCalledWith(
			{ kind: "owner", ownerId: "user-1" },
			{ limit: 10 },
		);
		const body = (await response.json()) as { items: unknown[] };
		const projection = AgentProjectionV2Schema.parse(body.items[0]);
		expect(projection.schemaVersion).toBe(2);
		expect(projection.configuration).not.toHaveProperty("actions");
	});

	it("submits V2 application input to the real Core seam and projects V2 output", async () => {
		const { app, submit } = createApp();
		const response = await app.request("/api/v2/agent-applications", {
			method: "POST",
			headers,
			body: JSON.stringify(applicationBody),
		});

		expect(response.status).toBe(201);
		const projection = AgentApplicationProjectionV2Schema.parse(
			await response.json(),
		);
		expect(projection.schemaVersion).toBe(2);
		expect(projection.configuration).not.toHaveProperty("actions");
		expect(submit).toHaveBeenCalledWith(
			expect.objectContaining({
				schemaVersion: 3,
				applicationId: "application-1",
				defaultRelayKey: "agent-default-relay-key",
			}),
			expect.objectContaining({ userId: "user-1" }),
			undefined,
		);
	});

	it("rejects a standard application that omits the Agent default Relay Key", async () => {
		const { app, submit } = createApp();
		const { defaultRelayKey: _defaultRelayKey, ...withoutKey } =
			applicationBody;
		const response = await app.request("/api/v2/agent-applications", {
			method: "POST",
			headers,
			body: JSON.stringify(withoutKey),
		});
		expect(response.status).toBe(400);
		expect(submit).not.toHaveBeenCalled();
	});

	describe("application revision with a re-submitted default Relay Key (#2421)", () => {
		const key = "SYNTHETIC_ROUTE_KEY_000000001";
		const revisionBody = {
			schemaVersion: 2,
			name: "Release assistant",
			description: "Helps the release team",
			source: { kind: "standard", templateId: "template-1" },
			coOwnerIds: [],
			availability: [{ kind: "organization", organizationId: "org-1" }],
			environment: [],
			defaultRelayKey: key,
			expectedConfigurationRevision: 7,
			expectedKeyVersion: 2,
			modelConfiguration: applicationBody.modelConfiguration,
		};
		const put = (app: ReturnType<typeof createApp>["app"], payload: unknown) =>
			app.request("/api/v2/agent-applications/application-1", {
				method: "PUT",
				headers,
				body: JSON.stringify(payload),
			});

		it("sends the V3 revise command with the Key, expected versions and credential-free models", async () => {
			const { app, revise } = createApp();
			const response = await put(app, revisionBody);
			expect(response.status).toBe(200);
			expect(await response.text()).not.toContain(key);
			expect(revise).toHaveBeenCalledWith(
				expect.objectContaining({
					schemaVersion: 3,
					defaultRelayKey: key,
					expectedConfigurationRevision: 7,
					expectedKeyVersion: 2,
					modelConfiguration: applicationBody.modelConfiguration,
				}),
				expect.objectContaining({ applicationId: "application-1" }),
				undefined,
			);
			const command = revise.mock.calls[0]?.[0];
			expect(JSON.stringify(command.modelConfiguration)).not.toMatch(
				/replaceCredential|credentialValue/,
			);
		});

		it("keeps the V2 revise command for requests without a Key", async () => {
			const { app, revise } = createApp();
			const {
				defaultRelayKey: _key,
				expectedConfigurationRevision: _revision,
				expectedKeyVersion: _version,
				modelConfiguration: _model,
				...plain
			} = revisionBody;
			expect((await put(app, plain)).status).toBe(200);
			expect(revise).toHaveBeenCalledWith(
				expect.objectContaining({ schemaVersion: 2 }),
				expect.anything(),
				undefined,
			);
			expect(revise.mock.calls[0]?.[0]).not.toHaveProperty("defaultRelayKey");
		});

		it.each([
			[
				"a Key without the expected versions",
				{
					expectedConfigurationRevision: undefined,
					expectedKeyVersion: undefined,
				},
			],
			["a Key without a model selection", { modelConfiguration: undefined }],
			["expected versions without a Key", { defaultRelayKey: undefined }],
			[
				"a Key on a custom image source",
				{
					source: {
						kind: "custom",
						imageReference: `registry.example/agent@sha256:${"a".repeat(64)}`,
						interactionMode: "platform-adapter",
					},
				},
			],
		])("rejects %s before touching Core", async (_label, override) => {
			const { app, revise } = createApp();
			const response = await put(app, { ...revisionBody, ...override });
			expect(response.status).toBe(400);
			expect(revise).not.toHaveBeenCalled();
		});

		it.each([["key_version_conflict"], ["stale_revision"]] as const)(
			"answers a %s failure with 409 and never echoes the Key",
			async (code) => {
				const { app, revise } = createApp();
				revise.mockRejectedValueOnce(new ApplicationRevisionError(code));
				const response = await put(app, revisionBody);
				expect(response.status).toBe(409);
				const text = await response.text();
				expect(JSON.parse(text)).toMatchObject({
					code: "INVALID_REQUEST",
					message: "Request conflicts with current state.",
				});
				expect(text).not.toContain(key);
			},
		);
	});

	it("runs administrator approval through the management command and rejects invalid scope", async () => {
		const { app, executeManagementCommand, listAgents } = createApp({
			administrator: true,
		});
		const decision = await app.request(
			"/api/v2/admin/agent-applications/application-1/decision",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ schemaVersion: 1, decision: "approve" }),
			},
		);
		expect(decision.status).toBe(200);
		expect(executeManagementCommand).toHaveBeenCalledWith(
			expect.objectContaining({ command: "approve_application" }),
			expect.objectContaining({ isAdministrator: true }),
		);

		const invalid = await app.request("/api/v2/agents?scope=administrator");
		expect(invalid.status).toBe(400);
		expect(listAgents).toHaveBeenCalledTimes(0);
	});

	it("fails closed when identity resolution is unavailable", async () => {
		const { app } = createApp({ identityFailure: true });
		const unavailable = await app.request("/api/v2/agents");
		expect(unavailable.status).toBe(503);
		const error = PilotProtocolErrorV1Schema.parse(await unavailable.json());
		expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
		expect(JSON.stringify(error)).not.toContain("private identity detail");
	});
});

describe("lifecycle command failures are observable (#2569)", () => {
	const restart = JSON.stringify({ schemaVersion: 1, command: "restart" });

	it.each([
		["identity.resolve", { identityFailure: true }, "/api/v2/agents"],
		["projection.read", { projectionFailure: true }, "/api/v2/agents"],
	] as const)(
		"records the bounded %s failure step without private details",
		async (failureStep, options, path) => {
			const telemetry: OperationalEvent[] = [];
			const { app } = createApp({ ...options, telemetry });
			const response = await app.request(path);

			expect(response.status).toBe(503);
			expect(telemetry[0]).toMatchObject({
				failureStep,
				errorClass: "Error",
			});
			expect(JSON.stringify(telemetry)).not.toMatch(/private/);
		},
	);

	it("returns the committed projection when the follow-up read fails", async () => {
		const telemetry: OperationalEvent[] = [];
		const { app, executeManagementCommand } = createApp({
			projectionFailureAfterCommand: true,
			telemetry,
		});

		const response = await app.request(
			"/api/v2/agents/agent-private-1/lifecycle?token=PRIVATE_QUERY",
			{ method: "POST", headers, body: restart },
		);

		expect(executeManagementCommand).toHaveBeenCalledOnce();
		expect(response.status).toBe(202);
		expect(AgentProjectionV2Schema.parse(await response.json())).toMatchObject({
			agentId: "agent-1",
			managementStatus: "available",
		});
		expect(telemetry).toEqual([
			{
				stage: "http",
				outcome: "completed",
				durationMs: expect.any(Number),
				failureStep: "projection.read",
				errorClass: "Error",
				requestId: expect.any(String),
				traceId: expect.any(String),
			},
		]);
	});

	it("preserves the pre-command projection when a replay read fails", async () => {
		const { app, executeManagementCommand } = createApp({
			projectionFailureAfterCommand: true,
		});
		executeManagementCommand.mockResolvedValueOnce({
			outcome: "replayed",
			result: {
				schemaVersion: 1,
				applicationId: "application-1",
				agentId: "agent-private-1",
				status: "stopped",
				revision: 2,
			},
			writePlan: null,
		});
		const response = await app.request(
			"/api/v2/agents/agent-private-1/lifecycle",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ schemaVersion: 1, command: "stop" }),
			},
		);

		expect(response.status).toBe(202);
		expect(AgentProjectionV2Schema.parse(await response.json())).toMatchObject({
			agentId: "agent-1",
			managementStatus: "available",
			serviceAvailability: "ready",
		});
	});

	it("keeps the log of an accepted lifecycle command free of failure fields", async () => {
		const telemetry: OperationalEvent[] = [];
		const { app } = createApp({ telemetry });

		const response = await app.request("/api/v2/agents/agent-1/lifecycle", {
			method: "POST",
			headers,
			body: restart,
		});

		expect(response.status).toBe(202);
		expect(telemetry).toHaveLength(1);
		expect(telemetry[0]).toMatchObject({ stage: "http", outcome: "completed" });
		expect(telemetry[0]).not.toHaveProperty("status");
		expect(telemetry[0]).not.toHaveProperty("operationRef");
		expect(telemetry[0]).not.toHaveProperty("protocolCode");
	});

	it("returns an accepted envelope when an image upgrade follow-up read fails", async () => {
		const { app, upgradeCustomImage } = createApp({
			projectionFailure: true,
		});
		const response = await app.request(
			"/api/v2/agents/agent-private-1/lifecycle",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					schemaVersion: 1,
					command: "upgrade_custom_image",
					imageReference: "registry.example/agent:v2",
				}),
			},
		);

		expect(response.status).toBe(202);
		expect(
			AgentApiLifecycleAcceptedResponseV1Schema.parse(await response.json()),
		).toMatchObject({
			accepted: true,
			agentId: "agent-private-1",
			replayed: false,
		});
		expect(upgradeCustomImage).toHaveBeenCalledOnce();
	});

	it("does not let a failed projection cache mask a denied command", async () => {
		const { app, executeManagementCommand } = createApp({
			projectionFailure: true,
		});
		executeManagementCommand.mockResolvedValueOnce({
			outcome: "denied",
			writePlan: null,
		});

		const response = await app.request("/api/v2/agents/agent-1/lifecycle", {
			method: "POST",
			headers,
			body: restart,
		});

		expect(response.status).toBe(404);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"RESOURCE_UNAVAILABLE",
		);
		expect(executeManagementCommand).toHaveBeenCalledOnce();
	});

	it("keeps image-upgrade failures mapped when the projection cache is unavailable", async () => {
		const { app, upgradeCustomImage } = createApp({
			projectionFailure: true,
		});
		upgradeCustomImage.mockRejectedValueOnce(
			new Error("private upgrade failure"),
		);

		const response = await app.request("/api/v2/agents/agent-1/lifecycle", {
			method: "POST",
			headers,
			body: JSON.stringify({
				schemaVersion: 1,
				command: "upgrade_custom_image",
				imageReference: "registry.example/agent:v2",
			}),
		});

		expect(response.status).toBe(500);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"INTERNAL_ERROR",
		);
		expect(upgradeCustomImage).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"denied",
			{ outcome: "denied", writePlan: null },
			404,
			"RESOURCE_UNAVAILABLE",
		],
		[
			"conflict",
			{ outcome: "conflict", reason: "stale_revision", writePlan: null },
			409,
			"INVALID_REQUEST",
		],
	] as const)(
		"preserves %s lifecycle command mapping",
		async (_label, decision, status, code) => {
			const { app, executeManagementCommand } = createApp();
			executeManagementCommand.mockResolvedValueOnce(decision as never);
			const response = await app.request("/api/v2/agents/agent-1/lifecycle", {
				method: "POST",
				headers,
				body: restart,
			});

			expect(response.status).toBe(status);
			expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
				code,
			);
		},
	);

	it("maps a command execution failure without exposing private details", async () => {
		const { app, executeManagementCommand } = createApp();
		executeManagementCommand.mockRejectedValueOnce(
			new Error("private command failure"),
		);
		const response = await app.request("/api/v2/agents/agent-1/lifecycle", {
			method: "POST",
			headers,
			body: restart,
		});

		expect(response.status).toBe(500);
		const text = await response.text();
		expect(PilotProtocolErrorV1Schema.parse(JSON.parse(text)).code).toBe(
			"INTERNAL_ERROR",
		);
		expect(text).not.toContain("private command failure");
	});
});

describe("reads re-read a snapshot that went stale while projecting (#2661)", () => {
	const agentAt = (agentId: string, revision: number) => ({
		...agentRecord,
		agentId,
		applicationId: `application-${agentId}`,
		management: {
			...management,
			agentId,
			applicationId: `application-${agentId}`,
			status: "available" as const,
			serviceAvailability: "ready" as const,
			revision,
		},
	});
	type AgentAt = ReturnType<typeof agentAt>;
	type ListedAgent = { agentId: string; description: string };

	/** 与生产的展示层一样：快照里的管理修订已不是当前修订时，报告快照过期。 */
	const projectAgainst =
		(current: Map<string, number>) =>
		async ({ agent }: { agent: AgentAt }) => {
			if (agent.management.revision !== current.get(agent.agentId))
				throw new StaleProjectionError("trace-stale");
			return {
				...agentProjection,
				agentId: agent.agentId,
				description: `revision ${agent.management.revision}`,
			};
		};

	/** 每次列表读取都按「当前」修订返回；afterRead 模拟读取之后、投影之前发生的状态变化。 */
	const listFrom =
		(
			current: Map<string, number>,
			afterRead: (read: number) => void,
			visible: () => readonly string[] = () => [...current.keys()],
		) =>
		async () => {
			const items = visible().map((agentId) =>
				agentAt(agentId, current.get(agentId) ?? 0),
			);
			reads += 1;
			afterRead(reads);
			return { items, nextAfterId: null };
		};
	let reads = 0;

	it("returns 200 with the re-read snapshot when an Agent changes while the list is projected", async () => {
		reads = 0;
		const h = createApp();
		const current = new Map([
			["agent-1", 1],
			["agent-2", 1],
		]);
		// 第一次读取之后 agent-2 被停止/重启：管理修订前进。
		h.listAgents.mockImplementation(
			listFrom(current, (read) => {
				if (read === 1) current.set("agent-2", 2);
			}),
		);
		h.readAgentProjection.mockImplementation(projectAgainst(current));

		const response = await h.app.request("/api/v2/agents?limit=10");

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: ListedAgent[];
			nextCursor: string | null;
		};
		expect(
			body.items.map(({ agentId, description }) => [agentId, description]),
		).toEqual([
			["agent-1", "revision 1"],
			["agent-2", "revision 2"],
		]);
		expect(body.nextCursor).toBeNull();
		expect(h.listAgents).toHaveBeenCalledTimes(2);
		expect(h.listAgents.mock.calls[1]).toEqual(h.listAgents.mock.calls[0]);
		// 快照没变的 agent-1 沿用第一次的投影，只重新投影 agent-2。
		expect(
			h.readAgentProjection.mock.calls.map(([input]) => input.agent.agentId),
		).toEqual(["agent-1", "agent-2", "agent-2"]);
	});

	it("fails with the retryable dependency error only after the bounded re-reads", async () => {
		reads = 0;
		const h = createApp();
		const current = new Map([["agent-2", 1]]);
		// 每次读取之后都又变了。
		h.listAgents.mockImplementation(
			listFrom(current, () =>
				current.set("agent-2", (current.get("agent-2") ?? 0) + 1),
			),
		);
		h.readAgentProjection.mockImplementation(projectAgainst(current));

		const response = await h.app.request("/api/v2/agents");

		expect(response.status).toBe(503);
		expect(
			PilotProtocolErrorV1Schema.parse(await response.json()),
		).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", retryable: true });
		// 一次读取 + 两次重读。
		expect(h.listAgents).toHaveBeenCalledTimes(3);
		expect(h.readAgentProjection).toHaveBeenCalledTimes(3);
	});

	it("re-reads with the same visible scope and page, and leaves out an Agent the re-read no longer returns", async () => {
		reads = 0;
		const h = createApp();
		const current = new Map([
			["agent-1", 1],
			["agent-2", 1],
		]);
		let visible = ["agent-1", "agent-2"];
		// 第一次读取之后 agent-2 对这个用户不再可见（例如 Owner 被移除）。
		h.listAgents.mockImplementation(
			listFrom(
				current,
				(read) => {
					if (read === 1) {
						current.set("agent-2", 2);
						visible = ["agent-1"];
					}
				},
				() => visible,
			),
		);
		h.readAgentProjection.mockImplementation(projectAgainst(current));

		const response = await h.app.request(
			"/api/v2/agents?scope=owner&limit=2&cursor=agent-0",
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { items: ListedAgent[] };
		expect(body.items.map(({ agentId }) => agentId)).toEqual(["agent-1"]);
		expect(h.listAgents.mock.calls).toEqual([
			[
				{ kind: "owner", ownerId: "user-1" },
				{ limit: 2, afterId: "agent-0" },
			],
			[
				{ kind: "owner", ownerId: "user-1" },
				{ limit: 2, afterId: "agent-0" },
			],
		]);
	});

	it("does not re-read for any other projection failure", async () => {
		const h = createApp({ projectionFailure: true });

		const response = await h.app.request("/api/v2/agents");

		expect(response.status).toBe(503);
		expect(h.listAgents).toHaveBeenCalledTimes(1);
		expect(h.readAgentProjection).toHaveBeenCalledTimes(1);
	});

	it("re-reads the administrator Agent list with the administrator scope", async () => {
		const h = createApp({ administrator: true });
		h.readAgentProjection.mockRejectedValueOnce(
			new StaleProjectionError("trace-stale"),
		);

		const response = await h.app.request("/api/v2/admin/agents");

		expect(response.status).toBe(200);
		expect(
			((await response.json()) as { items: unknown[] }).items,
		).toHaveLength(1);
		expect(h.listAgents.mock.calls).toEqual([
			[{ kind: "administrator" }, { limit: 50 }],
			[{ kind: "administrator" }, { limit: 50 }],
		]);
	});

	it("re-reads the applicant's application list with the applicant scope", async () => {
		const h = createApp();
		h.readApplicationProjection.mockRejectedValueOnce(
			new StaleProjectionError("trace-stale"),
		);

		const response = await h.app.request("/api/v2/agent-applications");

		expect(response.status).toBe(200);
		const body = (await response.json()) as { items: unknown[] };
		expect(body.items).toHaveLength(1);
		AgentApplicationProjectionV2Schema.parse(body.items[0]);
		expect(h.listApplications.mock.calls).toEqual([
			[{ kind: "applicant", applicantId: "user-1" }, { limit: 50 }],
			[{ kind: "applicant", applicantId: "user-1" }, { limit: 50 }],
		]);
	});

	it("leaves out an application that left the pending-approval list while it was projected", async () => {
		const h = createApp({ administrator: true });
		// 投影期间申请已被批准：重读的待审批列表里不再有它。
		h.listApplications
			.mockResolvedValueOnce({ items: [applicationRecord], nextAfterId: null })
			.mockResolvedValueOnce({ items: [], nextAfterId: null });
		h.readApplicationProjection.mockRejectedValueOnce(
			new StaleProjectionError("trace-stale"),
		);

		const response = await h.app.request("/api/v2/admin/agent-applications");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ items: [], nextCursor: null });
		expect(h.listApplications).toHaveBeenCalledTimes(2);
		expect(h.listApplications.mock.calls[1]).toEqual(
			h.listApplications.mock.calls[0],
		);
		expect(h.readApplicationProjection).toHaveBeenCalledTimes(1);
	});

	it("re-reads one Agent with the same scope and returns its current snapshot", async () => {
		reads = 0;
		const h = createApp();
		const current = new Map([["agent-1", 1]]);
		h.getAgent.mockImplementation(async () => {
			const agent = agentAt("agent-1", current.get("agent-1") ?? 0);
			if (h.getAgent.mock.calls.length === 1) current.set("agent-1", 2);
			return agent;
		});
		h.readAgentProjection.mockImplementation(projectAgainst(current));

		const response = await h.app.request("/api/v2/agents/agent-1");

		expect(response.status).toBe(200);
		expect(((await response.json()) as ListedAgent).description).toBe(
			"revision 2",
		);
		expect(h.getAgent.mock.calls).toEqual([
			[
				{ kind: "user", userId: "user-1", organizationIds: ["org-1"] },
				"agent-1",
			],
			[
				{ kind: "user", userId: "user-1", organizationIds: ["org-1"] },
				"agent-1",
			],
		]);
	});

	it("answers 404 when the re-read Agent is no longer visible", async () => {
		const h = createApp();
		h.getAgent
			.mockResolvedValueOnce(agentAt("agent-1", 1))
			.mockResolvedValueOnce(undefined);
		h.readAgentProjection.mockRejectedValueOnce(
			new StaleProjectionError("trace-stale"),
		);

		const response = await h.app.request("/api/v2/agents/agent-1");

		expect(response.status).toBe(404);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"RESOURCE_UNAVAILABLE",
		);
		expect(h.readAgentProjection).toHaveBeenCalledTimes(1);
	});

	it("re-reads one application with the applicant scope", async () => {
		const h = createApp();
		h.readApplicationProjection.mockRejectedValueOnce(
			new StaleProjectionError("trace-stale"),
		);

		const response = await h.app.request(
			"/api/v2/agent-applications/application-1",
		);

		expect(response.status).toBe(200);
		expect(h.getApplication.mock.calls).toEqual([
			[{ kind: "applicant", applicantId: "user-1" }, "application-1"],
			[{ kind: "applicant", applicantId: "user-1" }, "application-1"],
		]);
	});

	it("re-reads the personal API list with the credential user's scope and audits only the returned Agents", async () => {
		reads = 0;
		const api = apiReader();
		const h = createApp({ personalApiAgentRead: api.reader });
		const current = new Map([
			["agent-1", 1],
			["agent-2", 1],
		]);
		h.listAgents.mockImplementation(
			listFrom(current, (read) => {
				if (read === 1) current.set("agent-2", 2);
			}),
		);
		h.readApiAgentProjection.mockImplementation(projectAgainst(current));

		const response = await h.app.request("/api/v2/agents", {
			headers: { Authorization: `Bearer ${api.material}` },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { items: ListedAgent[] };
		expect(
			body.items.map(({ agentId, description }) => [agentId, description]),
		).toEqual([
			["agent-1", "revision 1"],
			["agent-2", "revision 2"],
		]);
		expect(h.listAgents.mock.calls.map(([scope]) => scope)).toEqual([
			{ kind: "api_user", userId: "user-api" },
			{ kind: "api_user", userId: "user-api" },
		]);
		expect(api.audits).toHaveLength(1);
		expect(api.audits[0]).toMatchObject({
			outcome: "succeeded",
			details: { returnedAgentIds: ["agent-1", "agent-2"] },
		});
	});
});

// #3034：创建失败类别只给当前 Owner 与系统管理员，且只在创建失败时可读；其他主体、其他
// Agent、其他状态与不存在一律按 RESOURCE_UNAVAILABLE 处理，不调用失败原因读取。
describe("creation failure category route (#3034)", () => {
	const failedAgent = (agentId: string, ownerIds: readonly string[]) => ({
		...agentRecord,
		agentId,
		management: {
			...management,
			agentId,
			status: "creation_failed" as const,
			serviceAvailability: null,
			workloadRevision: 1,
			fence: 1,
			ownerIds: [...ownerIds],
			failureCode: "reconciliation_failed" as
				| "reconciliation_failed"
				| "health_check_failed",
		},
	});

	function creationFailureApp(
		options: {
			readonly userId?: string;
			readonly administrator?: boolean;
			readonly agents?: readonly ReturnType<typeof failedAgent>[];
			readonly reason?: string | null;
			readonly readerFailure?: boolean;
			readonly withoutReader?: boolean;
		} = {},
	) {
		const app = new Hono();
		const agents = options.agents ?? [
			failedAgent("agent-1", ["user-1"]),
			failedAgent("agent-2", ["user-2"]),
		];
		const getAgent = vi.fn(
			async (
				scope: { readonly kind: string; readonly ownerId?: string },
				agentId: string,
			) =>
				agents.find(
					(agent) =>
						agent.agentId === agentId &&
						(scope.kind === "administrator" ||
							(scope.kind === "owner" &&
								agent.management.ownerIds.includes(scope.ownerId ?? ""))),
				),
		);
		const readWorkloadFailureReason = options.readerFailure
			? vi.fn().mockRejectedValue(new Error("private failure detail"))
			: vi
					.fn()
					.mockResolvedValue(
						options.reason === undefined ? "kubernetes_policy" : options.reason,
					);
		const unavailable = vi.fn().mockRejectedValue(new Error("unused"));
		registerV2ManagementRoutes(app, {
			identity: {
				resolve: vi.fn().mockResolvedValue({
					...identity,
					userId: options.userId ?? "user-1",
					roles: options.administrator
						? (["employee", "system_admin"] as const)
						: identity.roles,
				}),
				hydrateUsers: vi.fn().mockResolvedValue([]),
			},
			foundation: { submit: unavailable },
			revision: { revise: unavailable },
			management: { executeManagementCommand: unavailable },
			configuration: { upgradeCustomImage: unavailable },
			query: {
				listApplications: unavailable,
				getApplication: unavailable,
				listAgents: unavailable,
				getAgent: getAgent as never,
			},
			allocateApplicationIds: unavailable,
			prepareSecretReplacements: unavailable,
			readApplicationProjection: unavailable,
			readAgentProjection: unavailable,
			...(options.withoutReader ? {} : { readWorkloadFailureReason }),
		});
		return { app, getAgent, readWorkloadFailureReason };
	}

	const read = (app: Hono, agentId = "agent-1", init?: RequestInit) =>
		app.request(`/api/v2/agents/${agentId}/creation-failure`, init);

	it("returns only the bounded category to a current Owner", async () => {
		const h = creationFailureApp();
		const response = await read(h.app);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.json();
		expect(AgentCreationFailureProjectionV1Schema.parse(body)).toEqual({
			schemaVersion: 1,
			agentId: "agent-1",
			category: "configuration_rejected",
		});
		expect(JSON.stringify(body)).not.toMatch(/kubernetes|policy|attempt/);
		expect(h.getAgent).toHaveBeenCalledWith(
			{ kind: "owner", ownerId: "user-1" },
			"agent-1",
		);
		expect(h.readWorkloadFailureReason).toHaveBeenCalledWith("agent-1");
	});

	it("lets a system administrator read an Agent that it does not own", async () => {
		const h = creationFailureApp({ userId: "admin-1", administrator: true });
		const response = await read(h.app, "agent-2");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			agentId: "agent-2",
			category: "configuration_rejected",
		});
		expect(h.getAgent).toHaveBeenCalledWith(
			{ kind: "administrator" },
			"agent-2",
		);
	});

	it.each([
		["another user", { userId: "user-3" }, "agent-1"],
		["the Owner of another Agent", { userId: "user-1" }, "agent-2"],
		["anyone for a missing Agent", { userId: "user-1" }, "agent-missing"],
	] as const)(
		"hides the category from %s",
		async (_label, options, agentId) => {
			const h = creationFailureApp(options);
			const response = await read(h.app, agentId);
			expect(response.status).toBe(404);
			expect(
				PilotProtocolErrorV1Schema.parse(await response.json()),
			).toMatchObject({ code: "RESOURCE_UNAVAILABLE", retryable: false });
			expect(h.readWorkloadFailureReason).not.toHaveBeenCalled();
		},
	);

	it.each(["creating", "available", "stopped", "disabled"] as const)(
		"hides the category while the Agent is %s",
		async (status) => {
			const agent = failedAgent("agent-1", ["user-1"]);
			const h = creationFailureApp({
				agents: [
					{
						...agent,
						management: {
							...agent.management,
							status: status as never,
							failureCode: null as never,
						},
					},
				],
			});
			const response = await read(h.app);
			expect(response.status).toBe(404);
			expect(h.readWorkloadFailureReason).not.toHaveBeenCalled();
		},
	);

	it.each([
		["health_check_failed", "health_check_failed", null],
		["reconciliation_failed", "deployment_unavailable", null],
		["reconciliation_failed", "deployment_unavailable", "kubernetes_forbidden"],
		["reconciliation_failed", "configuration_rejected", "preflight_rejected"],
	] as const)(
		"maps %s to %s when the Workload reason is %s",
		async (failureCode, category, reason) => {
			const agent = failedAgent("agent-1", ["user-1"]);
			const h = creationFailureApp({
				agents: [
					{ ...agent, management: { ...agent.management, failureCode } },
				],
				reason,
			});
			const response = await read(h.app);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ category });
		},
	);

	it("accepts only a browser session without query parameters", async () => {
		const h = creationFailureApp();
		expect(
			(
				await read(h.app, "agent-1", {
					headers: { Authorization: `Bearer papi_${"b".repeat(43)}` },
				})
			).status,
		).toBe(401);
		const query = await h.app.request(
			"/api/v2/agents/agent-1/creation-failure?reason=1",
		);
		expect(query.status).toBe(400);
		expect(h.getAgent).not.toHaveBeenCalled();
	});

	it("fails as a retryable dependency error without leaking the reader failure", async () => {
		for (const options of [{ withoutReader: true }, { readerFailure: true }]) {
			const h = creationFailureApp(options);
			const response = await read(h.app);
			expect(response.status).toBe(503);
			const body = await response.json();
			expect(body).toMatchObject({
				code: "DEPENDENCY_UNAVAILABLE",
				retryable: true,
			});
			expect(JSON.stringify(body)).not.toContain("private failure detail");
		}
	});
});
