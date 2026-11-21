import {
	type AgentConfigurationAccessAuthorityV1,
	createAgentConfigurationUseCaseV1,
	createSkillHubAgentBindingUseCaseV1,
	type SkillHubAgentBindingAdmissionPortV1,
} from "@agent-infra/platform-core";
import { FakeAgentConfigurationAdmissionsV1 } from "@agent-infra/platform-core/testing";
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
import {
	agentConfigurationConformanceAdmissionsV1,
	agentConfigurationConformanceRecordV1,
} from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentConfigurationTransactionV1 } from "./agent-configuration.transaction.ts";
import { PostgresPlatformAuditQueryV1 } from "./audit.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { PostgresScopedPlatformAuditQueryV1 } from "./scoped-audit-query.ts";
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
		const originalAudit = await client`
			select * from platform.audit_events
			where action = 'agent.configuration.revised' and target_id = 'agent-1'
			order by id`;
		expect(originalAudit).toHaveLength(1);
		expect(originalAudit[0]?.details).toEqual({ changedFields: ["skills"] });
		const auditId = originalAudit[0]?.id as string;
		const legacy = new PostgresPlatformAuditQueryV1({
			databaseUrl: database?.databaseUrl ?? "",
		});
		const scoped = new PostgresScopedPlatformAuditQueryV1({
			databaseUrl: database?.databaseUrl ?? "",
		});
		const admin = {
			kind: "administrator" as const,
			administratorId: "admin-1",
		};
		try {
			const expected = {
				auditId,
				action: "agent.configuration.revised",
				summary: "agent.configuration.revised: skills",
			};
			expect(
				(
					await legacy.listAudit(
						{ schemaVersion: 1, ...admin },
						{ schemaVersion: 1, limit: 100 },
					)
				).items,
			).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
			const request = { requestId: "audit-request", traceId: "audit-trace" };
			expect(
				(
					await scoped.listAuditWithDisplayNames(
						admin,
						{
							limit: 100,
							filters: {
								action: "agent.configuration.revised",
								agentId: "agent-1",
							},
						},
						request,
					)
				).items,
			).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
			expect(
				await scoped.getAuditWithDisplayNames(
					admin,
					auditId,
					{ limit: 1, filters: {} },
					request,
				),
			).toMatchObject(expected);
			expect(
				await client`select * from platform.audit_events
				where action = 'agent.configuration.revised' and target_id = 'agent-1'
				order by id`,
			).toEqual(originalAudit);
		} finally {
			await legacy.close();
			await scoped.close();
		}
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

	it.each(["environment", "source"])(
		"retains the effective fixed bindings when %s replaces a channel revision",
		async (kind) => {
			const store = new PostgresSkillHubAgentBindingAdmissionV1({
				databaseUrl: database?.databaseUrl ?? "",
			});
			const authorizationAdmission = {
				async authorize() {
					return {
						schemaVersion: 1 as const,
						status: "admitted" as const,
						agentId: "agent-1",
						actorId: "owner-1",
						authorizationRevision: "authorization-1",
						accessAuthority,
					};
				},
			};
			const bind = createSkillHubAgentBindingUseCaseV1({
				transaction,
				bindingAdmission: store,
				bindingStatus: store,
				agentVersion: "agent-version-1",
				authorizationAdmission,
				now: () => occurredAt,
			});
			const admissions = new FakeAgentConfigurationAdmissionsV1({
				...agentConfigurationConformanceAdmissionsV1,
				images: agentConfigurationConformanceAdmissionsV1.images.map(
					(image) => ({
						...image,
						source: {
							...image.source,
							imageDigest: `sha256:${"e".repeat(64)}`,
						},
					}),
				),
			});
			const update = createAgentConfigurationUseCaseV1(
				{
					transaction,
					authorizationAdmission,
					imageAdmission: admissions,
					modelAdmission: admissions,
					secretAdmission: admissions,
					channelAdmission: admissions,
				},
				{ now: () => occurredAt },
			);
			const change = (key: string, changes: object) =>
				update.update(
					{
						schemaVersion: 2,
						agentId: "agent-1",
						idempotencyKey: key,
						requestId: key,
						traceId: key,
						changes,
					},
					actor,
				);
			try {
				await bind.bind(
					{
						schemaVersion: 1,
						agentId: "agent-1",
						agentVersion: "agent-version-1",
						expectedConfigurationRevision: 7,
						idempotencyKey: "retain-bind",
						requestId: "retain-bind",
						traceId: "retain-bind",
						bindings: [
							{ skillVersionId: "skill-version-1", grant: emptyGrant },
						],
					},
					actor,
				);
				await change("channel-only", {
					channels: [
						{
							kind: "wecom_bot",
							enabled: true,
							bindingReference: "binding_01",
						},
					],
				});
				expect(await store.readCurrentBindings(owner)).toMatchObject({
					configurationRevision: 9,
					bindings: [{ configurationRevision: 8 }],
				});
				const runtimeChanges =
					kind === "environment"
						? { environment: [{ name: "LOG_LEVEL", value: "debug" }] }
						: { source: { kind: "standard", templateId: "template_01" } };
				await change("runtime-input", runtimeChanges);
				expect(await store.readCurrentBindings(owner)).toMatchObject({
					configurationRevision: 10,
					bindings: [
						{
							configurationRevision: 10,
							skillVersion: { skillVersionId: "skill-version-1" },
							grant: emptyGrant,
							state: "pending_sync",
							appliedReceipt: null,
						},
					],
				});
				expect(
					await store.resolveSyncBindings({
						...owner,
						configurationRevision: 10,
					}),
				).toHaveLength(1);
				expect(
					await store.resolveSyncBindings({
						...owner,
						configurationRevision: 8,
					}),
				).toEqual([]);
				await expect(
					change("runtime-input", runtimeChanges),
				).resolves.toMatchObject({ revision: 10 });
				await bind.bind(
					{
						schemaVersion: 1,
						agentId: "agent-1",
						agentVersion: "agent-version-1",
						expectedConfigurationRevision: 10,
						idempotencyKey: "retain-unbind",
						requestId: "retain-unbind",
						traceId: "retain-unbind",
						bindings: [],
					},
					actor,
				);
				await change("after-unbind", {
					environment: [{ name: "LOG_LEVEL", value: "warn" }],
				});
				expect(await store.readCurrentBindings(owner)).toMatchObject({
					configurationRevision: 12,
					bindings: [],
				});
				expect(
					await client`select configuration_revision from platform.skill_hub_agent_bindings order by configuration_revision`,
				).toEqual([
					{ configuration_revision: "8" },
					{ configuration_revision: "10" },
				]);
			} finally {
				await store.close();
			}
		},
	);

	it("keeps the Runtime revision's bindings across a channel-only configuration revision (ADR-0028)", async () => {
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
		const sync = {
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			configurationRevision: 8,
			actorId: "owner-1",
			organizationIds: ["org-1"],
			isAdministrator: false,
		};
		/** Revision `revision` carries the Runtime revision `runtimeRevision`. */
		const revise = async (revision: number, runtimeRevision: number) => {
			await client`
				insert into platform.agent_configuration_revisions
				(agent_id, revision, runtime_revision, source_reference, created_at, configuration)
				select agent_id, ${revision}, ${runtimeRevision}, source_reference, created_at,
					configuration || jsonb_build_object('revision', ${revision}::int)
				from platform.agent_configuration_revisions
				where agent_id = 'agent-1' and revision = 8`;
			await client`update platform.agents set current_configuration_revision = ${revision} where id = 'agent-1'`;
		};
		try {
			await expect(
				useCase.bind(
					{
						schemaVersion: 1,
						agentId: "agent-1",
						agentVersion: "agent-version-1",
						expectedConfigurationRevision: 7,
						idempotencyKey: "bind-runtime-revision",
						requestId: "request-bind-runtime-revision",
						traceId: "trace-bind-runtime-revision",
						bindings: [
							{ skillVersionId: "skill-version-1", grant: emptyGrant },
						],
					},
					actor,
				),
			).resolves.toMatchObject({ revision: 8 });
			// Revision 9 only changes channels: the Worker still resolves revision 8.
			await revise(9, 8);
			expect(await store.resolveSyncBindings(sync)).toEqual([
				expect.objectContaining({ configurationRevision: 8 }),
			]);
			// The Owner sees the effective bindings; CAS uses the configuration revision.
			await expect(store.readCurrentBindings(owner)).resolves.toMatchObject({
				configurationRevision: 9,
				bindings: [expect.objectContaining({ configurationRevision: 8 })],
			});
			expect(await store.readCurrentConfigurationRevision(owner)).toBe(9);
			// A Runtime input revision supersedes the bindings of revision 8.
			await revise(10, 10);
			expect(await store.resolveSyncBindings(sync)).toEqual([]);
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

it("records a retryable preflight failure under the original Workload and exposes it without terminating retries", async () => {
	await client`insert into platform.skill_hub_agent_bindings(agent_id,agent_version,skill_version_id,configuration_revision,"grant",sync_revision,state,created_at,updated_at) values('agent-1','agent-version-1','skill-version-1',7,${client.json({ schemaVersion: 1, tools: [], connections: [], fileRoots: [], networkOrigins: [], scripts: false })},1,'pending_sync',now(),now())`;
	await client`insert into platform.workload_reconciliations(agent_id,revision,state) values('agent-1',1,${client.json({ schemaVersion: 1, agentId: "agent-1", revision: 1, fence: 1, phase: "preflight", sourceConfigurationRevision: 7 })})`;
	const store = new PostgresSkillHubAgentBindingAdmissionV1({
		databaseUrl: database!.databaseUrl,
	});
	try {
		const attempt = await store.captureSyncAttempt({
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			configurationRevision: 7,
			workloadRevision: 1,
			fence: 1,
			actorId: "owner-1",
			organizationIds: [],
			isAdministrator: false,
		});
		expect(attempt).toBeDefined();
		expect(
			await store.recordSyncFailure({
				attempt: attempt!,
				failure: {
					stage: "package_verification",
					reason: "dependency_unavailable",
					retryable: true,
				},
			}),
		).toBe(true);
		const view = await store.readCurrentBindings({
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			actorId: "owner-1",
			organizationIds: [],
			isAdministrator: false,
		});
		expect(view.bindings[0]).toMatchObject({
			state: "failed",
			failureReason:
				"SKILL_SYNC_PACKAGE_VERIFICATION_DEPENDENCY_UNAVAILABLE_RETRYABLE",
			appliedReceipt: null,
		});
		expect(
			(
				await store.resolveSyncBindings({
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					configurationRevision: 7,
					actorId: "owner-1",
					organizationIds: [],
					isAdministrator: false,
				})
			)[0],
		).toMatchObject({ state: "pending_sync", failureReason: null });
		expect(
			await client`select state,applied_receipt from platform.skill_hub_agent_bindings where agent_id='agent-1'`,
		).toEqual([{ state: "pending_sync", applied_receipt: null }]);
	} finally {
		await store.close();
	}
});

it("normal Worker preflight records a package verification dependency failure through the real Store without creating work", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createDeploymentSkillHubMaterializerFactoryV1 } = await import(
		"../../../apps/platform-worker/src/skill-materializer-production-assembly.js"
	);
	const root = await mkdtemp(join(tmpdir(), "4334-preflight-"));
	await client`insert into platform.skill_hub_agent_bindings(agent_id,agent_version,skill_version_id,configuration_revision,"grant",sync_revision,state,created_at,updated_at) values('agent-1','agent-version-1','skill-version-1',7,${client.json({ schemaVersion: 1, tools: [], connections: [], fileRoots: [], networkOrigins: [], scripts: false })},1,'pending_sync',now(),now())`;
	await client`insert into platform.workload_reconciliations(agent_id,revision,state) values('agent-1',1,${client.json({ schemaVersion: 1, agentId: "agent-1", revision: 1, fence: 1, phase: "preflight", sourceConfigurationRevision: 7 })})`;
	const store = new PostgresSkillHubAgentBindingAdmissionV1({
		databaseUrl: database!.databaseUrl,
	});
	const factory = createDeploymentSkillHubMaterializerFactoryV1({
		assemblyRoot: root,
		runtimeUid: process.geteuid?.() === 1000 ? 1001 : 1000,
		agentVersion: "agent-version-1",
		actor: { actorId: "owner-1", organizationIds: [], isAdministrator: false },
		store: {
			readPublication: store.readPublication.bind(store),
			resolveSyncBindings: store.resolveSyncBindings.bind(store),
			recordAppliedReceipt: store.recordAppliedReceipt.bind(store),
			captureSyncAttempt: store.captureSyncAttempt.bind(store),
			recordSyncFailure: store.recordSyncFailure.bind(store),
		},
		storage: {
			download: async () => {
				throw new Error("upstream-secret-body-must-not-persist");
			},
		} as never,
		resolveAdmissionPolicy: async () => {
			throw new Error("policy-secret-must-not-persist");
		},
		sourceVerifier: {
			verify: async () => {
				throw new Error("source-secret");
			},
		},
	});
	try {
		if (!factory) throw new Error("Expected production factory");
		const worker = await factory({
			databaseUrl: database!.databaseUrl,
			signal: new AbortController().signal,
		});
		await expect(
			worker.materialize({
				agentId: "agent-1",
				configurationRevision: 7,
				workloadRevision: 1,
				fence: 1,
			}),
		).rejects.toThrow();
		const view = await store.readCurrentBindings({
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			actorId: "owner-1",
			organizationIds: [],
			isAdministrator: false,
		});
		expect(view.bindings[0]).toMatchObject({
			state: "failed",
			failureReason:
				"SKILL_SYNC_PACKAGE_VERIFICATION_DEPENDENCY_UNAVAILABLE_RETRYABLE",
			appliedReceipt: null,
		});
		const audits =
			await client`select details from platform.audit_events where action='skill.binding.sync.failed' and agent_id='agent-1'`;
		expect(JSON.stringify(audits)).not.toMatch(/secret|body-must-not-persist/);
		expect(
			await client`select id from platform.outbox_items where operation like 'conversation.%'`,
		).toHaveLength(0);
		expect(
			await client`select execution_id from platform.conversation_executions where agent_id='agent-1'`,
		).toHaveLength(0);
		expect(
			await client`select id from platform.idempotency_records where scope_type<>'skill_package'`,
		).toHaveLength(0);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});

async function syncFixture() {
	await client`insert into platform.skill_hub_agent_bindings(agent_id,agent_version,skill_version_id,configuration_revision,"grant",sync_revision,state,created_at,updated_at) values('agent-1','agent-version-1','skill-version-1',7,${client.json({ schemaVersion: 1, tools: [], connections: [], fileRoots: [], networkOrigins: [], scripts: false })},1,'pending_sync',now(),now())`;
	await client`insert into platform.workload_reconciliations(agent_id,revision,state) values('agent-1',1,${client.json({ schemaVersion: 1, agentId: "agent-1", revision: 1, fence: 1, phase: "preflight", sourceConfigurationRevision: 7 })})`;
	const store = new PostgresSkillHubAgentBindingAdmissionV1({
		databaseUrl: database!.databaseUrl,
	});
	const attempt = await store.captureSyncAttempt({
		agentId: "agent-1",
		agentVersion: "agent-version-1",
		configurationRevision: 7,
		workloadRevision: 1,
		fence: 1,
		actorId: "owner-1",
		organizationIds: [],
		isAdministrator: false,
	});
	if (!attempt) {
		await store.close();
		throw new Error("Expected original attempt");
	}
	return { store, attempt };
}
it.each([
	{ actorId: "foreign" },
	{ agentId: "foreign" },
	{ agentVersion: "foreign" },
	{ configurationRevision: 8 },
	{ workloadRevision: 2 },
	{ fence: 2 },
	{ bindings: [{ skillVersionId: "skill-version-1", syncRevision: 2 }] },
	{ bindings: [{ skillVersionId: "foreign", syncRevision: 1 }] },
])(
	"rejects failure writes for changed original identity %j",
	async (change) => {
		const { store, attempt } = await syncFixture();
		try {
			expect(
				await store.recordSyncFailure({
					attempt: { ...attempt, ...change },
					failure: {
						stage: "binding_admission",
						reason: "dependency_unavailable",
						retryable: true,
					},
				}),
			).toBe(false);
			expect(
				await client`select id from platform.audit_events where action='skill.binding.sync.failed'`,
			).toHaveLength(0);
			expect(
				await client`select state from platform.skill_hub_agent_bindings`,
			).toEqual([{ state: "pending_sync" }]);
		} finally {
			await store.close();
		}
	},
);
it.each(["owner", "sync", "workload", "source", "revoked"] as const)(
	"rechecks %s after the attempt snapshot before committing failure",
	async (drift) => {
		const { store, attempt } = await syncFixture();
		try {
			if (drift === "owner")
				await client`delete from platform.agent_owners where agent_id='agent-1'`;
			if (drift === "sync")
				await client`update platform.skill_hub_agent_bindings set sync_revision=2 where agent_id='agent-1'`;
			if (drift === "workload")
				await client`update platform.workload_reconciliations set revision=2,state=jsonb_set(state,'{revision}','2'::jsonb) where agent_id='agent-1'`;
			if (drift === "source")
				await client`update platform.workload_reconciliations set state=jsonb_set(state,'{sourceConfigurationRevision}','8'::jsonb) where agent_id='agent-1'`;
			if (drift === "revoked")
				await client`update platform.skill_hub_agent_bindings set state='revoked' where agent_id='agent-1'`;
			expect(
				await store.recordSyncFailure({
					attempt,
					failure: {
						stage: "delivery",
						reason: "dependency_unavailable",
						retryable: true,
					},
				}),
			).toBe(false);
			expect(
				await client`select id from platform.audit_events where action='skill.binding.sync.failed'`,
			).toHaveLength(0);
		} finally {
			await store.close();
		}
	},
);
it("records a deterministic rejection without Applied and atomically rolls back when the audit fails", async () => {
	const { store, attempt } = await syncFixture();
	try {
		await client`create function platform.reject_skill_failure() returns trigger language plpgsql as $$begin if NEW.action='skill.binding.sync.failed' then raise exception 'synthetic failure';end if;return NEW;end$$`;
		await client`create trigger reject_skill_failure before insert on platform.audit_events for each row execute function platform.reject_skill_failure()`;
		try {
			await expect(
				store.recordSyncFailure({
					attempt,
					failure: {
						stage: "package_verification",
						reason: "signature_invalid",
						retryable: false,
					},
				}),
			).rejects.toThrow();
		} finally {
			await client`drop trigger reject_skill_failure on platform.audit_events`;
			await client`drop function platform.reject_skill_failure()`;
		}
		expect(
			await client`select state,failure_reason,applied_receipt from platform.skill_hub_agent_bindings`,
		).toEqual([
			{ state: "pending_sync", failure_reason: null, applied_receipt: null },
		]);
		expect(
			await store.recordSyncFailure({
				attempt,
				failure: {
					stage: "package_verification",
					reason: "signature_invalid",
					retryable: false,
				},
			}),
		).toBe(true);
		expect(
			await client`select state,failure_reason,applied_receipt from platform.skill_hub_agent_bindings`,
		).toEqual([
			{
				state: "failed",
				failure_reason:
					"SKILL_SYNC_PACKAGE_VERIFICATION_SIGNATURE_INVALID_REJECTED",
				applied_receipt: null,
			},
		]);
	} finally {
		await store.close();
	}
});

it("clears a transient failure projection only after the matching Applied receipt succeeds", async () => {
	const { store, attempt } = await syncFixture();
	try {
		await store.recordSyncFailure({
			attempt,
			failure: {
				stage: "delivery",
				reason: "dependency_unavailable",
				retryable: true,
			},
		});
		await store.recordAppliedReceipt({
			schemaVersion: 1,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			skillName: "workspace-summary",
			configurationRevision: 7,
			syncRevision: 1,
			skillVersionId: "skill-version-1",
			generationId: "e".repeat(64),
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			targetPath: ".agents/skills/workspace-summary",
			readOnly: true,
		});
		expect(
			(
				await store.readCurrentBindings({
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					actorId: "owner-1",
					organizationIds: [],
					isAdministrator: false,
				})
			).bindings[0],
		).toMatchObject({ state: "synced", failureReason: null });
		expect(
			await store.recordSyncFailure({
				attempt,
				failure: {
					stage: "delivery",
					reason: "dependency_unavailable",
					retryable: true,
				},
			}),
		).toBe(true);
		expect(
			await client`select state from platform.skill_hub_agent_bindings`,
		).toEqual([{ state: "synced" }]);
	} finally {
		await store.close();
	}
});

it.each([
	"success",
	"signature",
	"materialization",
	"delivery",
	"applied",
	"trust",
	"policy",
	"trust-after-binding-check",
	"policy-after-binding-check",
] as const)(
	"real Store and physical Skill preflight keeps %s evidence and zero executable work",
	async (mode) => {
		const { mkdtemp, rm, readdir, chmod } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { publicationFixture } = await import(
			"../../object-storage/src/skill-package-consumer.fixture.js"
		);
		const { createDeploymentSkillHubMaterializerFactoryV1 } = await import(
			"../../../apps/platform-worker/src/skill-materializer-production-assembly.js"
		);
		const f = await publicationFixture();
		if (mode === "trust") f.setPolicy({ keyState: "revoked" });
		if (mode === "policy") f.setPolicy({ policyRevision: "policy-new" });
		const root = await mkdtemp(join(tmpdir(), "4334-physical-"));
		const { store } = await syncFixture();
		await client`delete from platform.skill_hub_agent_bindings where agent_id='agent-1'`;
		await client`insert into platform.skill_hub_skills(id,name,owner_id,status,created_at,updated_at) values('skill-a',${f.version.name},'owner-1','active',now(),now())`;
		await client`insert into platform.skill_hub_versions(id,skill_id,owner_id,version,provider,visibility,state,package_object_version,package_digest,manifest_digest,signature_digest,created_at) values('version-a','skill-a','owner-1',${f.version.version},${f.version.provider},'PRIVATE','published',${f.version.packageObjectVersion},${f.version.packageDigest},${f.version.manifestDigest},${mode === "signature" ? "d".repeat(64) : f.version.signatureDigest},now())`;
		await client`insert into platform.skill_hub_installations(id,principal_type,principal_id,skill_version_id,state,installed_at,updated_at) values('installation-a','user','owner-1','version-a','installed',now(),now())`;
		await client`insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result) values('admission-a','skill_package','version-a','owner-1','skill.package.publish.v1','admission-a',${"f".repeat(64)},'completed',${client.json({ skillVersionId: "version-a" })})`;
		await client`insert into platform.skill_hub_agent_bindings(agent_id,agent_version,skill_version_id,configuration_revision,"grant",sync_revision,state,created_at,updated_at) values('agent-1','agent-version-1','version-a',7,${client.json({ schemaVersion: 1, tools: [], connections: [], fileRoots: [], networkOrigins: [], scripts: false })},1,'pending_sync',now(),now())`;
		let publicationReads = 0;
		const factory = createDeploymentSkillHubMaterializerFactoryV1({
			assemblyRoot: root,
			runtimeUid:
				mode === "materialization"
					? process.geteuid?.() || 1000
					: process.geteuid?.() === 65534
						? 65533
						: 65534,
			agentVersion: "agent-version-1",
			actor: {
				actorId: "owner-1",
				organizationIds: [],
				isAdministrator: false,
			},
			store: {
				readPublication: async () => {
					publicationReads++;
					// Two complete binding checks have each read the publication before/after verification.
					// Revoke at the materializer's independent package-verification boundary.
					if (publicationReads === 5) {
						if (mode === "trust-after-binding-check")
							f.setPolicy({ keyState: "revoked" });
						if (mode === "policy-after-binding-check")
							f.setPolicy({ policyRevision: "policy-new" });
					}
					return f.options.readPublication();
				},
				resolveSyncBindings: store.resolveSyncBindings.bind(store),
				recordAppliedReceipt:
					mode === "applied"
						? async () => {
								throw new Error("secret-upstream-must-not-leak");
							}
						: store.recordAppliedReceipt.bind(store),
				captureSyncAttempt: store.captureSyncAttempt.bind(store),
				recordSyncFailure: store.recordSyncFailure.bind(store),
			},
			storage: f.options.storage,
			resolveAdmissionPolicy: f.options.resolveAdmissionPolicy,
			sourceVerifier: f.options.sourceVerifier,
			...(mode === "delivery"
				? {
						delivery: {
							client: {
								namespace: "fixture",
								read: async () => null,
								create: async () => {
									throw new Error("secret-api-body");
								},
							} as never,
						},
					}
				: {}),
		});
		const unseal = async (path: string) => {
			await chmod(path, 0o700);
			for (const x of await readdir(path, { withFileTypes: true })) {
				if (x.isDirectory()) await unseal(join(path, x.name));
			}
		};
		try {
			if (!factory) throw new Error("Expected physical factory");
			const worker = await factory({
				databaseUrl: database!.databaseUrl,
				signal: new AbortController().signal,
			});
			const input = {
				agentId: "agent-1",
				configurationRevision: 7,
				workloadRevision: 1,
				fence: 1,
			};
			if (mode === "success") await worker.materialize(input);
			else await expect(worker.materialize(input)).rejects.toThrow();
			const binding = (
				await store.readCurrentBindings({
					agentId: "agent-1",
					agentVersion: "agent-version-1",
					actorId: "owner-1",
					organizationIds: [],
					isAdministrator: false,
				})
			).bindings[0];
			if (mode === "success")
				expect(binding).toMatchObject({
					state: "synced",
					failureReason: null,
					appliedReceipt: expect.objectContaining({
						configurationRevision: 7,
						syncRevision: 1,
						readOnly: true,
					}),
				});
			else {
				const expected = {
					trust: "SKILL_SYNC_PACKAGE_VERIFICATION_SOURCE_UNTRUSTED_REJECTED",
					"trust-after-binding-check":
						"SKILL_SYNC_PACKAGE_VERIFICATION_SOURCE_UNTRUSTED_REJECTED",
					"policy-after-binding-check":
						"SKILL_SYNC_PACKAGE_VERIFICATION_POLICY_MISMATCH_REJECTED",
					policy: "SKILL_SYNC_PACKAGE_VERIFICATION_POLICY_MISMATCH_REJECTED",
					signature: "SKILL_SYNC_PACKAGE_VERIFICATION_DIGEST_MISMATCH_REJECTED",
					materialization:
						"SKILL_SYNC_MATERIALIZATION_INVALID_MATERIALIZATION_REJECTED",
					delivery: "SKILL_SYNC_DELIVERY_DEPENDENCY_UNAVAILABLE_RETRYABLE",
					applied:
						"SKILL_SYNC_APPLIED_PERSISTENCE_DEPENDENCY_UNAVAILABLE_RETRYABLE",
				};
				expect(binding).toMatchObject({
					state: "failed",
					failureReason: expected[mode],
					appliedReceipt: null,
				});
			}
			expect(
				await client`select execution_id from platform.conversation_executions where agent_id='agent-1'`,
			).toHaveLength(0);
			expect(await client`select id from platform.outbox_items`).toHaveLength(
				0,
			);
			if (mode.endsWith("-after-binding-check"))
				expect(publicationReads).toBe(5);
			expect(f.publications).toBe(1);
			expect(
				JSON.stringify(
					await client`select details from platform.audit_events where action='skill.binding.sync.failed'`,
				),
			).not.toMatch(/secret|api-body|upstream/);
		} finally {
			await store.close();
			await unseal(root);
			await rm(root, { recursive: true, force: true });
		}
	},
);
