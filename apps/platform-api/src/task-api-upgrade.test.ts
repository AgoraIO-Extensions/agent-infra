import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import {
	type AgentConfigurationRecordV2,
	hashApiCredentialV1,
	platformIdempotencyV1,
} from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresAgentConfigurationQueryV1,
	PostgresConversationDispatchStoreV1,
} from "@agent-infra/platform-store";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "../../platform-worker/src/kubernetes.fixture.ts";
import { workloadResourceConfigurationHashV1 } from "../../platform-worker/src/workload-runtime.ts";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import { startPlatformApi } from "./index.js";

interface DatabaseReader {
	unsafe(
		query: string,
		parameters?: readonly unknown[],
	): Promise<Record<string, unknown>[]>;
	end(): Promise<void>;
}
const requireStore = createRequire(
	import.meta.resolve("@agent-infra/platform-store"),
);
const connect = requireStore("postgres") as (
	url: string,
	options: { max: number; onnotice: () => void },
) => DatabaseReader;
const readMigrationFiles = requireStore("drizzle-orm/migrator")
	.readMigrationFiles as (options: {
	migrationsFolder: string;
}) => { sql: string[]; hash: string; folderMillis: number }[];
const migrationsFolder = resolve(
	import.meta.dirname,
	"../../../migrations/platform",
);
const journal = JSON.parse(
	readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8"),
) as { entries: { tag: string }[] };
const taskMigrationIndex = journal.entries.findIndex(
	(entry) => entry.tag === "0021_task_wait_admission",
);
const migrations = readMigrationFiles({ migrationsFolder });
const configuration = agentConfigurationConformanceRecordV1;
const actorId = "upgrade_user";
const credential = "synthetic-upgrade-user-credential";
const otherCredential = "synthetic-upgrade-other-credential";
const grant = "authorization_9";
const unavailable = async (): Promise<never> => {
	throw new Error("Unexpected admission call");
};
let database: PostgresTestDatabase;
let db: DatabaseReader;
let assembly: PlatformApiAssembly | undefined;
let server: ReturnType<typeof startPlatformApi> | undefined;
let origin = "";

function request(
	path: string,
	options: {
		body?: unknown;
		key?: string;
		api?: boolean;
		other?: boolean;
		signal?: AbortSignal;
		lastEventId?: string;
	} = {},
) {
	return fetch(`${origin}/api/v1${path}`, {
		method: options.body === undefined ? "GET" : "POST",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": options.key ?? "upgrade_key",
			...(options.api
				? {
						authorization: `Bearer ${options.other ? otherCredential : credential}`,
					}
				: {
						cookie: options.other ? "other-web-session" : "upgrade-web-session",
					}),
			...(options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {}),
		},
		...(options.body === undefined
			? {}
			: { body: JSON.stringify(options.body) }),
		signal: options.signal,
	});
}

async function businessCounts() {
	const [row] =
		await db.unsafe(`select (select count(*)::int from platform.conversations) as conversations,
		(select count(*)::int from platform.conversation_executions) as executions,
		(select count(*)::int from platform.conversation_messages) as messages,
		(select count(*)::int from platform.outbox_items) as outboxes,
		(select count(*)::int from platform.idempotency_records) as idempotency,
		(select count(*)::int from platform.task_authorization_records) as task_authorizations,
		(select count(*)::int from platform.audit_events where action='task.authorization.accepted') as task_accepted_audits`);
	return row;
}

async function historicalSnapshot() {
	return {
		conversations: await db.unsafe(
			"select id,agent_id,actor_id,channel_id,status,session_generation,host_session_ref,authorization_revision,last_conversation_cursor,created_at from platform.conversations where id like 'legacy_%' order by id",
		),
		executions: await db.unsafe(
			"select execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,last_event_sequence,last_runtime_cursor,created_at from platform.conversation_executions where execution_id like 'legacy_%' order by execution_id",
		),
		messages: await db.unsafe(
			"select message_id,conversation_id,actor_id,text,execution_id,created_at from platform.conversation_messages where message_id like 'legacy_%' order by message_id",
		),
		events: await db.unsafe(
			"select event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,source,occurred_at,persisted_at from platform.conversation_events where event_id like 'legacy_%' order by event_id",
		),
		idempotency: await db.unsafe(
			"select * from platform.idempotency_records where id like 'legacy_%' order by id",
		),
		outboxes: await db.unsafe(
			"select * from platform.outbox_items where id like 'conversation:turn:legacy_%' order by id",
		),
		audits: await db.unsafe(
			"select * from platform.conversation_audit_events where id like 'legacy_%' order by id",
		),
	};
}

async function seedOldWebConversation(suffix: "complete" | "active") {
	const conversationId = `legacy_conversation_${suffix}`;
	const executionId = `legacy_execution_${suffix}`;
	const messageId = `legacy_message_${suffix}`;
	const turnId = `legacy_turn_${suffix}`;
	const text = `historical ${suffix} input`;
	const status = suffix === "complete" ? "completed" : "processing";
	await db.unsafe(
		`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,host_session_ref,
		authorization_revision,last_conversation_cursor,selected_model_option_id,selected_reasoning_level,created_at)
		values($1,$2,$3,'web',$4,3,$5,$6,2,'model_primary','low','2026-09-04T00:00:00Z')`,
		[
			conversationId,
			configuration.agentId,
			actorId,
			suffix === "complete" ? "ready" : "active",
			`legacy_host_${suffix}`,
			grant,
		],
	);
	await db.unsafe(
		`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,
		status,session_generation,delivery_fence,authorization_revision,model_configuration_revision,model_option_id,reasoning_level,
		last_event_sequence,last_runtime_cursor,created_at)
		values($1,$2,$3,$4,'web',$5,$6,3,5,$7,7,'model_primary','low',2,$8,'2026-09-04T00:00:01Z')`,
		[
			executionId,
			conversationId,
			configuration.agentId,
			actorId,
			turnId,
			status,
			grant,
			`legacy_runtime_${suffix}_2`,
		],
	);
	await db.unsafe(
		"insert into platform.conversation_messages(message_id,conversation_id,actor_id,role,text,execution_id,status,created_at) values($1,$2,$3,'user',$4,$5,'submitted','2026-09-04T00:00:01Z')",
		[messageId, conversationId, actorId, text, executionId],
	);
	for (const [sequence, event] of [
		[1, { type: "text.delta", text: `historical ${suffix} output` }],
		[2, { type: "execution.status", status }],
	] as const) {
		const eventId = `legacy_event_${suffix}_${sequence}`;
		await db.unsafe(
			`insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,
			conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,source,occurred_at)
			values($1,$2,$3,$1,$4,$4,$5,$6::text::jsonb,$7,$8,'runtime','2026-09-04T00:00:02Z')`,
			[
				eventId,
				conversationId,
				executionId,
				sequence,
				event.type,
				JSON.stringify(event),
				createHash("sha256").update(JSON.stringify(event)).digest("hex"),
				`legacy_runtime_${suffix}_${sequence}`,
			],
		);
	}
	const result = {
		schemaVersion: 1,
		status: "submitted",
		messageId,
		executionId,
	};
	const payload = {
		schemaVersion: 1,
		conversationId,
		executionId,
		messageId,
		turnId,
		sessionGeneration: 3,
		modelConfigurationRevision: 7,
		modelOptionId: "model_primary",
		reasoningLevel: "low",
	};
	await db.unsafe(
		"insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id,request_id,status,delivery_fence) values($1,'conversation',$2,'conversation.turn.submit.v1',$3::text::jsonb,'legacy_trace','legacy_request','succeeded',5)",
		[
			`conversation:turn:${executionId}`,
			conversationId,
			JSON.stringify(payload),
		],
	);
	await db.unsafe(
		"insert into platform.conversation_audit_events(id,conversation_id,execution_id,agent_id,actor_id,action,trace_id,request_id,occurred_at) values($1,$2,$3,$4,$5,'conversation.message.accepted','legacy_trace','legacy_request','2026-09-04T00:00:01Z')",
		[
			`legacy_audit_${suffix}`,
			conversationId,
			executionId,
			configuration.agentId,
			actorId,
		],
	);
	const digest = platformIdempotencyV1.canonicalRequestDigest({
		schemaVersion: 1,
		command: "message",
		conversationId,
		text,
	});
	await db.unsafe(
		"insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result) values($1,'conversation',$2,$3,'message',$4,$5,'completed',$6::text::jsonb)",
		[
			`legacy_idempotency_${suffix}`,
			conversationId,
			actorId,
			`legacy_${suffix}`,
			digest,
			JSON.stringify(result),
		],
	);
	return { conversationId, executionId, messageId, text, result };
}

async function installVerifiedWorkload(
	mode: "standard" | "platform-adapter" | "self-managed",
	supplementaryInstruction = true,
) {
	const base = workloadDesiredFixture(
		1,
		configuration.agentId,
		mode === "self-managed" ? "self-managed" : "internal-only",
	);
	const deployment = {
		...base,
		configRevision: configuration.revision,
	};
	const configured: AgentConfigurationRecordV2 = {
		...configuration,
		source:
			mode === "standard"
				? { ...configuration.source, imageDigest: deployment.imageDigest }
				: {
						kind: "custom",
						imageDigest: deployment.imageDigest,
						admissionRevision: "synthetic-upgrade-admission",
						interactionMode: mode,
						...(mode === "self-managed"
							? { identityResponsibility: "self-managed" }
							: {}),
						connectionEnabled: false,
					},
		modelConfiguration:
			mode === "standard" ? configuration.modelConfiguration : null,
		environment: [],
	};
	const version = {
		configuration: configured,
		deployment,
		executionCapacity: {
			schemaVersion: 1,
			imageDigest: deployment.imageDigest,
			resourceProfileRef: deployment.resourceProfileRef,
			resourceConfigurationHash:
				workloadResourceConfigurationHashV1(workloadTestPolicy),
			maximumConcurrentExecutions: 1,
			conformanceEvidenceHash: "c".repeat(64),
		},
	};
	await db.unsafe(
		"update platform.agent_configuration_revisions set configuration=$2::text::jsonb,source_reference=$3 where agent_id=$1",
		[
			configuration.agentId,
			JSON.stringify(configured),
			configured.source.kind === "standard"
				? configured.source.templateId
				: configured.source.imageDigest,
		],
	);
	await db.unsafe(
		"insert into platform.workload_reconciliations(agent_id,revision,state,next_attempt_at) values($1,1,$2::text::jsonb,now()) on conflict(agent_id) do update set state=excluded.state",
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
				verifiedRevision: 1,
				identity: { uid: "upgrade-synthetic-workload", generation: 1 },
				rollback: false,
				failureCode: null,
				attempts: 0,
				capabilities: { supplementaryInstruction },
			}),
		],
	);
}

async function initializeOldDatabase() {
	if (taskMigrationIndex < 1)
		throw new Error("Task migration checkpoint missing");
	await db.unsafe("drop schema if exists platform cascade");
	await db.unsafe("drop schema if exists platform_migrations cascade");
	await db.unsafe(
		"create schema platform_migrations; create table platform_migrations.history(id serial primary key,hash text not null,created_at bigint)",
	);
	for (const migration of migrations.slice(0, taskMigrationIndex)) {
		for (const statement of migration.sql) await db.unsafe(statement);
		await db.unsafe(
			"insert into platform_migrations.history(hash,created_at) values($1,$2)",
			[migration.hash, migration.folderMillis],
		);
	}
	await db.unsafe(
		"insert into platform.agents(id,current_configuration_revision,authorization_revision) values($1,7,$2)",
		[configuration.agentId, grant],
	);
	await db.unsafe(
		"insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values('upgrade_agent_application',$1,'owner_01','Upgrade Agent','Synthetic upgrade fixture','available','upgrade_trace','upgrade_request',now(),1,1,'ready','running',1,1)",
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
		"insert into platform.agent_availability(agent_id,target_type,target_id) values($1,'user',$2)",
		[configuration.agentId, actorId],
	);
}

async function startUpgradedApi() {
	await db.unsafe(
		"insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision) values($1,'user',$2,'use',$3)",
		[configuration.agentId, actorId, grant],
	);
	for (const [id, token, userId] of [
		["upgrade_credential", credential, actorId],
		["other_credential", otherCredential, "other_user"],
	]) {
		await db.unsafe(
			"insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values($1,'user',$2,$3,'[\"agent:use\"]'::jsonb)",
			[id, userId, hashApiCredentialV1(token ?? "")],
		);
	}
	assembly = assemblePlatformApi({
		databaseUrl: database.databaseUrl,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 8,
			waitingTimeoutMs: 60_000,
		},
		identity: {
			async resolve(request) {
				const cookie = request.headers.get("cookie");
				if (cookie !== "upgrade-web-session" && cookie !== "other-web-session")
					return null;
				return {
					schemaVersion: 1,
					userId: cookie === "upgrade-web-session" ? actorId : "other_user",
					displayName: "Synthetic upgrade user",
					accountStatus: "active",
					organizationIds: [],
					roles: ["employee"],
					authorizationRevision: "directory_current",
				};
			},
			async hydrateUsers() {
				return [];
			},
			async resolveUser(userId) {
				return {
					schemaVersion: 1,
					userId,
					accountStatus: "active",
					organizationIds: [],
					authorizationRevision: "directory_current",
				};
			},
		},
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
		presentAgent: unavailable,
	});
	server = startPlatformApi({
		dependencies: assembly.dependencies,
		log: () => {},
		port: 0,
	});
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function submitApiTask(key: string, conversationId?: string) {
	const response = await request(`/agents/${configuration.agentId}/tasks`, {
		api: true,
		key,
		body: {
			schemaVersion: 1,
			text: "synthetic upgraded API task",
			...(conversationId ? { conversationId } : {}),
		},
	});
	expect(response.status).toBe(202);
	return (await response.json()) as {
		conversationId: string;
		executionId: string;
	};
}
function taskPath(task: { conversationId: string; executionId: string }) {
	return `/conversations/${task.conversationId}/tasks/${task.executionId}`;
}

// Historical data predates durable task admission. Current HTTP identity and workload facts are controlled fixtures.
describe("durable task upgrade over real PostgreSQL and formal HTTP", () => {
	beforeAll(async () => {
		database = await startPostgresTestDatabase("task-api-upgrade");
		db = connect(database.databaseUrl, { max: 5, onnotice: () => {} });
	}, 60_000);
	beforeEach(initializeOldDatabase, 60_000);
	afterEach(async () => {
		if (server)
			await new Promise<void>((resolve, reject) =>
				server?.close((error) => (error ? reject(error) : resolve())),
			);
		server = undefined;
		await assembly?.close();
		assembly = undefined;
	});
	afterAll(async () => {
		await db?.end();
		await database?.stop();
	});

	it("preserves historical Web identity, Session, event IDs and idempotency through migration, read and retry", async () => {
		const old = await seedOldWebConversation("complete");
		const before = await historicalSnapshot();
		const history = await db.unsafe(
			"select * from platform_migrations.history order by id",
		);
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(await historicalSnapshot()).toEqual(before);
		expect(
			(
				await db.unsafe("select * from platform_migrations.history order by id")
			).slice(0, history.length),
		).toEqual(history);
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(await historicalSnapshot()).toEqual(before);
		await installVerifiedWorkload("standard");
		await startUpgradedApi();
		const detail = await request(`/conversations/${old.conversationId}`);
		expect(detail.status).toBe(200);
		expect(JSON.stringify(await detail.json())).toContain(
			"historical complete output",
		);
		const counts = await businessCounts();
		const replay = await request(
			`/conversations/${old.conversationId}/messages`,
			{ body: { schemaVersion: 1, text: old.text }, key: "legacy_complete" },
		);
		expect(replay.status).toBe(202);
		expect(await replay.json()).toEqual(old.result);
		expect(await businessCounts()).toEqual(counts);
		const controller = new AbortController();
		try {
			const response = await request(
				`/conversations/${old.conversationId}/events`,
				{ lastEventId: "legacy_event_complete_1", signal: controller.signal },
			);
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			let frames = "";
			while (!frames.includes("legacy_event_complete_2")) {
				const chunk = await reader?.read();
				if (!chunk || chunk.done) break;
				frames += new TextDecoder().decode(chunk.value);
			}
			expect(frames).toContain("legacy_event_complete_2");
			expect(frames).not.toContain("historical complete output");
		} finally {
			controller.abort();
		}
		const continued = await request(
			`/conversations/${old.conversationId}/messages`,
			{
				body: { schemaVersion: 1, text: "continued Web input" },
				key: "web_continue",
			},
		);
		expect(continued.status).toBe(202);
		const next = (await continued.json()) as { executionId: string };
		expect(next.executionId).not.toBe(old.executionId);
		expect(
			await db.unsafe(
				"select actor_id,channel_id,session_generation,host_session_ref from platform.conversations where id=$1",
				[old.conversationId],
			),
		).toEqual([
			{
				actor_id: actorId,
				channel_id: "web",
				session_generation: "3",
				host_session_ref: "legacy_host_complete",
			},
		]);
	}, 15_000);

	it("retains upgraded Web supplement/busy and stop behavior while refusing API channel conversion", async () => {
		const old = await seedOldWebConversation("active");
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		await installVerifiedWorkload("standard");
		await startUpgradedApi();
		const supplement = await request(
			`/conversations/${old.conversationId}/messages`,
			{
				body: { schemaVersion: 1, text: "upgraded supplement" },
				key: "supplement",
			},
		);
		expect(supplement.status).toBe(202);
		expect(await supplement.json()).toMatchObject({
			executionId: old.executionId,
		});
		await installVerifiedWorkload("standard", false);
		const before = await businessCounts();
		expect(
			(
				await request(`/conversations/${old.conversationId}/messages`, {
					body: { schemaVersion: 1, text: "busy input" },
					key: "busy",
				})
			).status,
		).toBe(409);
		expect(await businessCounts()).toEqual(before);
		expect(
			(
				await request(`/agents/${configuration.agentId}/tasks`, {
					api: true,
					body: {
						schemaVersion: 1,
						text: "invalid API continuation",
						conversationId: old.conversationId,
					},
					key: "cross-channel",
				})
			).status,
		).toBe(404);
		expect(
			(
				await request(
					`/conversations/${old.conversationId}/tasks/${old.executionId}`,
					{ api: true },
				)
			).status,
		).toBe(404);
		expect(
			(await request(`/conversations/${old.conversationId}`, { other: true }))
				.status,
		).toBe(404);
		expect(await businessCounts()).toEqual(before);
		expect(
			(
				await request(`/conversations/${old.conversationId}/stops`, {
					body: { schemaVersion: 1, targetExecutionId: old.executionId },
					key: "upgraded-stop",
				})
			).status,
		).toBe(202);
		expect(
			await db.unsafe(
				"select execution_id,status from platform.conversation_stops where execution_id=$1",
				[old.executionId],
			),
		).toEqual([{ execution_id: old.executionId, status: "submitted" }]);
		expect(
			await db.unsafe(
				"select actor_id,channel_id,session_generation from platform.conversation_executions where execution_id=$1",
				[old.executionId],
			),
		).toEqual([
			{ actor_id: actorId, channel_id: "web", session_generation: "3" },
		]);
	});

	it("accepts, reads, replays, continues and cancels new API tasks after upgrading without mutating historical Web records", async () => {
		await seedOldWebConversation("complete");
		const old = await historicalSnapshot();
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		await installVerifiedWorkload("standard");
		await startUpgradedApi();
		const task = await submitApiTask("new_task");
		expect(await submitApiTask("new_task")).toEqual(task);
		expect(
			await (await request(taskPath(task), { api: true })).json(),
		).toMatchObject({
			conversationId: task.conversationId,
			executionId: task.executionId,
			status: "waiting",
		});
		const continued = await submitApiTask(
			"continued_task",
			task.conversationId,
		);
		expect(continued.conversationId).toBe(task.conversationId);
		expect(continued.executionId).not.toBe(task.executionId);
		const before = await businessCounts();
		expect(
			(await request(taskPath(task), { api: true, other: true })).status,
		).toBe(404);
		expect(
			(
				await request(`/agents/${configuration.agentId}/tasks`, {
					api: true,
					body: { schemaVersion: 1, text: "changed retry" },
					key: "new_task",
				})
			).status,
		).toBe(409);
		expect(await businessCounts()).toEqual(before);
		expect(
			(
				await request(`${taskPath(continued)}/cancel`, {
					api: true,
					body: { schemaVersion: 1 },
					key: "cancel-new",
				})
			).status,
		).toBe(202);
		expect(
			await (await request(taskPath(continued), { api: true })).json(),
		).toMatchObject({ status: "cancelled" });
		expect(
			await (await request(taskPath(task), { api: true })).json(),
		).toMatchObject({ status: "waiting" });
		expect(await historicalSnapshot()).toEqual(old);
	});

	it("admits upgraded custom platform-adapter tasks with verified capacity and no Platform model selection", async () => {
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		await installVerifiedWorkload("platform-adapter");
		await startUpgradedApi();
		const first = await submitApiTask("custom_first");
		const second = await submitApiTask("custom_second");
		expect(
			await db.unsafe(
				"select model_configuration_revision,model_option_id,reasoning_level from platform.conversation_executions order by execution_id",
			),
		).toEqual([
			{
				model_configuration_revision: null,
				model_option_id: null,
				reasoning_level: null,
			},
			{
				model_configuration_revision: null,
				model_option_id: null,
				reasoning_level: null,
			},
		]);
		const store = new PostgresConversationDispatchStoreV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			const outcomes = await Promise.all(
				[first, second].map(async (task, index) => {
					const [row] = await db.unsafe(
						"select id from platform.outbox_items where payload->>'executionId'=$1",
						[task.executionId],
					);
					const decision = await store.claim({
						schemaVersion: 1,
						itemId: String(row?.id),
						workerId: `upgrade-capacity-${index}`,
						leaseDurationMs: 30_000,
					});
					if (decision.outcome !== "claimed")
						throw new Error(`Expected custom task claim: ${decision.outcome}`);
					return store.prepareRuntimeDispatch({
						claim: decision.claim,
						leaseDurationMs: 30_000,
					});
				}),
			);
			expect(outcomes.sort()).toEqual(["capacity_wait", true].sort());
			expect(
				(await db.unsafe("select status from platform.conversation_executions"))
					.map((row) => row.status)
					.sort(),
			).toEqual(["unknown", "waiting"]);
		} finally {
			await store.close();
		}
	});

	it("rejects self-managed custom tasks without creating Platform Conversation data", async () => {
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		await installVerifiedWorkload("self-managed");
		await startUpgradedApi();
		const before = await businessCounts();
		const response = await request(`/agents/${configuration.agentId}/tasks`, {
			api: true,
			body: { schemaVersion: 1, text: "unsupported platform task" },
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "RUNTIME_UNAVAILABLE",
		});
		expect(await businessCounts()).toEqual(before);
	});
	it.each(["starting", "updating"] as const)(
		"waits durably for %s custom tasks using the existing verified immutable configuration",
		async (availability) => {
			await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
			await installVerifiedWorkload("platform-adapter");
			await db.unsafe(
				"update platform.agent_applications set service_availability=$2 where agent_id=$1",
				[configuration.agentId, availability],
			);
			await startUpgradedApi();
			const task = await submitApiTask(`custom_${availability}`);
			expect(
				await (await request(taskPath(task), { api: true })).json(),
			).toMatchObject({ status: "waiting" });
			const queueQuery =
				"select status,task_wait_order,task_wait_deadline,session_generation,delivery_fence,model_configuration_revision,model_option_id,reasoning_level from platform.conversation_executions where execution_id=$1";
			const [original] = await db.unsafe(queueQuery, [task.executionId]);
			expect(original).toMatchObject({
				status: "waiting",
				model_configuration_revision: null,
				model_option_id: null,
				reasoning_level: null,
			});
			const [deadline] = await db.unsafe(
				"select extract(epoch from (task_wait_deadline-created_at))*1000 as duration_ms from platform.conversation_executions where execution_id=$1",
				[task.executionId],
			);
			expect(Number(deadline?.duration_ms)).toBe(60_000);
			const [outbox] = await db.unsafe(
				"select id from platform.outbox_items where payload->>'executionId'=$1",
				[task.executionId],
			);
			const store = new PostgresConversationDispatchStoreV1({
				databaseUrl: database.databaseUrl,
			});
			try {
				const claim = {
					schemaVersion: 1 as const,
					itemId: String(outbox?.id),
					workerId: `custom-${availability}`,
					leaseDurationMs: 30_000,
				};
				expect(await store.claim(claim)).toMatchObject({ outcome: "busy" });
				expect(await db.unsafe(queueQuery, [task.executionId])).toEqual([
					original,
				]);
				await db.unsafe(
					"update platform.agent_applications set service_availability='ready' where agent_id=$1",
					[configuration.agentId],
				);
				const resumed = await store.claim(claim);
				if (resumed.outcome !== "claimed")
					throw new Error(`Expected resumed custom claim: ${resumed.outcome}`);
				expect(
					await store.prepareRuntimeDispatch({
						claim: resumed.claim,
						leaseDurationMs: 30_000,
					}),
				).toBe(true);
			} finally {
				await store.close();
			}
		},
	);
	it.each(["missing-capacity", "stale-configuration", "stale-image"] as const)(
		"rejects custom task admission for %s evidence without orphan records",
		async (evidence) => {
			await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
			await installVerifiedWorkload("platform-adapter");
			if (evidence === "missing-capacity")
				await db.unsafe(
					"update platform.workload_reconciliations set state=state #- '{verified,executionCapacity}' #- '{candidate,executionCapacity}' where agent_id=$1",
					[configuration.agentId],
				);
			if (evidence === "stale-configuration") {
				await db.unsafe(
					"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) select agent_id,8,source_reference,now(),jsonb_set(configuration,'{revision}','8'::jsonb) from platform.agent_configuration_revisions where agent_id=$1 and revision=7",
					[configuration.agentId],
				);
				await db.unsafe(
					"update platform.agents set current_configuration_revision=8 where id=$1",
					[configuration.agentId],
				);
			}
			if (evidence === "stale-image")
				await db.unsafe(
					"update platform.agent_configuration_revisions set configuration=jsonb_set(configuration,'{source,imageDigest}',to_jsonb($2::text)),source_reference=$2 where agent_id=$1",
					[configuration.agentId, `sha256:${"b".repeat(64)}`],
				);
			const query = new PostgresAgentConfigurationQueryV1({
				databaseUrl: database.databaseUrl,
			});
			try {
				expect(
					await query.read({
						agentId: configuration.agentId,
						actorId,
						organizationIds: [],
						isAdministrator: false,
						intent: "discover",
					}),
				).toMatchObject({ outcome: "found" });
			} finally {
				await query.close();
			}
			await startUpgradedApi();
			const before = await businessCounts();
			const response = await request(`/agents/${configuration.agentId}/tasks`, {
				api: true,
				body: { schemaVersion: 1, text: "unverified custom task" },
			});
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				code: "RUNTIME_UNAVAILABLE",
			});
			expect(await businessCounts()).toEqual(before);
		},
	);
});
