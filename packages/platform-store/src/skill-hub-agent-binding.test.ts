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
		platform.audit_events cascade`;
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
		expect(replay).toEqual(result);
		expect(
			await client`select count(*)::int as count from platform.skill_hub_agent_bindings`,
		).toEqual([{ count: 1 }]);
	});
});
