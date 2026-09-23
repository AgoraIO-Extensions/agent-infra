import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { CurrentTaskUserV1 } from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresAgentConfigurationQueryV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { workloadDesiredFixture } from "../../platform-worker/src/kubernetes.fixture.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";
import { startPlatformApi } from "./index.js";

interface DatabaseReader {
	unsafe(
		query: string,
		parameters?: readonly unknown[],
	): Promise<Record<string, unknown>[]>;
	end(): Promise<void>;
}
const connectDatabase = createRequire(
	import.meta.resolve("@agent-infra/platform-store"),
)("postgres") as (
	url: string,
	options: { max: number; onnotice: () => void },
) => DatabaseReader;
const configuration = agentConfigurationConformanceRecordV1;
const identity: IdentityContext = {
	schemaVersion: 1 as const,
	userId: "user_01",
	displayName: "Task test user",
	accountStatus: "active" as const,
	organizationIds: ["org_current"],
	roles: ["employee" as const],
	authorizationRevision: "authorization_9",
};
const currentUser: CurrentTaskUserV1 = {
	schemaVersion: 1 as const,
	userId: identity.userId,
	accountStatus: "active" as const,
	organizationIds: ["org_current"],
	authorizationRevision: "directory_17",
};
let browserIdentity = identity;
const resolveUser = vi.fn(
	async (_userId: string): Promise<unknown> => currentUser,
);
const adapter: IdentityAdapter = {
	async resolve() {
		return browserIdentity;
	},
	async hydrateUsers() {
		return [];
	},
	resolveUser,
};
const unavailable = async (): Promise<never> => {
	throw new Error("Unexpected admission call");
};
let database: PostgresTestDatabase;
let db: DatabaseReader;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof startPlatformApi>;
let origin: string;
async function post(path: string, body: unknown, key: string) {
	return fetch(`${origin}/api/v1${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": key,
			"X-User-Id": "forged_user",
			"X-Agent-Id": "forged_agent",
			"X-Channel-Id": "forged_channel",
			"X-Authorization-Revision": "forged_revision",
		},
		body: JSON.stringify(body),
	});
}
async function createConversation() {
	const response = await post(
		`/agents/${configuration.agentId}/conversations`,
		{ schemaVersion: 1 },
		"create",
	);
	expect(response.status).toBe(201);
	const body = (await response.json()) as { conversationId: string };
	return body.conversationId;
}
async function snapshot() {
	const [counts] = await db.unsafe(`select
    (select count(*)::int from platform.conversation_executions) as executions,
    (select count(*)::int from platform.conversation_messages) as messages,
    (select count(*)::int from platform.task_authorization_records) as authorizations,
    (select count(*)::int from platform.outbox_items) as outbox,
    (select count(*)::int from platform.audit_events where action='task.authorization.accepted') as task_audits,
    (select count(*)::int from platform.conversation_audit_events) as conversation_audits,
    (select count(*)::int from platform.idempotency_records) as idempotency`);
	return counts;
}
// Controlled directory facts test the formal assembly, not real identity-provider acceptance.
describe("API task boundary over real HTTP and PostgreSQL", () => {
	beforeAll(async () => {
		database = await startPostgresTestDatabase("api-task-boundary");
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		db = connectDatabase(database.databaseUrl, { max: 2, onnotice: () => {} });
		assembly = assemblePlatformApi({
			databaseUrl: database.databaseUrl,
			identity: adapter,
			admissions: {
				authorizationAdmission: { authorize: unavailable },
				imageAdmission: { admitImage: unavailable },
				modelAdmission: { admitModels: unavailable },
				secretAdmission: { admitSecrets: unavailable },
				channelAdmission: { admitChannels: unavailable },
			},
			allocateApplicationIds: unavailable,
			prepareApplicationSecrets: unavailable,
			prepareConfigurationSecrets: unavailable,
			// Browser projection availability is not task authorization authority.
			presentAgent: unavailable,
		});
		server = startPlatformApi({
			dependencies: assembly.dependencies,
			log: () => {},
			port: 0,
		});
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}, 60_000);
	beforeEach(async () => {
		browserIdentity = identity;
		adapter.resolveUser = resolveUser;
		resolveUser.mockReset().mockResolvedValue(currentUser);
		await db.unsafe("truncate platform.agents, platform.conversations cascade");
		await db.unsafe(
			"truncate platform.outbox_items, platform.idempotency_records, platform.audit_events",
		);
		await db.unsafe(
			"insert into platform.agents(id,current_configuration_revision,authorization_revision) values($1,7,'authorization_9')",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values('application_01',$1,'owner_01','Agent','Synthetic task test','available','trace_seed','request_seed',now(),11,1,'ready','running',1,1)",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values($1,7,'template_01',now(),$2::text::jsonb)",
			[configuration.agentId, JSON.stringify(configuration)],
		);
		await db.unsafe(
			"insert into platform.agent_owners(agent_id,owner_id,created_at) values($1,'owner_01',now())",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_availability(agent_id,target_type,target_id) values($1,'organization','org_current')",
			[configuration.agentId],
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		if (server)
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		await assembly?.close();
		await db?.end();
		await database?.stop();
	});
	it("persists the current user boundary together with the accepted task", async () => {
		browserIdentity = {
			...identity,
			organizationIds: ["org_stale"],
			authorizationRevision: "browser_stale",
		};
		const conversationId = await createConversation();
		const response = await post(
			`/conversations/${conversationId}/messages`,
			{ schemaVersion: 1, text: "synthetic message" },
			"message",
		);
		expect(response.status).toBe(202);
		const accepted = (await response.json()) as { executionId: string };
		expect(resolveUser).toHaveBeenCalledWith(identity.userId);
		const records = await db.unsafe(
			"select execution_id,boundary from platform.task_authorization_records",
		);
		expect(records).toEqual([
			{
				execution_id: accepted.executionId,
				boundary: {
					schemaVersion: 1,
					principal: { kind: "user", id: identity.userId },
					agentId: configuration.agentId,
					channelId: "web",
					identityRevision: currentUser.authorizationRevision,
					agentAuthorizationRevision: "authorization_9",
					accessSources: [
						{ kind: "organization", organizationId: "org_current" },
					],
				},
			},
		]);
	});
	it.each(["stale", "unavailable", "failure"] as const)(
		"rejects a %s capability snapshot without persisting a task",
		async (mode) => {
			const conversationId = await createConversation();
			const before = await snapshot();
			const read =
				PostgresAgentConfigurationQueryV1.prototype.readRuntimePresentation;
			vi.spyOn(
				PostgresAgentConfigurationQueryV1.prototype,
				"readRuntimePresentation",
			).mockImplementationOnce(async function (
				this: PostgresAgentConfigurationQueryV1,
				input,
			) {
				if (mode === "failure") throw new Error("private Store payload");
				await db.unsafe(
					mode === "stale"
						? "update platform.agent_applications set management_revision=12 where agent_id=$1"
						: "delete from platform.agent_availability where agent_id=$1",
					[configuration.agentId],
				);
				const result = await read.call(this, input);
				expect(result.outcome).toBe(mode);
				return result;
			});
			const response = await post(
				`/conversations/${conversationId}/messages`,
				{ schemaVersion: 1, text: "synthetic" },
				"capability-unavailable",
			);
			expect(response.status).toBe(503);
			const body = await response.json();
			expect(body).toMatchObject({
				code: "DEPENDENCY_UNAVAILABLE",
				retryable: true,
			});
			expect(JSON.stringify(body)).not.toContain("private Store payload");
			expect(await snapshot()).toEqual(before);
		},
	);
	it.each(["enabled", "disabled", "absent", "drifted"] as const)(
		"accepts supplements only with a currently verified capability: %s",
		async (mode) => {
			const deployment = {
				...workloadDesiredFixture(1, configuration.agentId, "internal-only"),
				configRevision: configuration.revision,
			};
			const configured = {
				...configuration,
				source: {
					...configuration.source,
					imageDigest: deployment.imageDigest,
				},
			};
			await db.unsafe(
				"update platform.agent_configuration_revisions set configuration=$2::text::jsonb where agent_id=$1",
				[configuration.agentId, JSON.stringify(configured)],
			);
			const version = { configuration: configured, deployment };
			if (mode !== "absent")
				await db.unsafe(
					"insert into platform.workload_reconciliations(agent_id,revision,state,next_attempt_at) values($1,1,$2::text::jsonb,now())",
					[
						configuration.agentId,
						JSON.stringify({
							schemaVersion: 1,
							agentId: configuration.agentId,
							sourceConfigurationRevision: configuration.revision,
							sourceLifecycleRevision: 1,
							revision: 1,
							fence: 1,
							phase: "ready",
							candidate: version,
							verified: version,
							verifiedRevision: mode === "drifted" ? 2 : 1,
							identity: { uid: "observed-uid", generation: 1 },
							rollback: false,
							failureCode: null,
							attempts: 0,
							capabilities: { supplementaryInstruction: mode !== "disabled" },
						}),
					],
				);
			const conversationId = await createConversation();
			const first = await post(
				`/conversations/${conversationId}/messages`,
				{ schemaVersion: 1, text: "first message" },
				"first",
			);
			expect(first.status).toBe(202);
			const accepted = (await first.json()) as { executionId: string };
			const before = await snapshot();
			const supplement = await post(
				`/conversations/${conversationId}/messages`,
				{ schemaVersion: 1, text: "supplement" },
				"supplement",
			);
			expect(supplement.status).toBe(mode === "enabled" ? 202 : 409);
			if (mode === "enabled")
				expect(await supplement.json()).toMatchObject({
					executionId: accepted.executionId,
				});
			else expect(await snapshot()).toEqual(before);
		},
	);
	it("replays acceptance once and preserves read, stop, and audit bindings", async () => {
		const conversationId = await createConversation();
		const body = { schemaVersion: 1, text: "private-task-test-sentinel" };
		const path = `/conversations/${conversationId}/messages`;
		const accepted = await post(path, body, "message");
		expect(accepted.status).toBe(202);
		const result = (await accepted.json()) as { executionId: string };
		const before = await snapshot();
		const replay = await post(path, body, "message");
		expect(replay.status).toBe(202);
		expect(await replay.json()).toEqual(result);
		expect(await snapshot()).toEqual(before);
		expect(before).toMatchObject({
			executions: 1,
			authorizations: 1,
			outbox: 1,
			task_audits: 1,
		});
		const audits = await db.unsafe(
			"select actor_id,target_id,details from platform.audit_events where action='task.authorization.accepted'",
		);
		expect(audits[0]).toMatchObject({
			actor_id: identity.userId,
			target_id: result.executionId,
			details: {
				identityRevision: currentUser.authorizationRevision,
				agentAuthorizationRevision: "authorization_9",
			},
		});
		expect(JSON.stringify(audits)).not.toContain(body.text);
		browserIdentity = {
			...identity,
			authorizationRevision: "browser_stale",
			organizationIds: ["org_stale"],
		};
		expect(
			(await fetch(`${origin}/api/v1/conversations/${conversationId}`)).status,
		).toBe(200);
		expect(
			(
				await fetch(
					`${origin}/api/v1/conversations/${conversationId}/executions/${result.executionId}`,
				)
			).status,
		).toBe(200);
		const stopped = await post(
			`/conversations/${conversationId}/stops`,
			{ schemaVersion: 1, targetExecutionId: result.executionId },
			"stop",
		);
		expect(stopped.status).toBe(202);
		expect(await snapshot()).toMatchObject({
			executions: 1,
			authorizations: 1,
			task_audits: 1,
		});
	});

	it("captures a fresh boundary for regeneration after a controlled terminal fixture", async () => {
		const conversationId = await createConversation();
		const accepted = await post(
			`/conversations/${conversationId}/messages`,
			{ schemaVersion: 1, text: "synthetic" },
			"message",
		);
		expect(accepted.status).toBe(202);
		const original = (await accepted.json()) as {
			executionId: string;
			messageId: string;
		};
		// Only the prerequisite is simulated; regeneration acceptance uses the real HTTP transaction.
		await db.unsafe(
			"update platform.conversation_executions set status='completed' where execution_id=$1",
			[original.executionId],
		);
		resolveUser.mockResolvedValue({
			...currentUser,
			authorizationRevision: "directory_18",
		});
		const response = await post(
			`/conversations/${conversationId}/regenerations`,
			{ schemaVersion: 1, messageId: original.messageId },
			"regenerate",
		);
		expect(response.status).toBe(202);
		const result = (await response.json()) as { executionId: string };
		expect(result.executionId).not.toBe(original.executionId);
		expect(
			await db.unsafe(
				"select boundary from platform.task_authorization_records where execution_id=$1",
				[result.executionId],
			),
		).toMatchObject([
			{
				boundary: {
					identityRevision: "directory_18",
					agentAuthorizationRevision: "authorization_9",
				},
			},
		]);
		expect(await snapshot()).toMatchObject({
			executions: 2,
			authorizations: 2,
			outbox: 2,
			task_audits: 2,
		});
	});

	it("selects the configured model using current directory facts", async () => {
		const conversationId = await createConversation();
		browserIdentity = {
			...identity,
			authorizationRevision: "browser_stale",
			organizationIds: ["org_stale"],
		};
		const response = await fetch(
			`${origin}/api/v1/conversations/${conversationId}/model-selection`,
			{
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "select",
				},
				body: JSON.stringify({
					schemaVersion: 1,
					modelOptionId: "model_primary",
					reasoningLevel: "low",
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			selectedModelOptionId: "model_primary",
		});
	});

	it("lists Conversations with current directory facts", async () => {
		await createConversation();
		browserIdentity = {
			...identity,
			authorizationRevision: "browser_stale",
			organizationIds: ["org_stale"],
		};
		const response = await fetch(
			`${origin}/api/v1/agents/${configuration.agentId}/conversations`,
		);
		expect(response.status).toBe(200);
	});

	it("opens SSE using current directory revision", async () => {
		const conversationId = await createConversation();
		browserIdentity = {
			...identity,
			authorizationRevision: "browser_stale",
			organizationIds: ["org_stale"],
		};
		const response = await fetch(
			`${origin}/api/v1/conversations/${conversationId}/events`,
			{
				signal: AbortSignal.timeout(3000),
				headers: { "Last-Event-ID": "missing_event" },
			},
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await response.text()).toContain("timeline.reload");
	});

	it.each(["missing", "throws", "wrong_user", "malformed"] as const)(
		"returns sanitized 503 for %s directory facts",
		async (mode) => {
			const conversationId = await createConversation();
			if (mode === "missing") delete adapter.resolveUser;
			if (mode === "throws")
				resolveUser.mockRejectedValue(new Error("private upstream payload"));
			if (mode === "wrong_user")
				resolveUser.mockResolvedValue({ ...currentUser, userId: "other_user" });
			if (mode === "malformed")
				resolveUser.mockResolvedValue({
					...currentUser,
					credential: "private upstream payload",
				});
			const before = await snapshot();
			const response = await post(
				`/conversations/${conversationId}/messages`,
				{ schemaVersion: 1, text: "private message" },
				"rejected",
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				code: "DEPENDENCY_UNAVAILABLE",
				retryable: true,
			});
			expect(await snapshot()).toEqual(before);
		},
	);

	it.each([null, { ...currentUser, accountStatus: "disabled" }])(
		"returns 403 for confirmed inactive directory user %j",
		async (value) => {
			const conversationId = await createConversation();
			resolveUser.mockResolvedValue(value);
			const before = await snapshot();
			const response = await post(
				`/conversations/${conversationId}/messages`,
				{ schemaVersion: 1, text: "synthetic" },
				"revoked",
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: "AUTHORIZATION_REVOKED",
				retryable: false,
			});
			expect(await snapshot()).toEqual(before);
		},
	);

	it("cannot use stale organization membership, another user's Conversation, or another Agent", async () => {
		const conversationId = await createConversation();
		const before = await snapshot();
		resolveUser.mockResolvedValue({ ...currentUser, organizationIds: [] });
		expect(
			(
				await post(
					`/conversations/${conversationId}/messages`,
					{ schemaVersion: 1, text: "synthetic" },
					"stale_org",
				)
			).status,
		).toBe(404);
		resolveUser.mockResolvedValue({ ...currentUser, userId: "other_user" });
		browserIdentity = { ...identity, userId: "other_user" };
		expect(
			(
				await post(
					`/conversations/${conversationId}/messages`,
					{ schemaVersion: 1, text: "synthetic" },
					"other_subject",
				)
			).status,
		).toBe(404);
		browserIdentity = identity;
		resolveUser.mockResolvedValue(currentUser);
		expect(
			(
				await post(
					"/agents/other_agent/conversations",
					{ schemaVersion: 1 },
					"other_agent",
				)
			).status,
		).toBe(404);
		expect(
			(
				await post(
					`/conversations/${conversationId}/messages`,
					{
						schemaVersion: 1,
						text: "synthetic",
						actorId: "other_user",
						agentId: "other_agent",
					},
					"forged_body",
				)
			).status,
		).toBe(400);
		await db.unsafe("delete from platform.agent_availability");
		expect(
			(
				await post(
					`/conversations/${conversationId}/messages`,
					{ schemaVersion: 1, text: "synthetic" },
					"revoked_grant",
				)
			).status,
		).toBe(404);
		expect(await snapshot()).toEqual(before);
	});

	it.each(["task_authorization_records", "audit_events"] as const)(
		"rolls all task effects back when %s insert fails",
		async (table) => {
			const conversationId = await createConversation();
			const before = await snapshot();
			await db.unsafe(
				"create function platform.fail_task_acceptance() returns trigger as $$ begin raise exception 'controlled persistence failure'; end; $$ language plpgsql",
			);
			await db.unsafe(
				`create trigger fail_task_acceptance before insert on platform.${table} for each row execute function platform.fail_task_acceptance()`,
			);
			try {
				const response = await post(
					`/conversations/${conversationId}/messages`,
					{ schemaVersion: 1, text: "synthetic" },
					"rollback",
				);
				expect(response.status).toBe(503);
				expect(await snapshot()).toEqual(before);
			} finally {
				await db.unsafe(
					`drop trigger fail_task_acceptance on platform.${table}`,
				);
				await db.unsafe("drop function platform.fail_task_acceptance()");
			}
		},
	);

	it("does not dispatch a task when the Agent revision changes after boundary capture", async () => {
		const conversationId = await createConversation();
		const before = await snapshot();
		const capture =
			PostgresTaskAuthorizationStoreV1.prototype.captureUserBoundary;
		vi.spyOn(
			PostgresTaskAuthorizationStoreV1.prototype,
			"captureUserBoundary",
		).mockImplementation(async function (
			this: PostgresTaskAuthorizationStoreV1,
			input,
		) {
			const boundary = await capture.call(this, input);
			await db.unsafe(
				"update platform.agents set authorization_revision='authorization_changed' where id=$1",
				[configuration.agentId],
			);
			return boundary;
		});
		const response = await post(
			`/conversations/${conversationId}/messages`,
			{ schemaVersion: 1, text: "synthetic" },
			"revision_race",
		);
		expect(response.status).toBe(503);
		expect(await snapshot()).toEqual(before);
	});
});
