import { createHash, randomUUID } from "node:crypto";
import {
	createEvaluationDataV1,
	createEvaluationExperimentsV1,
	evaluationRetainedMetadataFieldsV1,
	parseEvaluationExperimentPolicyV1,
	parseEvaluationPolicyV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeObjectStorageV1 } from "../../object-storage/src/index.js";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.js";
import { PostgresEvaluationDataStoreV1 } from "./evaluation-data.js";
import { PostgresEvaluationExperimentsV1 } from "./evaluation-experiments.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let dataStore: PostgresEvaluationDataStoreV1;
let experiments: PostgresEvaluationExperimentsV1;
const storage = new FakeObjectStorageV1();
const directory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds: [],
		authorizationRevision: "identity-1",
	}),
};
const retention = {
	contentMs: 600000,
	metadataMs: 1200000,
	deleteWithinMs: 10000,
};
const policy = parseEvaluationPolicyV1({
	schemaVersion: 1,
	policyId: "fixture",
	revision: 1,
	validUntil: new Date(Date.now() + 600000).toISOString(),
	managers: [
		{
			principal: { kind: "user", id: "admin" },
			scopes: ["team"],
			operations: [
				"create",
				"import",
				"read",
				"run",
				"score",
				"review",
				"manage_grants",
				"delete",
			],
			maxGrantMs: 600000,
		},
	],
	retainedMetadataFields: evaluationRetainedMetadataFieldsV1,
	materialApprovals: [
		{
			approvalId: "synthetic-fixture",
			scope: "team",
			kind: "synthetic",
			redactionRef: null,
		},
	],
	retention: {
		samples: { ...retention, startsAt: "version_reserved" },
		rubric: { ...retention, startsAt: "version_reserved" },
		output: { ...retention, startsAt: "content_created" },
		score: { ...retention, startsAt: "content_created" },
		review: { ...retention, startsAt: "content_created" },
	},
	maxContentBytes: 65536,
	transferTimeoutMs: 5000,
	pendingMs: 60000,
});
const scorer = {
	scorerId: "exact",
	version: "1",
	rubricId: "quality",
	minimum: 0,
	maximum: 1,
	passThreshold: 1,
	maxInputBytes: 65536,
	maxOutputBytes: 4096,
	timeoutMs: 1000,
	maxAttempts: 2,
	retryDelayMs: 1000,
	implementation: { kind: "rule", rule: "exact_match" },
};
const configuration = {
	...agentConfigurationConformanceRecordV1,
	schemaVersion: 1 as const,
	actions: [],
	actionSetRevision: "actions_1",
};
let experimentPolicy = parseEvaluationExperimentPolicyV1({
	schemaVersion: 1,
	policyId: policy.policyId,
	revision: policy.revision,
	validUntil: policy.validUntil,
	maximumTasks: 8,
	maximumInputBytes: 65536,
	variants: ["baseline", "candidate"].map((variantId) => ({
		variantId,
		agentId: configuration.agentId,
		configurationRevision: configuration.revision,
		modelOptionId: null,
		reasoningLevel: null,
		toolEnvironment: "synthetic",
	})),
	scorers: [
		{
			...scorer,
			configurationDigest: createHash("sha256")
				.update(JSON.stringify(scorer))
				.digest("hex"),
		},
	],
});
const request = (userId: string) => ({
	authentication: { kind: "browser" as const, userId },
	requestId: randomUUID(),
	traceId: randomUUID(),
});
let data: ReturnType<typeof createEvaluationDataV1>;
let core: ReturnType<typeof createEvaluationExperimentsV1>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("evaluation-experiments");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 2 });
	dataStore = new PostgresEvaluationDataStoreV1({ ...database, directory });
	data = createEvaluationDataV1({
		store: dataStore,
		loadPolicy: async () => policy,
		storage,
	});
	experiments = new PostgresEvaluationExperimentsV1({
		...database,
		directory,
		loadDataPolicy: async () => policy,
		loadExperimentPolicy: async () => experimentPolicy,
		storage,
		taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
	});
	core = createEvaluationExperimentsV1({
		data,
		loadPolicy: async () => experimentPolicy,
		transaction: experiments,
	});
	const sourceReference =
		configuration.source.kind === "standard"
			? configuration.source.templateId
			: configuration.source.imageDigest;
	await sql`insert into platform.agents(id,current_configuration_revision,authorization_revision)values(${configuration.agentId},${configuration.revision},'agent-1')`;
	await sql`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration)values(${configuration.agentId},${configuration.revision},${sourceReference},now(),${sql.json(configuration as unknown as postgres.JSONValue)})`;
	await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence)values('fixture-agent',${configuration.agentId},'admin','Eval fixture','fixture','available','seed','seed',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version)values('agent-default',${configuration.agentId},1,1)`;
	await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext)values('agent-default',${configuration.agentId},1,'eval-default',${sql.json({ schemaVersion: 1, purpose: "agent-default", subjectId: configuration.agentId, keyId: "eval-default", keyVersion: 1 })})`;
	for (const kind of ["user", "application"])
		await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision)values(${configuration.agentId},${kind},'runner','use','use-1')`;
	await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision)values('runner','App','admin','identity-1')`;
}, 120000);
afterAll(async () => {
	await experiments?.close();
	await dataStore?.close();
	await sql?.end();
	await database?.stop();
});
async function dataset() {
	const d = await data.create(request("admin"), randomUUID(), {
		scope: "team",
		name: "Synthetic",
	});
	const v = await data.reserve(request("admin"), randomUUID(), d.datasetId, {
		expectedRevision: d.revision,
		sourceVersionId: null,
	});
	await data.grant(request("admin"), randomUUID(), d.datasetId, {
		expectedRevision: 2,
		principal: { kind: "user", id: "admin" },
		versionIds: [v.versionId],
		operations: ["import"],
		expiresAt: new Date(Date.now() + 50000).toISOString(),
	});
	await data.upload(
		request("admin"),
		randomUUID(),
		d.datasetId,
		v.versionId,
		new TextEncoder().encode(
			JSON.stringify({
				schemaVersion: 1,
				provenance: { approvalId: "synthetic-fixture" },
				samples: [
					{
						id: "one",
						input: "synthetic question",
						context: null,
						taskType: "answer",
						expectedResult: "yes",
					},
				],
				rubric: [{ id: "quality", description: "Exact answer" }],
			}),
		),
	);
	await data.grant(request("admin"), randomUUID(), d.datasetId, {
		expectedRevision: 3,
		principal: { kind: "user", id: "runner" },
		versionIds: [v.versionId],
		operations: ["run"],
		expiresAt: new Date(Date.now() + 50000).toISOString(),
	});
	return {
		datasetId: d.datasetId,
		versionId: v.versionId,
		variantIds: ["baseline", "candidate"],
		scorerRefs: [{ scorerId: "exact", version: "1" }],
	};
}
it("accepts isolated original Tasks and default Key in the same PG transaction without a read grant", async () => {
	const command = await dataset();
	await expect(
		data.read(request("runner"), command.datasetId, command.versionId),
	).rejects.toMatchObject({ code: "denied" });
	const key = randomUUID();
	const experiment = await core.create(request("runner"), key, command);
	const rows =
		await sql`select e.*,a.boundary from platform.evaluation_sample_tasks s join platform.conversation_executions e on e.execution_id=s.execution_id join platform.task_authorization_records a on a.execution_id=e.execution_id where s.experiment_id=${experiment.experimentId}`;
	expect(rows).toHaveLength(2);
	expect(new Set(rows.map((r) => r.conversation_id)).size).toBe(2);
	for (const row of rows) {
		expect(row).toMatchObject({
			channel_id: "eval",
			principal_type: "user",
			execution_source: "eval",
			relay_key_id: "eval-default",
			relay_key_purpose: "agent-default",
			status: "waiting",
		});
		expect(row.boundary.evaluation.experimentId).toBe(experiment.experimentId);
	}
	expect(
		(await core.create(request("runner"), key, command)).experimentId,
	).toBe(experiment.experimentId);
	expect(
		await sql`select id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId}`,
	).toHaveLength(2);
}, 30000);
it("preserves application subject and eval source for the default Agent Key", async () => {
	const command = await dataset();
	await data.grant(request("admin"), randomUUID(), command.datasetId, {
		expectedRevision: 4,
		principal: { kind: "application", id: "runner" },
		versionIds: [command.versionId],
		operations: ["run"],
		expiresAt: new Date(Date.now() + 50000).toISOString(),
	});
	const material = `papi_${"E".repeat(43)}`;
	await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes)values('eval-runner','application','runner',${createHash("sha256").update(material).digest("hex")},${sql.json(["eval:run"])})`;
	const experiment = await core.create(
		{
			authentication: { kind: "credential", material },
			requestId: randomUUID(),
			traceId: randomUUID(),
		},
		randomUUID(),
		command,
	);
	const rows =
		await sql`select e.principal_type,e.actor_id,e.execution_source,e.relay_key_purpose from platform.evaluation_sample_tasks s join platform.conversation_executions e on e.execution_id=s.execution_id where s.experiment_id=${experiment.experimentId}`;
	expect(rows).toHaveLength(2);
	for (const row of rows)
		expect(row).toMatchObject({
			principal_type: "application",
			actor_id: "runner",
			execution_source: "eval",
			relay_key_purpose: "agent-default",
		});
}, 30000);
it("rolls back the entire experiment and first original Task when the second sample binding cannot be committed", async () => {
	const command = await dataset();
	const counts = async () => {
		const [row] =
			await sql`select (select count(*)::int from platform.evaluation_experiments) experiments,(select count(*)::int from platform.conversation_executions) executions,(select count(*)::int from platform.conversations) conversations,(select count(*)::int from platform.outbox_items) outbox`;
		return row;
	};
	const before = await counts();
	await sql.unsafe(
		`create function platform.eval_reject_second() returns trigger language plpgsql as $$ begin if new.variant_id='candidate' then raise exception 'synthetic second sample rejected'; end if; return new; end $$`,
	);
	await sql.unsafe(
		"create trigger eval_reject_second before insert on platform.evaluation_sample_tasks for each row execute function platform.eval_reject_second()",
	);
	try {
		await expect(
			core.create(request("runner"), randomUUID(), command),
		).rejects.toThrow();
		expect(await counts()).toEqual(before);
	} finally {
		await sql.unsafe(
			"drop trigger eval_reject_second on platform.evaluation_sample_tasks",
		);
		await sql.unsafe("drop function platform.eval_reject_second()");
	}
}, 30000);
it("checks a shorter experiment-policy expiry using fresh DB time before returning the batch", async () => {
	const command = await dataset();
	const previous = experimentPolicy;
	const expiring = {
		...previous,
		validUntil: new Date(Date.now() + 2000).toISOString(),
	};
	let reads = 0;
	// The shorter policy is valid at admission; its same identity is independently checkpointed.
	await sql`delete from platform.evaluation_policies where id='experiment'`;
	experimentPolicy = expiring;
	const transaction = new PostgresEvaluationExperimentsV1({
		...database,
		directory,
		loadDataPolicy: async () => policy,
		loadExperimentPolicy: async () => expiring,
		storage,
		taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
	});
	const service = createEvaluationExperimentsV1({
		data,
		loadPolicy: async () => expiring,
		transaction: {
			transaction: (request, command, work) =>
				transaction.transaction(request, command, (tx) =>
					work({
						...tx,
						currentPolicy: async () => {
							if (++reads === 2)
								await new Promise((resolve) => setTimeout(resolve, 2100));
							return tx.currentPolicy();
						},
					}),
				),
		},
	});
	const [before] =
		await sql`select count(*)::int count from platform.evaluation_experiments`;
	try {
		await expect(
			service.create(request("runner"), randomUUID(), command),
		).rejects.toMatchObject({ code: "denied" });
		const [after] =
			await sql`select count(*)::int count from platform.evaluation_experiments`;
		expect(after).toEqual(before);
	} finally {
		experimentPolicy = previous;
		await transaction.close();
	}
}, 30000);
