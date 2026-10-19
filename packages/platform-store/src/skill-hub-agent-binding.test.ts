import {
	type AgentConfigurationAccessAuthorityV1,
	createSkillHubAgentBindingUseCaseV1,
	type SkillHubAgentBindingAdmissionPortV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentConfigurationTransactionV1 } from "./agent-configuration.transaction.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { PostgresSkillHubAgentBindingAdmissionV1 } from "./skill-hub-agent-binding.ts";

const occurredAt = new Date("2026-10-09T00:00:00.000Z");
const actor = {
	schemaVersion: 1 as const,
	actorId: "owner-1",
	rawRequestDigest: "a".repeat(64),
};
const accessAuthority: AgentConfigurationAccessAuthorityV1 = {
	state: {
		schemaVersion: 1,
		applicationId: "application-1",
		agentId: "agent-1",
		applicantId: "owner-1",
		status: "available",
		revision: 1,
		approvalRevision: 1,
		decisionReason: null,
		serviceAvailability: "ready",
		desiredState: "running",
		workloadRevision: 1,
		fence: 1,
		ownerIds: ["owner-1"],
		availability: [],
		failureCode: null,
	},
	actorContext: {
		schemaVersion: 1,
		userId: "owner-1",
		accountStatus: "active",
		organizationIds: ["org-1"],
		isAdministrator: false,
	},
	authorityContext: {
		schemaVersion: 1,
		users: [{ userId: "owner-1", accountStatus: "active" }],
		organizationIds: ["org-1"],
	},
};

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
let transaction: PostgresAgentConfigurationTransactionV1;
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const bindingAdmission: SkillHubAgentBindingAdmissionPortV1 = {
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
};

beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-hub-agent-bindings");
	client = postgres(database.databaseUrl, { max: 2 });
	await migratePlatformDatabase(database);
	transaction = new PostgresAgentConfigurationTransactionV1({
		databaseUrl: database.databaseUrl,
	});
});

beforeEach(async () => {
	await client`truncate platform.skill_hub_agent_bindings, platform.agent_owners,
		platform.agent_configuration_revisions, platform.agent_applications,
		platform.agents, platform.idempotency_records, platform.outbox_items,
		platform.audit_events, platform.skill_hub_installations,
		platform.skill_hub_versions, platform.skill_hub_skills cascade`;
	const configuration = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId: "agent-1",
	};
	const sourceReference =
		configuration.source.kind === "standard"
			? configuration.source.templateId
			: configuration.source.imageDigest;
	await client`
		insert into platform.agents (id, current_configuration_revision, created_at, authorization_revision)
		values ('agent-1', 7, ${occurredAt}, 'authorization-1')`;
	await client`
		insert into platform.agent_applications
		(id, agent_id, applicant_id, name, description, status, trace_id, request_id,
		 submitted_at, management_revision, approval_revision, service_availability,
		 desired_state, workload_revision, fence)
		values ('application-1', 'agent-1', 'owner-1', 'Agent', 'Description', 'available',
		 'trace-seed', 'request-seed', ${occurredAt}, 1, 1, 'ready', 'running', 1, 1)`;
	await client`
		insert into platform.agent_configuration_revisions
		(agent_id, revision, source_reference, created_at, configuration)
		values ('agent-1', 7, ${sourceReference}, ${occurredAt}, ${client.json(configuration as never)})`;
	await client`
		insert into platform.agent_owners (agent_id, owner_id, created_at)
		values ('agent-1', 'owner-1', ${occurredAt})`;
	await client`
		insert into platform.skill_hub_skills
		(id, name, owner_id, status, created_at, updated_at)
		values ('skill-1', 'workspace-summary', 'owner-1', 'active', ${occurredAt}, ${occurredAt})`;
	await client`
		insert into platform.skill_hub_versions
		(id, skill_id, owner_id, version, provider, visibility, state,
		 package_object_version, package_digest, manifest_digest, signature_digest,
		 reviewed_by, created_at)
		values ('skill-version-1', 'skill-1', 'owner-1', '1.0.0', 'my_library',
		 'PRIVATE', 'published', 'object-1', ${"a".repeat(64)}, ${"b".repeat(64)},
		 ${"c".repeat(64)}, 'owner-1', ${occurredAt})`;
	await client`
		insert into platform.skill_hub_installations
		(id, principal_type, principal_id, skill_version_id, state, installed_at, updated_at)
		values ('installation-1', 'user', 'owner-1', 'skill-version-1', 'installed', ${occurredAt}, ${occurredAt})`;
	await client`
		insert into platform.idempotency_records
		(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
		 request_digest, status, result, created_at, updated_at)
		values ('admission-1', 'skill_package', 'skill-version-1', 'owner-1',
		 'skill.package.publish.v1', 'admission-1', ${"d".repeat(64)}, 'completed',
		 ${client.json({ skillVersionId: "skill-version-1" })}, ${occurredAt}, ${occurredAt})`;
});

afterAll(async () => {
	await transaction?.close();
	await client?.end();
	await database?.stop();
});

describe("Skill Hub Agent binding persistence", () => {
	it("commits fixed versions, grant and configuration revision idempotently", async () => {
		const useCase = createSkillHubAgentBindingUseCaseV1({
			transaction,
			bindingAdmission,
			// #2903：写入要求路径版本等于部署当前 Agent Version。
			agentVersion: "agent-version-1",
			authorizationAdmission: {
				async authorize() {
					return {
						schemaVersion: 1,
						status: "admitted",
						agentId: "agent-1",
						actorId: "owner-1",
						authorizationRevision: "authorization-1",
						accessAuthority,
					};
				},
			},
			now: () => occurredAt,
		});
		const grant = {
			schemaVersion: 1,
			tools: ["filesystem.read"],
			connections: [],
			fileRoots: ["/workspace"],
			networkOrigins: [],
			scripts: false,
		};
		const command = {
			schemaVersion: 1,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			expectedConfigurationRevision: 7,
			idempotencyKey: "bind-1",
			requestId: "request-1",
			traceId: "trace-1",
			bindings: [{ skillVersionId: "skill-version-1", grant }],
		};
		const result = await useCase.bind(command, actor);
		expect(result).toMatchObject({
			agentId: "agent-1",
			revision: 8,
			changedFields: ["skills"],
			replayed: false,
		});
		const rows = await client`
			select agent_id, agent_version, skill_version_id, configuration_revision,
				"grant", sync_revision, state
			from platform.skill_hub_agent_bindings`;
		expect(rows).toEqual([
			expect.objectContaining({
				agent_id: "agent-1",
				agent_version: "agent-version-1",
				skill_version_id: "skill-version-1",
				configuration_revision: "8",
				grant,
				sync_revision: "1",
				state: "pending_sync",
			}),
		]);
		const replay = await useCase.bind(command, actor);
		expect(replay).toEqual({ ...result, replayed: true });
		expect(
			await client`select count(*)::int as count from platform.skill_hub_agent_bindings`,
		).toEqual([{ count: 1 }]);
		const resolver = new PostgresSkillHubAgentBindingAdmissionV1({
			databaseUrl: database?.databaseUrl ?? "",
			resolveGrantBoundary: async ({ requested }) => requested,
		});
		try {
			const resolved = await resolver.resolveSyncBindings({
				agentId: "agent-1",
				agentVersion: "agent-version-1",
				configurationRevision: 8,
				actorId: "owner-1",
				organizationIds: ["org-1"],
				isAdministrator: false,
			});
			expect(resolved).toHaveLength(1);
			expect(resolved[0]).toMatchObject({
				state: "pending_sync",
				configurationRevision: 8,
				skillName: "workspace-summary",
				skillVersion: { skillVersionId: "skill-version-1" },
			});
		} finally {
			await resolver.close();
		}
		const deniedResolver = new PostgresSkillHubAgentBindingAdmissionV1({
			databaseUrl: database?.databaseUrl ?? "",
			resolveGrantBoundary: async ({ requested }) => requested,
		});
		try {
			await expect(
				deniedResolver.resolveSyncBindings({
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					configurationRevision: 8,
					actorId: "owner-2",
					organizationIds: [],
					isAdministrator: false,
				}),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(
				await deniedResolver.resolveSyncBindings({
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					configurationRevision: 6,
					actorId: "owner-1",
					organizationIds: ["org-1"],
					isAdministrator: false,
				}),
			).toEqual([]);
		} finally {
			await deniedResolver.close();
		}
		await client`
			update platform.agents set current_configuration_revision = 9 where id = 'agent-1'
		`;
		const stale = new PostgresSkillHubAgentBindingAdmissionV1({
			databaseUrl: database?.databaseUrl ?? "",
			resolveGrantBoundary: async ({ requested }) => requested,
		});
		try {
			expect(
				await stale.resolveSyncBindings({
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					configurationRevision: 8,
					actorId: "owner-1",
					organizationIds: ["org-1"],
					isAdministrator: false,
				}),
			).toEqual([]);
		} finally {
			await stale.close();
		}
		await client`
			update platform.agents set current_configuration_revision = 8 where id = 'agent-1'
		`;
		await client`
			insert into platform.skill_hub_skills
			(id, name, owner_id, status, created_at, updated_at)
			values ('skill-2', 'other-skill', 'owner-1', 'active', ${occurredAt}, ${occurredAt})
		`;
		await client`
			insert into platform.skill_hub_versions
			(id, skill_id, owner_id, version, provider, visibility, state,
			 package_object_version, package_digest, manifest_digest, signature_digest,
			 reviewed_by, created_at)
			values ('skill-version-2', 'skill-2', 'owner-1', '1.0.0', 'my_library',
			 'PRIVATE', 'published', 'object-2', ${"d".repeat(64)}, ${"e".repeat(64)},
			 ${"f".repeat(64)}, 'owner-1', ${occurredAt})
		`;
		await client`
			insert into platform.skill_hub_installations
			(id, principal_type, principal_id, skill_version_id, state, installed_at, updated_at)
			values ('installation-2', 'user', 'owner-1', 'skill-version-2', 'installed', ${occurredAt}, ${occurredAt})
		`;
		await client`
			insert into platform.idempotency_records
			(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
			 request_digest, status, result, created_at, updated_at)
			values ('admission-2', 'skill_package', 'skill-version-2', 'owner-1',
			 'skill.package.publish.v1', 'admission-2', ${"7".repeat(64)}, 'completed',
			 ${client.json({ skillVersionId: "skill-version-2" })}, ${occurredAt}, ${occurredAt})
		`;
		await client`
			insert into platform.skill_hub_agent_bindings
			(agent_id, agent_version, skill_version_id, "grant", sync_revision, state,
			 failure_reason, created_at, updated_at, configuration_revision)
			values ('agent-1', 'agent-version-1', 'skill-version-2', ${client.json(grant as never)},
			 1, 'pending_sync', null, ${occurredAt}, ${occurredAt}, 8)
		`;

		const receiptStore = new PostgresSkillHubAgentBindingAdmissionV1({
			databaseUrl: database?.databaseUrl ?? "",
			resolveGrantBoundary: async ({ requested }) => requested,
		});
		const receipt = {
			schemaVersion: 1 as const,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			skillName: "workspace-summary",
			configurationRevision: 8,
			syncRevision: 1,
			skillVersionId: "skill-version-1",
			generationId: "e".repeat(64),
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			targetPath: ".agents/skills/workspace-summary",
			readOnly: true as const,
		};
		try {
			await client`
				update platform.agents set current_configuration_revision = 9 where id = 'agent-1'
			`;
			await expect(
				receiptStore.recordAppliedReceipt(receipt),
			).rejects.toMatchObject({ code: "stale_revision" });
			await client`
				update platform.agents set current_configuration_revision = 8 where id = 'agent-1'
			`;
			await expect(
				receiptStore.recordAppliedReceipt({
					...receipt,
					packageDigest: "f".repeat(64),
				}),
			).rejects.toMatchObject({ code: "mismatch" });
			expect(
				await client`
					select state, applied_receipt
					from platform.skill_hub_agent_bindings
					where skill_version_id = 'skill-version-1'
				`,
			).toEqual([{ state: "pending_sync", applied_receipt: null }]);
			await expect(
				receiptStore.recordAppliedReceipt({
					...receipt,
					skillVersionId: "skill-version-2",
				}),
			).rejects.toMatchObject({ code: "mismatch" });

			expect(await receiptStore.recordAppliedReceipt(receipt)).toEqual(receipt);
			expect(await receiptStore.recordAppliedReceipt(receipt)).toEqual(receipt);
			await expect(
				receiptStore.recordAppliedReceipt({
					...receipt,
					generationId: "d".repeat(64),
				}),
			).rejects.toMatchObject({ code: "mismatch" });
			await expect(
				receiptStore.recordAppliedReceipt({
					...receipt,
					syncRevision: 2,
				}),
			).rejects.toMatchObject({ code: "stale_revision" });
			await expect(
				receiptStore.recordAppliedReceipt({
					...receipt,
					agentId: "agent-2",
				}),
			).rejects.toMatchObject({ code: "not_found" });
			const syncedResolver = new PostgresSkillHubAgentBindingAdmissionV1({
				databaseUrl: database?.databaseUrl ?? "",
				resolveGrantBoundary: async ({ requested }) => requested,
			});
			try {
				const resolved = await syncedResolver.resolveSyncBindings({
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					configurationRevision: 8,
					actorId: "owner-1",
					organizationIds: ["org-1"],
					isAdministrator: false,
				});
				expect(
					resolved.find(
						(binding) =>
							binding.skillVersion.skillVersionId === "skill-version-1",
					),
				).toMatchObject({ state: "synced", appliedReceipt: receipt });
			} finally {
				await syncedResolver.close();
			}
			await client`
				update platform.skill_hub_agent_bindings
				set state = 'revoked', applied_receipt = null, failure_reason = null
				where agent_id = 'agent-1' and agent_version = 'agent-version-1'
					and configuration_revision = 8 and skill_version_id = 'skill-version-1'
			`;
			await expect(
				receiptStore.recordAppliedReceipt(receipt),
			).rejects.toMatchObject({ code: "invalid_state" });
			expect(
				await client`
					select state, applied_receipt
					from platform.skill_hub_agent_bindings
					where skill_version_id = 'skill-version-1'
				`,
			).toEqual([{ state: "revoked", applied_receipt: null }]);
		} finally {
			await receiptStore.close();
		}
	});
});

// #2903：Owner 读取使用 agents.current_configuration_revision，而不是管理修订。
describe("Skill Hub Agent current binding read", () => {
	const emptyGrant = {
		schemaVersion: 1,
		tools: [],
		connections: [],
		fileRoots: [],
		networkOrigins: [],
		scripts: false,
	};
	const owner = {
		agentId: "agent-1",
		agentVersion: "agent-version-1",
		actorId: "owner-1",
		organizationIds: ["org-1"],
		isAdministrator: false,
	};

	it("lists, binds and unbinds through the current configuration revision", async () => {
		// 生产装配不注入 grant 边界：边界视为空 grant，与 admit 一致。
		const store = new PostgresSkillHubAgentBindingAdmissionV1({
			databaseUrl: database?.databaseUrl ?? "",
		});
		const useCase = createSkillHubAgentBindingUseCaseV1({
			transaction,
			bindingAdmission: store,
			bindingStatus: store,
			agentVersion: "agent-version-1",
			authorizationAdmission: {
				async authorize() {
					return {
						schemaVersion: 1,
						status: "admitted",
						agentId: "agent-1",
						actorId: "owner-1",
						authorizationRevision: "authorization-1",
						accessAuthority,
					};
				},
			},
			now: () => occurredAt,
		});
		const read = {
			schemaVersion: 1,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			actorId: "owner-1",
			requestId: "request-read",
			traceId: "trace-read",
		};
		try {
			// 种子数据：管理修订 1，配置修订 7。
			expect(
				await client`
					select management_revision from platform.agent_applications
					where agent_id = 'agent-1'`,
			).toEqual([{ management_revision: "1" }]);
			expect(await store.readCurrentConfigurationRevision(owner)).toBe(7);
			expect(await useCase.read(read)).toMatchObject({
				configurationRevision: 7,
				bindings: [],
			});
			const bound = await useCase.bind(
				{
					schemaVersion: 1,
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					expectedConfigurationRevision: 7,
					idempotencyKey: "bind-current",
					requestId: "request-bind",
					traceId: "trace-bind",
					bindings: [{ skillVersionId: "skill-version-1", grant: emptyGrant }],
				},
				actor,
			);
			expect(bound).toMatchObject({ revision: 8, replayed: false });
			const listed = await useCase.read(read);
			expect(listed.configurationRevision).toBe(8);
			expect(listed.bindings).toEqual([
				expect.objectContaining({
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					skillName: "workspace-summary",
					configurationRevision: 8,
					state: "pending_sync",
					grant: emptyGrant,
				}),
			]);
			// 其他 Agent Version 的读取看不到这条绑定。
			expect(
				await store.readCurrentBindings({
					...owner,
					agentVersion: "agent-version-2",
				}),
			).toEqual({ configurationRevision: 8, bindings: [] });
			const unbound = await useCase.bind(
				{
					schemaVersion: 1,
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					expectedConfigurationRevision: 8,
					idempotencyKey: "unbind-current",
					requestId: "request-unbind",
					traceId: "trace-unbind",
					bindings: [],
				},
				actor,
			);
			expect(unbound).toMatchObject({ revision: 9, replayed: false });
			expect(await useCase.read(read)).toMatchObject({
				configurationRevision: 9,
				bindings: [],
			});
			// 历史修订的绑定记录保留，不被解绑删除。
			expect(
				await client`
					select configuration_revision from platform.skill_hub_agent_bindings
					order by configuration_revision`,
			).toEqual([{ configuration_revision: "8" }]);
		} finally {
			await store.close();
		}
	});

	it("fails closed for a persisted grant beyond the empty deployment boundary", async () => {
		await client`
			insert into platform.skill_hub_agent_bindings
			(agent_id, agent_version, skill_version_id, "grant", sync_revision, state,
			 failure_reason, created_at, updated_at, configuration_revision)
			values ('agent-1', 'agent-version-1', 'skill-version-1',
			 ${client.json({ ...emptyGrant, tools: ["filesystem.read"] } as never)},
			 1, 'pending_sync', null, ${occurredAt}, ${occurredAt}, 7)
		`;
		const store = new PostgresSkillHubAgentBindingAdmissionV1({
			databaseUrl: database?.databaseUrl ?? "",
		});
		try {
			await expect(store.readCurrentBindings(owner)).rejects.toMatchObject({
				code: "unavailable",
			});
			await expect(
				store.readCurrentConfigurationRevision({ agentId: "agent-missing" }),
			).rejects.toMatchObject({ code: "unavailable" });
		} finally {
			await store.close();
		}
	});
});
