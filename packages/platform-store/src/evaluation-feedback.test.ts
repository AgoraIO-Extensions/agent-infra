import { createHash, randomUUID } from "node:crypto";
import {
	createTaskFeedbackV1,
	type EvaluationRequestV1,
	parseEvaluationAnalysisPolicyV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresEvaluationFeedbackV1 } from "./evaluation-feedback.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresEvaluationFeedbackV1;
let core: ReturnType<typeof createTaskFeedbackV1>;
const directory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds: [],
		authorizationRevision: "identity-1",
	}),
};
const policy = parseEvaluationAnalysisPolicyV1({
	schemaVersion: 1,
	policyId: "synthetic",
	revision: 1,
	validUntil: new Date(Date.now() + 300000).toISOString(),
	maximumWindowMs: 86400000,
	maximumTasks: 100,
	maximumModelFacts: 1000,
	feedbackMetadataMs: 600000,
});
const token = (kind: string) =>
	`papi_${(kind === "user" ? "U" : "A").repeat(43)}`;
const request = (kind: string): EvaluationRequestV1 => ({
	authentication: { kind: "credential", material: token(kind) },
	requestId: randomUUID(),
	traceId: randomUUID(),
});
beforeAll(async () => {
	database = await startPostgresTestDatabase("evaluation-feedback");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 3 });
	store = new PostgresEvaluationFeedbackV1({
		...database,
		directory,
		loadPolicy: async () => policy,
	});
	core = createTaskFeedbackV1(store);
	await sql`insert into platform.agents(id,authorization_revision)values('agent','agent-1')`;
	await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence)values('app','agent','owner','Feedback','synthetic','available','seed','seed',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_owners(agent_id,owner_id,created_at)values('agent','owner',now())`;
	await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision)values('same','Synthetic','owner','identity-1')`;
	for (const kind of ["user", "application"]) {
		await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision)values('agent',${kind},'same','use','use-1')`;
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes)values(${kind},${kind},'same',${createHash("sha256").update(token(kind)).digest("hex")},${sql.json(["agent:use", "agent:read"])})`;
	}
}, 120000);
afterAll(async () => {
	await store?.close();
	await sql?.end();
	await database?.stop();
});
async function seed(kind: string, channelId = "api") {
	const id = randomUUID();
	const boundary = {
		schemaVersion: 1,
		principal: { kind, id: "same" },
		agentId: "agent",
		channelId,
		identityRevision: "identity-1",
		agentAuthorizationRevision: "agent-1",
		accessSources:
			channelId === "api"
				? [{ kind: "api-use", useGrantRevision: "use-1" }]
				: [{ kind: "user", userId: "same" }],
	};
	await sql`insert into platform.conversations(id,agent_id,actor_id,principal_type,channel_id,status,session_generation,authorization_revision)values(${id},'agent','same',${kind},${channelId},'active',1,'agent-1')`;
	await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,principal_type,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at)values(${id},${id},'agent','same',${kind},${channelId},${id},'unknown',1,1,'agent-1',clock_timestamp())`;
	await sql`insert into platform.task_authorization_records(id,execution_id,boundary)values(${randomUUID()},${id},${JSON.stringify(boundary)}::text::jsonb)`;
	await sql`update platform.conversation_executions set status='completed' where execution_id=${id}`;
	return id;
}
it.each(["user", "application"])(
	"persists only original %s feedback with bounded CAS/idempotency and current authority",
	async (kind) => {
		const id = await seed(kind);
		const actor = request(kind);
		const original = await core.get(actor, id);
		expect(original.eligibility).toBe("eligible");
		expect(original.conditions).toEqual([]);
		const command = {
			expectedRevision: original.revision,
			expectedCondition: original.conditionDigest,
			useful: false,
			categories: ["correctness"],
		};
		const key = randomUUID();
		const value = await core.submit(actor, id, key, command);
		expect(value).toMatchObject({
			revision: 1,
			principal: { kind, id: "same" },
			useful: false,
		});
		expect(await core.submit(actor, id, key, command)).toEqual(value);
		expect(
			await sql`select execution_id from platform.task_feedback where execution_id=${id}`,
		).toHaveLength(1);
		expect(
			await sql`select id from platform.audit_events where target_id=${id} and action='task.feedback.updated'`,
		).toHaveLength(1);
		await expect(
			core.get(request(kind === "user" ? "application" : "user"), id),
		).rejects.toBeDefined();
		await expect(
			core.submit(actor, id, key, { ...command, useful: true }),
		).rejects.toMatchObject({ code: "conflict" });
		const updated = await core.submit(actor, id, randomUUID(), {
			...command,
			expectedRevision: 1,
			useful: true,
			categories: [],
		});
		expect(updated.revision).toBe(2);
		await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where principal_type=${kind} and principal_id='same'`;
		try {
			await expect(core.get(actor, id)).rejects.toBeDefined();
			await expect(core.submit(actor, id, key, command)).rejects.toBeDefined();
		} finally {
			await sql`update platform.agent_principal_grants set revoked_at=null where principal_type=${kind} and principal_id='same'`;
		}
		expect((await core.get(actor, id)).feedback).toEqual(updated);
		expect(
			await sql`select execution_id from platform.conversation_executions where execution_id=${id}`,
		).toHaveLength(1);
	},
);
it("rolls feedback and receipt back when required audit fails", async () => {
	const id = await seed("user");
	const actor = request("user");
	const context = await core.get(actor, id);
	await sql.unsafe(
		"create function platform.feedback_audit_fail()returns trigger language plpgsql as $$ begin if NEW.action='task.feedback.updated' then raise exception 'synthetic audit failure'; end if;return NEW;end $$",
	);
	await sql.unsafe(
		"create trigger feedback_audit_fail before insert on platform.audit_events for each row execute function platform.feedback_audit_fail()",
	);
	try {
		await expect(
			core.submit(actor, id, randomUUID(), {
				expectedRevision: 0,
				expectedCondition: context.conditionDigest,
				useful: true,
				categories: [],
			}),
		).rejects.toBeDefined();
		expect(
			await sql`select execution_id from platform.task_feedback where execution_id=${id}`,
		).toHaveLength(0);
		expect(
			await sql`select id from platform.idempotency_records where scope_type='task_feedback' and scope_id=${id}`,
		).toHaveLength(0);
	} finally {
		await sql.unsafe(
			"drop trigger feedback_audit_fail on platform.audit_events",
		);
		await sql.unsafe("drop function platform.feedback_audit_fail()");
	}
});
it("keeps legacy terminal feedback writable while its unknown terminal window remains explicit", async () => {
	const id = await seed("user");
	await sql`alter table platform.conversation_executions disable trigger conversation_execution_terminal_observed_at`;
	try {
		await sql`update platform.conversation_executions set terminal_observed_at=null where execution_id=${id}`;
	} finally {
		await sql`alter table platform.conversation_executions enable trigger conversation_execution_terminal_observed_at`;
	}
	const actor = request("user");
	const context = await core.get(actor, id);
	expect(context.eligibility).toBe("eligible");
	expect(context.terminalObservedAt).toBeNull();
	expect(
		await core.submit(actor, id, randomUUID(), {
			expectedRevision: 0,
			expectedCondition: context.conditionDigest,
			useful: true,
			categories: [],
		}),
	).toMatchObject({ executionId: id, useful: true });
});
it("counts unfeedback Tasks and hides other Task identities in current Owner aggregate", async () => {
	const id = await seed("user");
	await seed("application");
	const query = {
		from: new Date(Date.now() - 60000).toISOString(),
		to: new Date(Date.now() + 60000).toISOString(),
	};
	const self = await store.summary(request("user"), "agent", "self", query);
	expect(self.eligibleTasks).toBeGreaterThan(self.feedbackTasks);
	expect(self.terminalTimeMissingTasks).toBe(1);
	const owner: EvaluationRequestV1 = {
		authentication: { kind: "browser", userId: "owner" },
		requestId: randomUUID(),
		traceId: randomUUID(),
	};
	const all = await store.summary(owner, "agent", "owner", query);
	expect(all.eligibleTasks).toBeGreaterThan(self.eligibleTasks);
	expect(JSON.stringify(all)).not.toContain(id);
	expect(JSON.stringify(all)).not.toMatch(
		/principal|executionId|conversationId/,
	);
	await expect(
		store.summary(request("application"), "agent", "owner", query),
	).rejects.toBeDefined();
	await sql`delete from platform.agent_owners where owner_id='owner'`;
	try {
		await expect(
			store.summary(owner, "agent", "owner", query),
		).rejects.toBeDefined();
	} finally {
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at)values('agent','owner',now())`;
	}
});

it("authorizes Web historical feedback without an API grant and accepts a newly granted current API use revision", async () => {
	const id = await seed("user", "web");
	await sql`insert into platform.agent_availability(agent_id,target_type,target_id)values('agent','user','same')`;
	await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where principal_type='user' and principal_id='same'`;
	const browser: EvaluationRequestV1 = {
		authentication: { kind: "browser", userId: "same" },
		requestId: randomUUID(),
		traceId: randomUUID(),
	};
	try {
		const context = await core.get(browser, id);
		expect(context.eligibility).toBe("eligible");
		await core.submit(browser, id, randomUUID(), {
			expectedRevision: 0,
			expectedCondition: context.conditionDigest,
			useful: true,
			categories: [],
		});
		const query = {
			from: new Date(Date.now() - 60000).toISOString(),
			to: new Date(Date.now() + 60000).toISOString(),
		};
		expect(
			(
				await store.summary(browser, "agent", "self", {
					from: context.terminalObservedAt!,
					to: new Date(
						Date.parse(context.terminalObservedAt!) + 1000,
					).toISOString(),
				})
			).eligibleTasks,
		).toBe(1);
		// The same user also has API history, whose current access is tested after regrant below.
		await sql`update platform.agent_principal_grants set revoked_at=null,authorization_revision='use-new' where principal_type='user' and principal_id='same'`;
		expect(
			(await store.summary(browser, "agent", "self", query)).feedbackTasks,
		).toBeGreaterThan(0);
		const apiId = await seed("user");
		expect((await core.get(request("user"), apiId)).eligibility).toBe(
			"eligible",
		);
	} finally {
		await sql`update platform.agent_principal_grants set revoked_at=null,authorization_revision='use-1' where principal_type='user' and principal_id='same'`;
	}
});
it("uses fresh commit time and the current shorter retention for receipts and summaries", async () => {
	const id = await seed("user");
	const actor = request("user");
	const context = await core.get(actor, id);
	const key = randomUUID();
	const command = {
		expectedRevision: 0,
		expectedCondition: context.conditionDigest,
		useful: true,
		categories: [],
	};
	const value = await core.submit(actor, id, key, command);
	// A real persisted expiry reached while the final directory check is blocked.
	const short = {
		...value,
		createdAt: new Date(Date.now() - 500).toISOString(),
		updatedAt: new Date(Date.now() - 400).toISOString(),
		metadataExpiresAt: new Date(Date.now() + 200).toISOString(),
	};
	await sql`update platform.task_feedback set metadata_expires_at=${short.metadataExpiresAt},data=${sql.json(short as unknown as postgres.JSONValue)} where execution_id=${id}`;
	let calls = 0;
	const held = new PostgresEvaluationFeedbackV1({
		...database,
		loadPolicy: async () => policy,
		directory: {
			resolveUser: async (userId) => {
				calls++;
				if (calls === 4) await sql`select pg_sleep(0.25)`;
				return directory.resolveUser(userId);
			},
		},
	});
	try {
		const read = await createTaskFeedbackV1(held).get(actor, id);
		expect(read.feedback).toBeNull();
		expect(read.revision).toBe(0);
	} finally {
		await held.close();
	}
	const narrowed = { ...policy, revision: 2, feedbackMetadataMs: 1 };
	const shorter = new PostgresEvaluationFeedbackV1({
		...database,
		directory,
		loadPolicy: async () => narrowed,
	});
	try {
		const replacement = await createTaskFeedbackV1(shorter)
			.submit(actor, id, key, command)
			.catch(() => null);
		// An expired original receipt can never be returned as a fresh acknowledgement.
		expect(replacement?.createdAt).not.toBe(value.createdAt);
	} finally {
		await shorter.close();
		policy.revision = 3;
	}
});
it.each(["owner", "web"] as const)(
	"denies historical %s access revoked by the real configuration use case during the final directory check",
	async (mode) => {
		const { drizzle } = await import("drizzle-orm/postgres-js");
		const { readAgentManagementState } = await import("./agent-management.js");
		const { PostgresAgentConfigurationTransactionV1 } = await import(
			"./agent-configuration.js"
		);
		const { createAgentConfigurationUseCaseV1 } = await import(
			"@agent-infra/platform-core"
		);
		const { FakeAgentConfigurationAdmissionsV1 } = await import(
			"../../platform-core/src/fake-agent-configuration.js"
		);
		const {
			agentConfigurationConformanceAdmissionsV1,
			agentConfigurationConformanceRecordV1,
		} = await import(
			"../../platform-core/src/agent-configuration.conformance.js"
		);
		const configuration = {
			...agentConfigurationConformanceRecordV1,
			agentId: "agent",
		};
		await sql`update platform.agents set current_configuration_revision=7 where id='agent'`;
		await sql`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration)values('agent',7,'template_01',now(),${JSON.stringify(configuration)}::text::jsonb) on conflict do nothing`;
		if (mode === "owner")
			await sql`insert into platform.agent_owners(agent_id,owner_id,created_at)values('agent','viewer',now()) on conflict do nothing`;
		else
			await sql`insert into platform.agent_availability(agent_id,target_type,target_id)values('agent','user','same') on conflict do nothing`;
		const state = await readAgentManagementState(
			drizzle<Record<string, never>>(sql),
			"agent",
		);
		if (!state) throw new Error("missing fixture state");
		const admission = new FakeAgentConfigurationAdmissionsV1({
			...agentConfigurationConformanceAdmissionsV1,
			authorizations: [
				{
					agentId: "agent",
					actorId: "owner",
					authorizationRevision: "agent-1",
					accessAuthority: {
						state,
						actorContext: {
							schemaVersion: 1,
							userId: "owner",
							accountStatus: "active",
							organizationIds: [],
							isAdministrator: false,
						},
						authorityContext: {
							schemaVersion: 1,
							users: ["owner", "viewer", "same"].map((userId) => ({
								userId,
								accountStatus: "active" as const,
							})),
							organizationIds: [],
						},
					},
				},
			],
		});
		const configTx = new PostgresAgentConfigurationTransactionV1(database);
		const configurationCore = createAgentConfigurationUseCaseV1({
			transaction: configTx,
			authorizationAdmission: admission,
			imageAdmission: admission,
			modelAdmission: admission,
			secretAdmission: admission,
			channelAdmission: admission,
		});
		const barrier = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const guarded = new PostgresEvaluationFeedbackV1({
			...database,
			loadPolicy: async () => policy,
			directory: {
				resolveUser: async (id) => {
					calls++;
					if (calls === 4) {
						barrier.resolve();
						await release.promise;
					}
					return directory.resolveUser(id);
				},
			},
		});
		const actor: EvaluationRequestV1 = {
			authentication: {
				kind: "browser",
				userId: mode === "owner" ? "viewer" : "same",
			},
			requestId: randomUUID(),
			traceId: randomUUID(),
		};
		const id = mode === "web" ? await seed("user", "web") : null;
		const pending =
			mode === "owner"
				? guarded.summary(actor, "agent", "owner", {
						from: new Date(Date.now() - 60000).toISOString(),
						to: new Date(Date.now() + 60000).toISOString(),
					})
				: createTaskFeedbackV1(guarded).get(actor, id!);
		const outcome = Promise.allSettled([pending]);
		try {
			await Promise.race([
				barrier.promise,
				pending.then(() => {
					throw new Error("missing final barrier");
				}),
			]);
			const mutation = await configurationCore.update(
				{
					schemaVersion: 2,
					agentId: "agent",
					idempotencyKey: randomUUID(),
					requestId: randomUUID(),
					traceId: randomUUID(),
					changes: mode === "owner" ? { coOwnerIds: [] } : { availability: [] },
				},
				{
					schemaVersion: 1,
					actorId: "owner",
					rawRequestDigest: "a".repeat(64),
				},
			);
			expect(mutation).toBeDefined();
			release.resolve();
			expect(await outcome).toEqual([
				expect.objectContaining({
					status: "rejected",
					reason: expect.objectContaining({ code: "denied" }),
				}),
			]);
		} finally {
			release.resolve();
			await outcome;
			await guarded.close();
			await configTx.close();
		}
	},
	30000,
);

it("authorizes a genuinely empty self window and conceals an unavailable Agent without relying on Task rows", async () => {
	const query = {
		from: "2026-01-01T00:00:00.000Z",
		to: "2026-01-02T00:00:00.000Z",
	};
	expect(
		(await store.summary(request("user"), "agent", "self", query))
			.eligibleTasks,
	).toBe(0);
	const outsider: EvaluationRequestV1 = {
		authentication: { kind: "browser", userId: "outsider" },
		requestId: randomUUID(),
		traceId: randomUUID(),
	};
	for (const agentId of ["agent", "does-not-exist"])
		await expect(
			store.summary(outsider, agentId, "self", query),
		).rejects.toMatchObject({ code: "denied" });
});
it("deduplicates persisted model phases/attempts and keeps mixed actual conditions in a single Task denominator", async () => {
	const id = await seed("user");
	const model = {
		configVersion: "7",
		modelOptionId: "option",
		modelId: "actual-a",
	};
	const facts = [
		{
			kind: "model",
			operationRef: "first",
			attemptRef: "one",
			phase: "intent",
			model,
		},
		{
			kind: "model",
			operationRef: "first",
			attemptRef: "one",
			phase: "started",
			model,
		},
		{
			kind: "model",
			operationRef: "first",
			attemptRef: "one",
			phase: "completed",
			model,
			usage: { inputTokens: 7, outputTokens: 0 },
		},
		{
			kind: "model",
			operationRef: "second",
			attemptRef: "two",
			phase: "started",
			model: { ...model, modelId: "actual-b" },
		},
	];
	for (const [index, fact] of facts.entries())
		await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)values(${randomUUID()},${id},${id},${index + 1},${index + 1},'execution.operation',${JSON.stringify({ schemaVersion: 2, type: "execution.operation", fact })}::text::jsonb,'runtime',${randomUUID()},${"a".repeat(64)},${String(index + 1)},clock_timestamp())`;
	await sql`update platform.conversation_executions set last_event_sequence=${facts.length} where execution_id=${id}`;
	const context = await core.get(request("user"), id);
	expect(context.conditions).toHaveLength(2);
	const query = {
		from: new Date(Date.now() - 60000).toISOString(),
		to: new Date(Date.now() + 60000).toISOString(),
		modelId: "actual-a",
		configVersion: "7",
	};
	const before = await store.summary(request("user"), "agent", "self", query);
	expect(before.eligibleTasks).toBe(1);
	expect(before.feedbackTasks).toBe(0);
	await core.submit(request("user"), id, randomUUID(), {
		expectedRevision: 0,
		expectedCondition: context.conditionDigest,
		useful: true,
		categories: [],
	});
	const after = await store.summary(request("user"), "agent", "self", query);
	expect(after.eligibleTasks).toBe(1);
	expect(after.feedbackTasks).toBe(1);
	expect(after.conditions[0]?.conditions).toHaveLength(2);
	const [plan] =
		await sql`explain (analyze,format json) select execution_id from platform.conversation_executions where agent_id='agent' and principal_type='user' and actor_id='same' and terminal_observed_at>=${query.from}::timestamptz and terminal_observed_at<${query.to}::timestamptz and status in ('completed','failed','cancelled') order by terminal_observed_at,execution_id`;
	expect(JSON.stringify(plan)).toContain("Actual Rows");
});

it("removes entire expired feedback rows and receipts through the existing Eval cleanup sweep", async () => {
	const id = await seed("user");
	const context = await core.get(request("user"), id);
	const key = randomUUID();
	await core.submit(request("user"), id, key, {
		expectedRevision: 0,
		expectedCondition: context.conditionDigest,
		useful: false,
		categories: ["other"],
	});
	const expired = new Date(Date.now() - 1000).toISOString();
	await sql`update platform.task_feedback set metadata_expires_at=${expired}::timestamptz,data=jsonb_set(data,'{metadataExpiresAt}',to_jsonb(${expired}::text)) where execution_id=${id}`;
	await sql`update platform.idempotency_records set result=jsonb_set(result,'{metadataExpiresAt}',to_jsonb(${expired}::text)) where scope_type='task_feedback' and scope_id=${id}`;
	const { PostgresEvaluationDataStoreV1 } = await import(
		"./evaluation-data.js"
	);
	const cleanup = new PostgresEvaluationDataStoreV1(database);
	try {
		await cleanup.expired(100);
	} finally {
		await cleanup.close();
	}
	expect(
		await sql`select execution_id from platform.task_feedback where execution_id=${id}`,
	).toHaveLength(0);
	expect(
		await sql`select id from platform.idempotency_records where scope_type='task_feedback' and scope_id=${id}`,
	).toHaveLength(0);
	expect(
		await sql`select execution_id from platform.conversation_executions where execution_id=${id}`,
	).toHaveLength(1);
});

it("does not create earlier deletion obligations from stale or expired analysis policies", async () => {
	const id = await seed("user");
	const context = await core.get(request("user"), id);
	await core.submit(request("user"), id, randomUUID(), {
		expectedRevision: 0,
		expectedCondition: context.conditionDigest,
		useful: true,
		categories: [],
	});
	const { PostgresEvaluationDataStoreV1 } = await import(
		"./evaluation-data.js"
	);
	const cleanup = new PostgresEvaluationDataStoreV1(database);
	try {
		for (const invalid of [
			{ ...policy, revision: policy.revision - 1, feedbackMetadataMs: 1 },
			{
				...policy,
				validUntil: "2020-01-01T00:00:00.000Z",
				feedbackMetadataMs: 1,
			},
		]) {
			await cleanup.expired(100, invalid);
			expect(
				await sql`select execution_id from platform.task_feedback where execution_id=${id}`,
			).toHaveLength(1);
		}
		await cleanup.expired(100);
		expect(
			await sql`select execution_id from platform.task_feedback where execution_id=${id}`,
		).toHaveLength(1);
		const futurePolicy = {
			...policy,
			revision: policy.revision + 1,
			feedbackMetadataMs: 1,
		};
		await sql`update platform.evaluation_policies set revision=${futurePolicy.revision},digest=${createHash("sha256").update(JSON.stringify(futurePolicy)).digest("hex")} where id='analysis'`;
		await cleanup.expired(100, futurePolicy);
		expect(
			await sql`select execution_id from platform.task_feedback where execution_id=${id}`,
		).toHaveLength(0);
	} finally {
		policy.revision += 2;
		await cleanup.close();
	}
});

it("bounds candidate scanning before actual-model filtering without truncating the denominator", async () => {
	const from = new Date().toISOString();
	const ids = [await seed("application"), await seed("application")];
	for (const [index, id] of ids.entries()) {
		const fact = {
			kind: "model",
			operationRef: "operation",
			attemptRef: "attempt",
			phase: "started",
			model: {
				configVersion: "7",
				modelOptionId: "option",
				modelId: `budget-model-${index}`,
			},
		};
		await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)values(${randomUUID()},${id},${id},1,1,'execution.operation',${JSON.stringify({ schemaVersion: 2, type: "execution.operation", fact })}::text::jsonb,'runtime',${randomUUID()},${"a".repeat(64)},'1',clock_timestamp())`;
		await sql`update platform.conversation_executions set last_event_sequence=1 where execution_id=${id}`;
	}
	const query = {
		from,
		to: new Date(Date.now() + 1000).toISOString(),
		modelId: "budget-model-0",
		configVersion: "7",
	};
	let current = { ...policy, revision: 10, maximumTasks: 1 };
	const bounded = new PostgresEvaluationFeedbackV1({
		...database,
		directory,
		loadPolicy: async () => current,
	});
	try {
		await expect(
			bounded.summary(request("application"), "agent", "self", query),
		).rejects.toMatchObject({ code: "query_too_large" });
		current = { ...current, revision: 11, maximumTasks: 2 };
		const result = await bounded.summary(
			request("application"),
			"agent",
			"self",
			query,
		);
		expect(result.eligibleTasks).toBe(1);
		expect(result.feedbackTasks).toBe(0);
		current = { ...current, revision: 12, maximumModelFacts: 1 };
		await expect(
			bounded.summary(request("application"), "agent", "self", query),
		).rejects.toMatchObject({ code: "query_too_large" });
	} finally {
		await bounded.close();
	}
});
