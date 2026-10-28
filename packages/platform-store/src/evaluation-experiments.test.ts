import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import {
	EvaluationExperimentV1Schema,
	EvaluationReviewV1Schema,
	EvaluationScoreMetadataV1Schema,
	EvaluationScoringContextV1Schema,
} from "@agent-infra/contracts/pilot";
import { createDeploymentModelCatalogAdapterV1 } from "@agent-infra/model-catalog";
import {
	createEvaluationDataV1,
	createEvaluationExperimentsV1,
	createEvaluationHumanScoringV1,
	evaluationRetainedMetadataFieldsV1,
	parseEvaluationExperimentPolicyV1,
	parseEvaluationPolicyV1,
	scoreEvaluationRuleV1,
} from "@agent-infra/platform-core";
import { createRelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import { createRelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createPlatformApp } from "../../../apps/platform-api/src/app.js";
import { assemblePlatformApi } from "../../../apps/platform-api/src/assembly.js";
import { createEvaluationDataWorkerV1 } from "../../../apps/platform-worker/src/evaluation-data-worker.js";
import { createEvaluationScoringWorkerV1 } from "../../../apps/platform-worker/src/evaluation-scoring-worker.js";
import { startMinioFileFixtureV1 } from "../../object-storage/src/minio.test-support.js";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.js";
import { PostgresEvaluationDataStoreV1 } from "./evaluation-data.js";
import { PostgresEvaluationExperimentsV1 } from "./evaluation-experiments.js";
import { PostgresEvaluationScoringV1 } from "./evaluation-scoring.js";
import { migratePlatformDatabase } from "./migrate.js";
import { createPostgresOutboxStore } from "./outbox.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let dataStore: PostgresEvaluationDataStoreV1;
let experiments: PostgresEvaluationExperimentsV1;
let storageFixture: Awaited<ReturnType<typeof startMinioFileFixtureV1>>;
let storage: Awaited<ReturnType<typeof startMinioFileFixtureV1>>["storage"];
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
	datasetScopes: ["team"],
	implementation: { kind: "rule", rule: "exact_match" },
};
const configuration = {
	...agentConfigurationConformanceRecordV1,
	schemaVersion: 1 as const,
	actions: [],
	actionSetRevision: "actions_1",
};
const extraScorers = [
	{ ...scorer, scorerId: "human", implementation: { kind: "human" } },
	{
		...scorer,
		scorerId: "model",
		implementation: {
			kind: "model",
			endpointId: "score-endpoint",
			modelId: "score-model",
			catalogRevision: "score-catalog",
			maxOutputTokens: 256,
			inputCategories: ["output", "rubric"],
		},
	},
].map((value) => ({
	...value,
	configurationDigest: createHash("sha256")
		.update(JSON.stringify(value))
		.digest("hex"),
}));
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
		...extraScorers,
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
	storageFixture = await startMinioFileFixtureV1("file", "eval");
	storage = storageFixture.storage;
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
// Each scenario owns its scoring queue; prior failure/recovery scenarios leave durable
// rows intentionally, but their unrelated work must not enter the next Worker batch.
beforeEach(async () => {
	await sql`delete from platform.outbox_items where operation='evaluation.score.v1'`;
});
afterAll(async () => {
	await experiments?.close();
	await dataStore?.close();
	await sql?.end();
	await database?.stop();
	await storageFixture?.close();
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
	const unused = async (): Promise<never> => {
		throw new Error("unused fixture");
	};
	const assembly = assemblePlatformApi({
		...database,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 100,
			waitingTimeoutMs: 30000,
		},
		identity: {
			...directory,
			resolve: async () => null,
			hydrateUsers: async () => [],
		},
		evaluation: {
			storage,
			loadPolicy: async () => policy,
			loadExperimentPolicy: async () => experimentPolicy,
		},
		admissions: {
			authorizationAdmission: { authorize: unused },
			imageAdmission: { admitImage: unused },
			modelAdmission: { admitModels: unused },
			secretAdmission: { admitSecrets: unused },
			channelAdmission: { admitChannels: unused },
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
	});
	const server = serve({
		fetch: createPlatformApp(assembly.dependencies).fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	if (!server.listening)
		await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture API");
	let experiment: ReturnType<typeof EvaluationExperimentV1Schema.parse>;
	try {
		const key = randomUUID();
		const send = () =>
			fetch(`http://127.0.0.1:${address.port}/api/v2/evaluation/experiments`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${material}`,
					"Content-Type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify(command),
			});
		const response = await send();
		expect(response.status).toBe(201);
		experiment = EvaluationExperimentV1Schema.parse(await response.json());
		const replay = await send();
		expect(replay.status).toBe(201);
		expect(EvaluationExperimentV1Schema.parse(await replay.json())).toEqual(
			experiment,
		);
		const metadata = () =>
			fetch(
				`http://127.0.0.1:${address.port}/api/v2/evaluation/experiments/${experiment.experimentId}`,
				{ headers: { Authorization: `Bearer ${material}` } },
			);
		expect((await metadata()).status).toBe(200);
		await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where principal_type='application' and principal_id='runner' and agent_id=${configuration.agentId} and grant_type='use'`;
		try {
			expect((await metadata()).status).toBe(404);
		} finally {
			await sql`update platform.agent_principal_grants set revoked_at=null where principal_type='application' and principal_id='runner' and agent_id=${configuration.agentId} and grant_type='use'`;
		}
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await assembly.close();
	}

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
			policyCheckpoint: transaction.policyCheckpoint.bind(transaction),
			authorizeAgents: transaction.authorizeAgents.bind(transaction),
			target: transaction.target.bind(transaction),
			samples: transaction.samples.bind(transaction),
			cancel: transaction.cancel.bind(transaction),
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
it("executes rule/human/model scorers and independent review on one terminal business result without resubmitting Tasks", async () => {
	const command = await dataset();
	command.scorerRefs = [
		{ scorerId: "exact", version: "1" },
		{ scorerId: "human", version: "1" },
		{ scorerId: "model", version: "1" },
	];
	const unused = async (): Promise<never> => {
		throw new Error("unused fixture");
	};
	const assembly = assemblePlatformApi({
		...database,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 100,
			waitingTimeoutMs: 30000,
		},
		identity: {
			...directory,
			resolve: async (req) => {
				const id = req.headers.get("Cookie")?.split("=")[1];
				return id
					? {
							schemaVersion: 1,
							userId: id,
							displayName: id,
							accountStatus: "active",
							organizationIds: [],
							roles: ["employee"],
							authorizationRevision: "identity-1",
						}
					: null;
			},
			hydrateUsers: async () => [],
		},
		evaluation: {
			storage,
			loadPolicy: async () => policy,
			loadExperimentPolicy: async () => experimentPolicy,
		},
		admissions: {
			authorizationAdmission: { authorize: unused },
			imageAdmission: { admitImage: unused },
			modelAdmission: { admitModels: unused },
			secretAdmission: { admitSecrets: unused },
			channelAdmission: { admitChannels: unused },
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
	});
	const api = serve({
		fetch: createPlatformApp(assembly.dependencies).fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	if (!api.listening)
		await new Promise<void>((resolve) => api.once("listening", resolve));
	const apiAddress = api.address();
	if (!apiAddress || typeof apiAddress === "string")
		throw new Error("fixture API");
	const http = async (
		path: string,
		user: string,
		body: unknown,
		key = randomUUID(),
	) => {
		const response = await fetch(
			`http://127.0.0.1:${apiAddress.port}/api/v2/evaluation${path}`,
			{
				method: "POST",
				headers: {
					Cookie: `session=${user}`,
					"Content-Type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify(body),
			},
		);
		const result = (await response.json()) as Record<string, unknown>;
		expect(response.status, JSON.stringify(result)).toBeLessThan(300);
		return result;
	};
	const experiment = EvaluationExperimentV1Schema.parse(
		await http("/experiments", "runner", command),
	);
	const baseUrl = `http://127.0.0.1:${apiAddress.port}/api/v2/evaluation`;
	const malformed = [
		await fetch(`${baseUrl}/scores/${randomUUID()}/experiments`, {
			method: "POST",
			headers: {
				Cookie: "session=runner",
				"Content-Type": "application/json",
				"Idempotency-Key": randomUUID(),
			},
			body: JSON.stringify(command),
		}),

		await fetch(
			`${baseUrl}/experiments/${experiment.experimentId}?limit=1&limit=2`,
			{ headers: { Cookie: "session=runner" } },
		),
		await fetch(`${baseUrl}/experiments/${experiment.experimentId}`, {
			headers: { Cookie: "session=runner", "x-principal-id": "admin" },
		}),
		await fetch(
			`${baseUrl}/experiments/${experiment.experimentId}/cancel/extra`,
			{
				method: "POST",
				headers: {
					Cookie: "session=runner",
					"Content-Type": "application/json",
					"Idempotency-Key": randomUUID(),
				},
				body: "{}",
			},
		),
		await fetch(`${baseUrl}/experiments/${experiment.experimentId}/cancel`, {
			method: "POST",
			headers: {
				Cookie: "session=runner",
				"Content-Type": "application/json",
				"Idempotency-Key": randomUUID(),
			},
			body: JSON.stringify({ actorId: "admin" }),
		}),
	];
	expect(malformed.map((r) => r.status)).toEqual([404, 400, 400, 404, 400]);
	const metadata = await fetch(
		`${baseUrl}/experiments/${experiment.experimentId}?limit=1`,
		{ headers: { Cookie: "session=runner" } },
	);
	expect(metadata.status).toBe(200);
	const page = (await metadata.json()) as {
		items: { scoreIds: string[] }[];
		nextCursor: string | null;
	};
	expect(page.items).toHaveLength(1);
	expect(page.items[0]?.scoreIds).toHaveLength(3);
	expect(page.nextCursor).not.toBeNull();
	await data.grant(request("admin"), randomUUID(), command.datasetId, {
		expectedRevision: 4,
		principal: { kind: "user", id: "runner" },
		versionIds: [command.versionId],
		operations: ["score"],
		expiresAt: new Date(Date.now() + 50000).toISOString(),
	});
	await data.grant(request("admin"), randomUUID(), command.datasetId, {
		expectedRevision: 5,
		principal: { kind: "user", id: "reviewer" },
		versionIds: [command.versionId],
		operations: ["review"],
		expiresAt: new Date(Date.now() + 50000).toISOString(),
	});
	await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision)values(${configuration.agentId},'user','reviewer','use','review-1') on conflict do nothing`;
	const tasks =
		await sql`select e.* from platform.evaluation_sample_tasks s join platform.conversation_executions e on e.execution_id=s.execution_id where s.experiment_id=${experiment.experimentId}`;
	for (const task of tasks) {
		await sql`update platform.conversation_executions set status='completed',last_event_sequence=2 where execution_id=${task.execution_id}`;
		await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)values(${randomUUID()},${task.conversation_id},${task.execution_id},2,2,'text.delta',${sql.json({ type: "text.delta", text: "yes" })},'runtime',${randomUUID()},${"a".repeat(64)},'runtime-2',clock_timestamp())`;
	}
	const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
	const encryptor = createRelayKeyEncryptorV1({
		encryptionKeys: {
			schemaVersion: 1,
			activeWrappingKeyVersion: "fixture",
			keys: [
				{
					schemaVersion: 1,
					keyVersion: "fixture",
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					publicKeySpkiDerBase64: publicKey.toString("base64"),
					publicKeyFingerprint: createHash("sha256")
						.update(publicKey)
						.digest("hex"),
					rsaModulusBits: 3072,
					status: "active",
				},
			],
		},
	});
	const ciphertext = encryptor.encrypt({
		purpose: "agent-default",
		subjectId: configuration.agentId,
		keyId: "eval-default",
		keyVersion: 1,
		plaintext: "synthetic-score-key",
	});
	await sql`update platform.relay_key_versions set ciphertext=${sql.json(ciphertext as unknown as postgres.JSONValue)} where key_id='eval-default'`;
	let calls = 0;
	let holdModel = false;
	let rejectedStatus: number | undefined;
	const modelEntered = Promise.withResolvers<void>();
	const server = createServer(async (req, res) => {
		calls++;
		let body = "";
		for await (const chunk of req) body += chunk;
		expect(req.headers.authorization).toBe("Bearer synthetic-score-key");
		expect(JSON.parse(body)).toMatchObject({ tools: [], tool_choice: "none" });
		if (rejectedStatus) {
			res.writeHead(rejectedStatus, { "content-type": "text/plain" });
			res.end("PRIVATE_MODEL_REFUSAL synthetic-score-key");
			return;
		}
		if (holdModel) {
			modelEntered.resolve();
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				id: "response-fixture",
				object: "response",
				model: "score-model",
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						status: "completed",
						content: [
							{
								type: "output_text",
								text: JSON.stringify({
									status: "scored",
									value: 1,
									reason: "Synthetic model reason",
								}),
							},
						],
					},
				],
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("fixture endpoint");
	const origin = `http://127.0.0.1:${address.port}`;
	const options = {
		...database,
		directory,
		loadDataPolicy: async () => policy,
		loadExperimentPolicy: async () => experimentPolicy,
		storage,
		taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
	};
	const plaintexts: Uint8Array[] = [];
	const realDecryptor = createRelayKeyWorkerDecryptorV1({
		keys: [
			{
				keyVersion: "fixture",
				privateKeyPkcs8DerBase64: pair.privateKey
					.export({ format: "der", type: "pkcs8" })
					.toString("base64"),
			},
		],
	});
	const worker = createEvaluationScoringWorkerV1({
		...options,
		batchSize: 100,
		leaseMs: 30000,
		retryDelayMs: 1000,
		catalog: createDeploymentModelCatalogAdapterV1({
			load: async () => ({
				schemaVersion: 1,
				revision: "score-catalog",
				validUntil: Date.now() + 60000,
				endpoints: [
					{
						endpointId: "score-endpoint",
						baseUrl: origin,
						origin,
						protocol: "openai-responses-v1",
						security: { tls: "loopback-http", redirects: "reject" },
						capabilities: {
							streaming: true,
							tools: true,
							reasoningLevels: ["low"],
						},
						allowedModels: ["score-model"],
						available: true,
					},
				],
			}),
		}),
		decryptor: {
			async decrypt(input) {
				const result = await realDecryptor.decrypt(input);
				if (result.outcome === "decrypted") plaintexts.push(result.plaintext);
				return result;
			},
		},
	});
	const scoring = new PostgresEvaluationScoringV1(options);
	const humans = createEvaluationHumanScoringV1(scoring);
	try {
		const [rule] =
			await sql`select id from platform.evaluation_score_intents where scorer_id='exact' and sample_task_id in (select id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId}) limit 1`;
		const outbox = createPostgresOutboxStore(database);
		try {
			const itemId = `evaluation-score:${rule?.id}`;
			const claim = await outbox.claim({
				itemId,
				leaseOwner: "test-rule",
				leaseDurationMs: 30000,
			});
			if (!claim) throw new Error("claim missing");
			const lease = {
				itemId,
				intentId: String(rule?.id),
				leaseOwner: "test-rule",
				deliveryFence: claim.deliveryFence.toString(),
			};
			const prepared = await scoring.prepare(lease);
			if (!("input" in prepared) || !prepared.input || !prepared.intent)
				throw new Error("input missing");
			await scoring.commit(
				lease,
				prepared.intent,
				scoreEvaluationRuleV1({
					scorer: prepared.intent.scorer,
					output: prepared.input.output,
					expected: prepared.input.expected,
				}),
			);
			await outbox.markSucceeded({
				itemId,
				leaseOwner: "test-rule",
				deliveryFence: claim.deliveryFence,
			});
		} finally {
			await outbox.close();
		}
		await sql`update platform.relay_key_versions set ciphertext=ciphertext-'crypto' where key_id='eval-default'`;
		await worker.runOnce();
		expect(calls).toBe(0);
		expect(
			await sql`select distinct status from platform.evaluation_score_intents where scorer_id='model' and sample_task_id in(select id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId})`,
		).toEqual([{ status: "pending" }]);
		await sql`update platform.relay_key_versions set ciphertext=${sql.json(ciphertext as unknown as postgres.JSONValue)} where key_id='eval-default'`;
		await sql`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where operation='evaluation.score.v1' and status='retry_scheduled'`;
		await worker.runOnce();
		const scores =
			await sql`select * from platform.evaluation_score_intents where sample_task_id in (select id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId})`;
		expect(scores).toHaveLength(6);
		for (const score of scores)
			expect(
				score.status,
				JSON.stringify(
					scores.map((s) => ({
						scorer: s.scorer_id,
						status: s.status,
						code: s.data.failureCode,
					})),
				),
			).toBe(score.scorer_id === "human" ? "awaiting_human" : "scored");
		expect(calls).toBe(2);
		await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where agent_id=${configuration.agentId} and principal_type='user' and principal_id='runner' and grant_type='use'`;
		try {
			expect(
				(
					await fetch(
						`${baseUrl}/experiments/${experiment.experimentId}?limit=1`,
						{ headers: { Cookie: "session=runner" } },
					)
				).status,
			).toBe(404);
		} finally {
			await sql`update platform.agent_principal_grants set revoked_at=null where agent_id=${configuration.agentId} and principal_type='user' and principal_id='runner' and grant_type='use'`;
		}
		const human = scores.find((s) => s.scorer_id === "human");
		if (!human) throw new Error("missing score");
		await data.grant(request("admin"), randomUUID(), command.datasetId, {
			expectedRevision: 6,
			principal: { kind: "user", id: "grader" },
			versionIds: [command.versionId],
			operations: ["score"],
			expiresAt: new Date(Date.now() + 50000).toISOString(),
		});
		await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision)values(${configuration.agentId},'user','grader','use','grader-1') on conflict do nothing`;
		const context = await fetch(`${baseUrl}/scores/${human.id}/content`, {
			headers: { Cookie: "session=grader" },
		});
		expect(context.status).toBe(200);
		expect(await context.json()).toMatchObject({
			status: "awaiting_human",
			sample: { id: "one", input: "synthetic question", expectedResult: "yes" },
			rubric: { id: "quality", description: "Exact answer" },
			output: { text: "yes", executionId: human.data.executionId },
			score: null,
		});
		for (const [path, user] of [
			[`/scores/${human.id}/review-context`, "grader"],
			[`/scores/${human.id}/content`, "reviewer"],
			[`/experiments/${experiment.experimentId}`, "grader"],
			[`/experiments/${experiment.experimentId}`, "reviewer"],
			[
				`/datasets/${command.datasetId}/versions/${command.versionId}/content`,
				"grader",
			],
			[
				`/datasets/${command.datasetId}/versions/${command.versionId}/content`,
				"reviewer",
			],
		])
			expect(
				(
					await fetch(`${baseUrl}${path}`, {
						headers: { Cookie: `session=${user}` },
					})
				).status,
			).toBe(404);
		const key = randomUUID();
		const result = {
			status: "scored",
			value: 1,
			reason: "Synthetic human reason",
		};
		const saved = EvaluationScoreMetadataV1Schema.parse(
			await http(
				`/scores/${human.id}/human`,
				"runner",
				{ expectedRevision: Number(human.revision), result },
				key,
			),
		);
		expect(saved.scoreActor).toEqual({ kind: "user", id: "runner" });
		expect(
			(
				await http(
					`/scores/${human.id}/human`,
					"runner",
					{ expectedRevision: Number(human.revision), result },
					key,
				)
			).revision,
		).toBe(saved.revision);
		await expect(
			humans.review(
				request("runner"),
				randomUUID(),
				human.id,
				Number(saved.revision),
				result,
			),
		).rejects.toThrow();
		const reviewContext = await fetch(
			`${baseUrl}/scores/${human.id}/review-context`,
			{ headers: { Cookie: "session=reviewer" } },
		);
		expect(reviewContext.status).toBe(200);
		const reviewerContext = EvaluationScoringContextV1Schema.parse(
			await reviewContext.json(),
		);
		expect(reviewerContext).toMatchObject({
			sample: { id: "one", input: "synthetic question" },
			rubric: { id: "quality" },
			output: { text: "yes" },
			score: result,
		});
		const reviewKey = randomUUID();
		await sql.unsafe(
			`create function platform.eval_review_audit_failure() returns trigger language plpgsql as $$ begin if NEW.action='evaluation.score.reviewed' then raise exception 'synthetic audit unavailable'; end if; return NEW; end $$`,
		);
		await sql.unsafe(
			"create trigger eval_review_audit_failure before insert on platform.audit_events for each row execute function platform.eval_review_audit_failure()",
		);
		try {
			const failure = await fetch(`${baseUrl}/scores/${human.id}/reviews`, {
				method: "POST",
				headers: {
					Cookie: "session=reviewer",
					"Content-Type": "application/json",
					"Idempotency-Key": reviewKey,
				},
				body: JSON.stringify({
					expectedRevision: reviewerContext.revision,
					result,
				}),
			});
			expect(failure.status).toBe(503);
			expect(
				await sql`select count(*)::int as count from platform.evaluation_score_reviews where score_id=${human.id}`,
			).toEqual([{ count: 0 }]);
		} finally {
			await sql.unsafe(
				"drop trigger eval_review_audit_failure on platform.audit_events",
			);
			await sql.unsafe("drop function platform.eval_review_audit_failure()");
		}
		const reviewed = EvaluationReviewV1Schema.parse(
			await http(
				`/scores/${human.id}/reviews`,
				"reviewer",
				{ expectedRevision: reviewerContext.revision, result },
				reviewKey,
			),
		);
		expect(
			await http(
				`/scores/${human.id}/reviews`,
				"reviewer",
				{ expectedRevision: reviewerContext.revision, result },
				reviewKey,
			),
		).toEqual(reviewed);
		const reviewHistory = await fetch(
			`${baseUrl}/scores/${human.id}/reviews?limit=1`,
			{ headers: { Cookie: "session=reviewer" } },
		);
		expect(reviewHistory.status).toBe(200);
		const history = await reviewHistory.json();
		expect(history).toMatchObject({
			items: [{ ...reviewed, result }],
			nextCursor: null,
		});
		expect(
			(
				await fetch(`${baseUrl}/scores/${human.id}/reviews`, {
					headers: { Cookie: "session=runner" },
				})
			).status,
		).toBe(404);
		expect(
			(
				await fetch(
					`${baseUrl}/scores/${human.id}/reviews?cursor=${randomUUID()}`,
					{ headers: { Cookie: "session=reviewer" } },
				)
			).status,
		).toBe(200);
		expect(
			(
				await fetch(`${baseUrl}/scores/${human.id}/reviews?limit=1&limit=2`, {
					headers: { Cookie: "session=reviewer" },
				})
			).status,
		).toBe(400);
		const newest = EvaluationReviewV1Schema.parse(
			await http(
				`/scores/${human.id}/reviews`,
				"reviewer",
				{ expectedRevision: reviewerContext.revision, result },
				randomUUID(),
			),
		);
		const [oldReview] =
			await sql`select data from platform.evaluation_score_reviews where id=${reviewed.reviewId}`;
		const expiredReview = new Date(Date.now() - 1000).toISOString();
		await sql`update platform.evaluation_derived_objects set expires_at=${expiredReview}::timestamptz,data=jsonb_set(data,'{expiresAt}',to_jsonb(${expiredReview}::text)) where id=${oldReview?.data.objectId}`;
		const retained = await fetch(`${baseUrl}/scores/${human.id}/reviews`, {
			headers: { Cookie: "session=reviewer" },
		});
		expect(retained.status).toBe(200);
		const retainedPage = (await retained.json()) as {
			items: { reviewId: string; contentStatus: string; result: unknown }[];
		};
		expect(retainedPage.items).toHaveLength(2);
		expect(
			retainedPage.items.find((item) => item.reviewId === reviewed.reviewId),
		).toMatchObject({ contentStatus: "expired", result: null });
		expect(
			retainedPage.items.find((item) => item.reviewId === newest.reviewId),
		).toMatchObject({ contentStatus: "available", result });
		await sql`update platform.evaluation_derived_objects set status='deleting',data=jsonb_set(data,'{status}','"deleting"'::jsonb) where id=${oldReview?.data.objectId}`;
		const deletingPage = (await (
			await fetch(`${baseUrl}/scores/${human.id}/reviews`, {
				headers: { Cookie: "session=reviewer" },
			})
		).json()) as {
			items: { reviewId: string; contentStatus: string; result: unknown }[];
		};
		expect(
			deletingPage.items.find((item) => item.reviewId === reviewed.reviewId),
		).toMatchObject({ contentStatus: "deleting", result: null });
		await sql`update platform.evaluation_derived_objects set status='available',data=jsonb_set(data,'{status}','"available"'::jsonb) where id=${oldReview?.data.objectId}`;
		await sql`update platform.evaluation_score_reviews set data=jsonb_set(data,'{metadataExpiresAt}',to_jsonb(${expiredReview}::text)) where id=${reviewed.reviewId}`;
		const filteredPage = (await (
			await fetch(`${baseUrl}/scores/${human.id}/reviews`, {
				headers: { Cookie: "session=reviewer" },
			})
		).json()) as { items: { reviewId: string }[] };
		expect(filteredPage.items.map((item) => item.reviewId)).toEqual([
			newest.reviewId,
		]);
		const [newReview] =
			await sql`select data from platform.evaluation_score_reviews where id=${newest.reviewId}`;
		const [newObject] =
			await sql`select data from platform.evaluation_derived_objects where id=${newReview?.data.objectId}`;
		const download = storage.download;
		storage.download = async (input) => {
			if (input.objectRef === newObject?.data.objectRef)
				throw new Error("synthetic storage outage");
			return download(input);
		};
		try {
			expect(
				(
					await fetch(`${baseUrl}/scores/${human.id}/reviews`, {
						headers: { Cookie: "session=reviewer" },
					})
				).status,
			).toBeGreaterThanOrEqual(500);
		} finally {
			storage.download = download;
		}
		const [audit] =
			await sql`select actor_id from platform.audit_events where action='evaluation.score.reviewed' and target_id=${human.id}`;
		expect(audit?.actor_id).toBe("reviewer");
		await worker.runOnce();
		expect(calls).toBe(2);
		for (const status of [401, 403]) {
			rejectedStatus = status;
			const stoppingCommand = {
				...(await dataset()),
				scorerRefs: [{ scorerId: "model", version: "1" }],
			};
			await data.grant(
				request("admin"),
				randomUUID(),
				stoppingCommand.datasetId,
				{
					expectedRevision: 4,
					principal: { kind: "user", id: "runner" },
					versionIds: [stoppingCommand.versionId],
					operations: ["score"],
					expiresAt: new Date(Date.now() + 50000).toISOString(),
				},
			);
			const stoppingExperiment = await core.create(
				request("runner"),
				randomUUID(),
				stoppingCommand,
			);
			const stoppingTasks = await experiments.samples(
				stoppingExperiment.experimentId,
				10,
			);
			for (const task of stoppingTasks) {
				await sql`update platform.conversation_executions set status='completed',last_event_sequence=2 where execution_id=${task.executionId}`;
				await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)values(${randomUUID()},${task.conversationId},${task.executionId},2,2,'text.delta',${sql.json({ type: "text.delta", text: "yes" })},'runtime',${randomUUID()},${"d".repeat(64)},'2',clock_timestamp())`;
			}
			await worker.runOnce();
			const beforeCalls = calls;
			await worker.runOnce();
			expect(calls).toBe(beforeCalls);
			const failures =
				await sql`select status,data->>'failureCode' as code from platform.evaluation_score_intents where sample_task_id in(select id from platform.evaluation_sample_tasks where experiment_id=${stoppingExperiment.experimentId})`;
			expect(failures).toEqual([
				{ status: "failed", code: "SCORER_AUTHORIZATION_DENIED" },
				{ status: "failed", code: "SCORER_AUTHORIZATION_DENIED" },
			]);
			expect(
				await sql`select count(*)::int as count from platform.evaluation_sample_tasks where experiment_id=${stoppingExperiment.experimentId}`,
			).toEqual([{ count: 2 }]);
			expect(JSON.stringify(failures)).not.toContain("PRIVATE_MODEL_REFUSAL");
		}
		rejectedStatus = undefined;
		const stoppingCommand = {
			...(await dataset()),
			scorerRefs: [{ scorerId: "model", version: "1" }],
		};
		await data.grant(
			request("admin"),
			randomUUID(),
			stoppingCommand.datasetId,
			{
				expectedRevision: 4,
				principal: { kind: "user", id: "runner" },
				versionIds: [stoppingCommand.versionId],
				operations: ["score"],
				expiresAt: new Date(Date.now() + 50000).toISOString(),
			},
		);
		const stoppingExperiment = await core.create(
			request("runner"),
			randomUUID(),
			stoppingCommand,
		);
		const stoppingTasks = await experiments.samples(
			stoppingExperiment.experimentId,
			10,
		);
		for (const task of stoppingTasks) {
			await sql`update platform.conversation_executions set status='completed',last_event_sequence=2 where execution_id=${task.executionId}`;
			await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)values(${randomUUID()},${task.conversationId},${task.executionId},2,2,'text.delta',${sql.json({ type: "text.delta", text: "yes" })},'runtime',${randomUUID()},${"d".repeat(64)},'2',clock_timestamp())`;
		}
		holdModel = true;
		const stoppingRun = worker.runOnce();
		expect(worker.runOnce()).toBe(stoppingRun);
		await Promise.race([
			modelEntered.promise,
			stoppingRun.then(() => {
				throw new Error("No model request arrived");
			}),
		]);
		const close = worker.close();
		expect(worker.close()).toBe(close);
		await close;
		await stoppingRun;
		expect(calls).toBe(7);
		expect(plaintexts.length).toBe(7);
		expect(
			plaintexts.every((bytes) => bytes.every((value) => value === 0)),
		).toBe(true);
		expect(
			await sql`select status,(data->>'attempts')::int as attempts from platform.evaluation_score_intents where sample_task_id in(select id from platform.evaluation_sample_tasks where experiment_id=${stoppingExperiment.experimentId}) order by status`,
		).toEqual([
			{ status: "unknown", attempts: 1 },
			{ status: "waiting_output", attempts: 0 },
		]);
		expect(
			await sql`select delivery_fence::int as fence from platform.outbox_items where operation='evaluation.score.v1' and scope_id in(select i.id::text from platform.evaluation_score_intents i join platform.evaluation_sample_tasks s on s.id=i.sample_task_id where s.experiment_id=${stoppingExperiment.experimentId}) order by delivery_fence`,
		).toEqual([{ fence: 0 }, { fence: 1 }]);
		const material = `papi_${"R".repeat(43)}`;
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes)values('eval-read-token','user','runner',${createHash("sha256").update(material).digest("hex")},${sql.json(["eval:run"])})`;
		const task = tasks[0];
		if (!task) throw new Error("missing task");
		const taskPath = `http://127.0.0.1:${apiAddress.port}/api/v1/conversations/${task.conversation_id}/tasks/${task.execution_id}`;
		const headers = { Authorization: `Bearer ${material}` };
		const taskRead = await fetch(taskPath, { headers });
		expect(taskRead.status, await taskRead.text()).toBe(200);
		const streamAbort = new AbortController();
		const stream = await fetch(`${taskPath}/events`, {
			headers,
			signal: streamAbort.signal,
		});
		expect(stream.status).toBe(200);
		const reader = stream.body?.getReader();
		if (!reader) throw new Error("missing SSE reader");
		let streamText = "";
		while (!streamText.includes("yes")) {
			const next = await reader.read();
			if (next.done) break;
			streamText += new TextDecoder().decode(next.value);
		}
		expect(streamText).toContain("yes");
		const [runGrant] =
			await sql`select data from platform.evaluation_grants where dataset_id=${command.datasetId} and data->'principal'->>'id'='runner' and data->'operations' @> '["run"]'::jsonb`;
		await data.revoke(
			request("admin"),
			randomUUID(),
			command.datasetId,
			runGrant?.data.grantId,
			runGrant?.data.revision,
		);
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			streamText += new TextDecoder().decode(next.value);
		}
		reader.releaseLock();
		streamAbort.abort();
		expect(streamText).toContain("authorization.revoked");
		expect((await fetch(taskPath, { headers })).status).toBe(404);
		expect((await fetch(`${taskPath}/events`, { headers })).status).toBe(404);

		expect(
			await sql`select id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId}`,
		).toHaveLength(2);
		const [reviewGrant] =
			await sql`select data from platform.evaluation_grants where dataset_id=${command.datasetId} and data->'principal'->>'id'='reviewer'`;
		await data.revoke(
			request("admin"),
			randomUUID(),
			command.datasetId,
			reviewGrant?.data.grantId,
			reviewGrant?.data.revision,
		);
		expect(
			(
				await fetch(`${baseUrl}/scores/${human.id}/reviews`, {
					headers: { Cookie: "session=reviewer" },
				})
			).status,
		).toBe(404);
		const expired = new Date(Date.now() - 1000).toISOString();
		await sql`update platform.evaluation_versions set expires_at=${expired}::timestamptz,metadata_expires_at=${expired}::timestamptz,data=jsonb_set(jsonb_set(data,'{expiresAt}',to_jsonb(${expired}::text)),'{metadataExpiresAt}',to_jsonb(${expired}::text)) where id=${command.versionId}`;
		await sql`update platform.evaluation_datasets set data=jsonb_set(data,'{metadataExpiresAt}',to_jsonb(${expired}::text)) where id=${command.datasetId}`;
		await sql`update platform.evaluation_experiments set metadata_expires_at=${expired}::timestamptz,data=jsonb_set(data,'{metadataExpiresAt}',to_jsonb(${expired}::text)) where id=${experiment.experimentId}`;
		await sql`update platform.evaluation_score_reviews set data=jsonb_set(data,'{metadataExpiresAt}',to_jsonb(${expired}::text)) where score_id in (select id from platform.evaluation_score_intents where sample_task_id in(select id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId}))`;
		await sql`update platform.evaluation_score_intents set data=jsonb_set(data,'{metadataExpiresAt}',to_jsonb(${expired}::text)) where sample_task_id in(select id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId})`;
		await sql`update platform.evaluation_derived_objects set expires_at=${expired}::timestamptz,metadata_expires_at=${expired}::timestamptz,data=jsonb_set(jsonb_set(jsonb_set(data,'{expiresAt}',to_jsonb(${expired}::text)),'{metadataExpiresAt}',to_jsonb(${expired}::text)),'{transferUntil}',to_jsonb(${expired}::text)) where version_id=${command.versionId}`;
		const [blocked] =
			await sql`select data from platform.evaluation_derived_objects where version_id=${command.versionId} limit 1`;
		const remove = storage.remove;
		let block = true;
		storage.remove = async (ref, version) => {
			if (block && ref === blocked?.data.objectRef)
				throw new Error("synthetic single object outage");
			await remove(ref, version);
		};
		const cleanup = createEvaluationDataWorkerV1({
			...database,
			storage,
			batchSize: 100,
			timeoutMs: 5000,
		});
		try {
			await cleanup.runOnce();
			await cleanup.runOnce();
			expect(
				await sql`select id from platform.evaluation_versions where id=${command.versionId}`,
			).toHaveLength(1);
			expect(
				await sql`select id from platform.evaluation_derived_objects where id=${blocked?.data.id} and status='deleting'`,
			).toHaveLength(1);
			block = false;
			await sql`update platform.outbox_items set available_at=clock_timestamp() where operation='evaluation.derived.delete.v1' and status='retry_scheduled'`;
			await cleanup.runOnce();
			await cleanup.runOnce();
			expect(
				await sql`select id from platform.evaluation_versions where id=${command.versionId}`,
			).toHaveLength(0);
			expect(
				await sql`select id from platform.evaluation_derived_objects where version_id=${command.versionId}`,
			).toHaveLength(0);
			expect(
				await sql`select execution_id from platform.conversation_executions where execution_id in (${tasks[0]?.execution_id},${tasks[1]?.execution_id})`,
			).toHaveLength(2);
		} finally {
			storage.remove = remove;
			await cleanup.close();
		}
	} finally {
		await worker.close();
		await scoring.close();
		if ("closeAllConnections" in api) api.closeAllConnections();
		await new Promise<void>((resolve) => api.close(() => resolve()));
		await assembly.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}, 60000);
it("requires current experiment policy and run grant before underlying content/replay queries and allows original-subject cancellation after revoke", async () => {
	const command = await dataset();
	const experiment = await core.create(
		request("runner"),
		randomUUID(),
		command,
	);
	const tasks = await experiments.samples(experiment.experimentId, 10);
	const task = tasks[0];
	if (!task) throw new Error("missing task");
	const { PostgresEvaluationTaskAuthorityV1 } = await import(
		"./evaluation-task-authority.js"
	);
	const { PostgresConversationQueryV1 } = await import(
		"./conversation-query.js"
	);
	const authority = new PostgresEvaluationTaskAuthorityV1({
		...database,
		directory,
		loadPolicy: {
			data: async () => policy,
			experiment: async () => experimentPolicy,
		},
	});
	const query = new PostgresConversationQueryV1({
		...database,
		evaluationCurrent: authority.conversationCurrent.bind(authority),
	});
	const scope = {
		actorId: "runner",
		channelId: "eval",
		principal: { kind: "user" as const, id: "runner" },
	};
	try {
		expect(
			await query.getExecution(scope, task.conversationId, task.executionId),
		).toBeDefined();
		const original = experimentPolicy;
		expect(
			(await core.get(request("runner"), experiment.experimentId)).experiment
				.experimentId,
		).toBe(experiment.experimentId);
		experimentPolicy = { ...original, variants: [] };
		await expect(
			core.get(request("runner"), experiment.experimentId),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(
			await query.getExecution(scope, task.conversationId, task.executionId),
		).toBeUndefined();
		experimentPolicy = original;
		const [grant] =
			await sql`select data from platform.evaluation_grants where dataset_id=${command.datasetId} and data->'principal'->>'id'='runner'`;
		await data.revoke(
			request("admin"),
			randomUUID(),
			command.datasetId,
			grant?.data.grantId,
			grant?.data.revision,
		);
		expect(
			await query.getExecution(scope, task.conversationId, task.executionId),
		).toBeUndefined();
		expect(
			await query.replayExecution(
				scope,
				task.conversationId,
				task.executionId,
				undefined,
			),
		).toBeUndefined();
		const beforeCancel =
			await sql`select execution_id,status from platform.conversation_executions where execution_id in(select execution_id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId}) order by execution_id`;
		await sql.unsafe(
			`create function platform.eval_cancel_audit_failure() returns trigger language plpgsql as $$ begin if NEW.action='evaluation.experiment.cancel' then raise exception 'synthetic audit rejection'; end if; return NEW; end $$`,
		);
		await sql.unsafe(
			"create trigger eval_cancel_audit_failure before insert on platform.audit_events for each row execute function platform.eval_cancel_audit_failure()",
		);
		try {
			await expect(
				core.cancel(request("runner"), experiment.experimentId, randomUUID()),
			).rejects.toThrow();
			expect(
				await sql`select status from platform.evaluation_experiments where id=${experiment.experimentId}`,
			).toEqual([{ status: "active" }]);
			expect(
				await sql`select execution_id,status from platform.conversation_executions where execution_id in(select execution_id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId}) order by execution_id`,
			).toEqual(beforeCancel);
		} finally {
			await sql.unsafe(
				"drop trigger eval_cancel_audit_failure on platform.audit_events",
			);
			await sql.unsafe("drop function platform.eval_cancel_audit_failure()");
		}
		const cancelled = await core.cancel(
			request("runner"),
			experiment.experimentId,
			randomUUID(),
		);
		expect(cancelled.status).toBe("cancelled");
		await core.cancel(request("runner"), experiment.experimentId, randomUUID());
		expect(
			await sql`select actor_id,target_type,details from platform.audit_events where target_id=${experiment.experimentId} and action='evaluation.experiment.cancel'`,
		).toEqual([
			{
				actor_id: "runner",
				target_type: "evaluation_experiment",
				details: { purpose: "eval", returnedMaterial: false },
			},
		]);

		await expect(
			core.cancel(request("reviewer"), experiment.experimentId, randomUUID()),
		).rejects.toMatchObject({ code: "denied" });
	} finally {
		await query.close();
		await authority.close();
	}
}, 30000);
it("requires caller Eval scope and current Agent use to cancel without restoring revoked data run", async () => {
	const command = await dataset();
	const experiment = await core.create(
		request("runner"),
		randomUUID(),
		command,
	);
	const material = `papi_${"C".repeat(43)}`;
	await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes)values('eval-cancel-token','user','runner',${createHash("sha256").update(material).digest("hex")},${sql.json(["agent:read"])})`;
	const credentials = {
		authentication: { kind: "credential" as const, material },
		requestId: randomUUID(),
		traceId: randomUUID(),
	};
	await expect(
		core.get(credentials, experiment.experimentId),
	).rejects.toMatchObject({ code: "denied" });
	await expect(
		core.cancel(credentials, experiment.experimentId, randomUUID()),
	).rejects.toMatchObject({ code: "denied" });
	await sql`update platform.platform_api_credentials set scopes=${sql.json(["eval:run"])} where id='eval-cancel-token'`;
	await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where agent_id=${configuration.agentId} and principal_type='user' and principal_id='runner' and grant_type='use'`;
	try {
		await expect(
			core.cancel(credentials, experiment.experimentId, randomUUID()),
		).rejects.toMatchObject({ code: "denied" });
	} finally {
		await sql`update platform.agent_principal_grants set revoked_at=null where agent_id=${configuration.agentId} and principal_type='user' and principal_id='runner' and grant_type='use'`;
	}
	const [grant] =
		await sql`select data from platform.evaluation_grants where dataset_id=${command.datasetId} and data->'principal'->>'id'='runner' and data->'operations' ? 'run'`;
	await data.revoke(
		request("admin"),
		randomUUID(),
		command.datasetId,
		grant?.data.grantId,
		grant?.data.revision,
	);
	expect(
		(await core.cancel(credentials, experiment.experimentId, randomUUID()))
			.status,
	).toBe("cancelled");
	await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id='eval-cancel-token'`;
	await expect(
		core.cancel(credentials, experiment.experimentId, randomUUID()),
	).rejects.toMatchObject({ code: "denied" });
}, 30000);
it("renews an expired pending-transfer fence on the same derived intent without extending content retention or creating another S3 version", async () => {
	const command = await dataset();
	await data.grant(request("admin"), randomUUID(), command.datasetId, {
		expectedRevision: 4,
		principal: { kind: "user", id: "runner" },
		versionIds: [command.versionId],
		operations: ["score"],
		expiresAt: new Date(Date.now() + 50000).toISOString(),
	});
	const { PostgresEvaluationDerivedContentV1 } = await import(
		"./evaluation-derived-content.js"
	);
	const { createEvaluationDerivedContentV1 } = await import(
		"@agent-infra/platform-core"
	);
	const store = new PostgresEvaluationDerivedContentV1({
		...database,
		directory,
		loadPolicy: async () => policy,
		storage,
	});
	const upload = storage.upload;
	let failed = false;
	const service = createEvaluationDerivedContentV1({
		store,
		storage: {
			...storage,
			upload: async (input) => {
				if (!failed) {
					failed = true;
					throw new Error("synthetic no object written");
				}
				return upload(input);
			},
		},
	});
	const key = randomUUID();
	const body = { status: "scored", value: 1, reason: "retry fixture" };
	try {
		await expect(
			service.write(
				request("runner"),
				key,
				command.datasetId,
				command.versionId,
				"score",
				body,
			),
		).rejects.toThrow();
		const [before] =
			await sql`select data from platform.evaluation_derived_objects where dataset_id=${command.datasetId}`;
		const old = before?.data;
		if (!old) throw new Error("intent missing");
		await sql`update platform.evaluation_derived_objects set data=jsonb_set(data,'{transferUntil}',to_jsonb(${new Date(Date.now() - 10000).toISOString()}::text)) where id=${old.id}`;
		const result = await service.write(
			request("runner"),
			key,
			command.datasetId,
			command.versionId,
			"score",
			body,
		);
		expect(result.id).toBe(old.id);
		expect(result.objectRef).toBe(old.objectRef);
		expect(result.expiresAt).toBe(old.expiresAt);
		expect(result.metadataExpiresAt).toBe(old.metadataExpiresAt);
		expect(Date.parse(result.transferUntil)).toBeGreaterThan(Date.now());
		expect(result.status).toBe("available");
		expect(
			(await storage.scan(null, 100, result.objectRef)).objects,
		).toHaveLength(1);
	} finally {
		await store.close();
	}
}, 30000);

it.each(["user", "application"] as const)(
	"dispatches an Eval %s sample through the existing Task worker authorization and persists controlled Runtime output",
	async (principalKind) => {
		const { workloadDesiredFixture, workloadTestPolicy } = await import(
			"../../../apps/platform-worker/src/kubernetes.fixture.js"
		);
		const { workloadResourceConfigurationHashV1 } = await import(
			"../../../apps/platform-worker/src/workload-runtime.js"
		);
		const { createConversationRuntimeV2 } = await import(
			"../../../apps/platform-worker/src/conversation-runtime.js"
		);
		const { createConversationDispatchUseCaseV1 } = await import(
			"../../platform-core/src/conversation-dispatch.js"
		);
		const { createConversationEventUseCaseV1 } = await import(
			"../../platform-core/src/conversation-events.js"
		);
		const { FakeConversationRuntimeHostV1 } = await import(
			"../../platform-core/src/fake-conversation-runtime-host.js"
		);
		const { PostgresConversationDispatchStoreV1 } = await import(
			"./conversation-dispatch.js"
		);
		const { PostgresConversationEventTransactionV1 } = await import(
			"./conversation-events.js"
		);
		const { PostgresTaskAuthorizationStoreV1 } = await import(
			"./task-authorization.js"
		);
		const { PostgresEvaluationTaskAuthorityV1 } = await import(
			"./evaluation-task-authority.js"
		);
		const { readCurrentTaskApiUseGrantV1, readCurrentTaskApplicationV1 } =
			await import("./application-task-authorization.js");
		const { markSessionSandboxReadyFixture } = await import(
			"./session-sandbox.fixture.js"
		);
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at)values(${configuration.agentId},'admin',clock_timestamp()) on conflict do nothing`;
		const desired = workloadDesiredFixture(
			configuration.revision,
			configuration.agentId,
			"internal-only",
		);
		const deployment = {
			...desired,
			imageDigest: configuration.source.imageDigest,
			registryAdmission: {
				...desired.registryAdmission,
				immutableDigest: configuration.source.imageDigest,
				policyEvidence: {
					...desired.registryAdmission.policyEvidence,
					imageDigest: configuration.source.imageDigest,
				},
			},
		};
		const version = {
			configuration,
			deployment,
			executionCapacity: {
				schemaVersion: 1,
				imageDigest: deployment.imageDigest,
				resourceProfileRef: deployment.resourceProfileRef,
				resourceConfigurationHash:
					workloadResourceConfigurationHashV1(workloadTestPolicy),
				maximumConcurrentExecutions: 8,
				conformanceEvidenceHash: "c".repeat(64),
			},
		};
		const state = {
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
			identity: { uid: "eval-fixture-workload", generation: 1 },
			rollback: false,
			failureCode: null,
			attempts: 0,
			capabilities: { attachments: true, resultFiles: true },
		};
		await sql`insert into platform.workload_reconciliations(agent_id,revision,state,next_attempt_at)values(${configuration.agentId},1,${sql.json(state as unknown as postgres.JSONValue)},now()) on conflict(agent_id)do update set state=excluded.state`;
		const command = await dataset();
		let experimentRequest: Parameters<typeof core.create>[0] =
			request("runner");
		if (principalKind === "application") {
			await data.grant(request("admin"), randomUUID(), command.datasetId, {
				expectedRevision: 4,
				principal: { kind: "application", id: "runner" },
				versionIds: [command.versionId],
				operations: ["run", "score"],
				expiresAt: new Date(Date.now() + 50000).toISOString(),
			});
			const material = `papi_${"W".repeat(43)}`;
			await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes)values('app-worker-token','application','runner',${createHash("sha256").update(material).digest("hex")},${sql.json(["eval:run", "eval:score"])})`;
			experimentRequest = {
				...request("runner"),
				authentication: { kind: "credential", material },
			};
		}
		const experiment = await core.create(
			experimentRequest,
			randomUUID(),
			command,
		);
		await data.grant(request("admin"), randomUUID(), command.datasetId, {
			expectedRevision: principalKind === "application" ? 5 : 4,
			principal: { kind: "user", id: "runner" },
			versionIds: [command.versionId],
			operations: ["score"],
			expiresAt: new Date(Date.now() + 50000).toISOString(),
		});
		const [task] = await experiments.samples(experiment.experimentId, 10);
		if (!task) throw new Error("missing task");
		await markSessionSandboxReadyFixture(sql, task.conversationId);
		const evaluationPolicy = {
			data: async () => policy,
			experiment: async () => experimentPolicy,
		};
		const dispatchStore = new PostgresConversationDispatchStoreV1({
			...database,
			userDirectory: directory,
			evaluationPolicy,
		});
		const authStore = new PostgresTaskAuthorizationStoreV1(database);
		const authority = new PostgresEvaluationTaskAuthorityV1({
			...database,
			directory,
			loadPolicy: evaluationPolicy,
		});
		const eventTx = new PostgresConversationEventTransactionV1(database);
		const signer = generateKeyPairSync("ed25519");
		const runtime = createConversationRuntimeV2({
			workerId: "eval-fixture-worker",
			signing: {
				issuer: "fixture",
				workerId: "eval-fixture-worker",
				keyId: "fixture",
				privateKey: signer.privateKey,
			},
			directory,
			taskAuthorizationStore: authStore,
			dispatchStore,
			channelAuthorizationCurrent: (r) => authority.current(r.boundary),
			resolveCurrentApplication: (applicationId, agentId) =>
				sql.begin((tx) =>
					readCurrentTaskApplicationV1(tx, { applicationId, agentId }),
				),
			resolveCurrentApiUseGrant: (principal, agentId) =>
				sql.begin((tx) =>
					readCurrentTaskApiUseGrantV1(tx, { principal, agentId }),
				),
			resolveRuntimeHost: async () => {
				throw new Error(
					"Controlled transport does not resolve a deployed Runtime",
				);
			},
		});
		const fileJourney = await evaluationFileJourney({
			principalKind,
			task,
			command,
			signer,
			authority,
		});

		const host = new FakeConversationRuntimeHostV1();
		const began = new Date().toISOString();
		const runtimeEvents: import("../../platform-core/src/conversation-dispatch.js").ConversationRuntimeEvent[] =
			[
				...(["intent", "started", "completed"] as const).map(
					(phase, index) => ({
						schemaVersion: 2 as const,
						type: "operation" as const,
						executionId: task.executionId,
						adapterEventKey: `model-${phase}`,
						cursor: `model-${index}`,
						occurredAt: began,
						payload: {
							kind: "model" as const,
							phase,
							operationRef: "model-op",
							attemptRef: "model-attempt",
							...(phase !== "intent" ? { startedAt: began } : {}),
							...(phase === "completed"
								? {
										finishedAt: began,
										durationMs: 0,
										usage: { inputTokens: 2, outputTokens: 1 },
									}
								: {}),
							model: {
								configVersion: "7",
								modelOptionId: "model_primary",
								modelId: "actual-fixture-model",
								reasoningLevel: "low",
							},
						},
					}),
				),
				...(["intent", "started", "completed"] as const).map(
					(phase, index) => ({
						schemaVersion: 2 as const,
						type: "operation" as const,
						executionId: task.executionId,
						adapterEventKey: `tool-${phase}`,
						cursor: `tool-${index}`,
						occurredAt: began,
						payload: {
							kind: "tool" as const,
							phase,
							operationRef: "tool-op",
							attemptRef: "tool-attempt",
							toolId: "fixture.echo",
							...(phase !== "intent" ? { startedAt: began } : {}),
							...(phase === "completed"
								? { finishedAt: began, durationMs: 0 }
								: {}),
						},
					}),
				),
				{
					schemaVersion: 1,
					type: "text",
					executionId: task.executionId,
					adapterEventKey: "eval-output",
					cursor: "1",
					occurredAt: new Date().toISOString(),
					payload: { delta: "yes" },
				},
				{
					schemaVersion: 1,
					type: "completed",
					executionId: task.executionId,
					adapterEventKey: "eval-completed",
					cursor: "2",
					occurredAt: new Date().toISOString(),
					payload: { status: "completed" },
				},
			];

		const dispatch = createConversationDispatchUseCaseV1({
			store: dispatchStore,
			authorization: runtime.authorization,
			runtimeHost: {
				dispatch: async (request) => {
					await fileJourney.produceFile(request);
					return host.dispatch(request);
				},
				recoverStatus: host.recoverStatus.bind(host),
				async *events() {
					yield* runtimeEvents;
				},
			},
			events: createConversationEventUseCaseV1({ transaction: eventTx }),
		});
		try {
			const [outbox] =
				await sql`select id from platform.outbox_items where scope_id=${task.conversationId} and operation='conversation.turn.submit.v1'`;
			if (!outbox) throw new Error("missing original Task outbox");
			await sql`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${outbox.id}`;
			const result = await dispatch.dispatch({
				schemaVersion: 1,
				itemId: outbox.id,
				workerId: "eval-fixture-worker",
			});
			expect(result).toMatchObject({ outcome: "accepted" });
			const page = await core.get(experimentRequest, experiment.experimentId);
			const observed = page.items.find(
				(item) => item.executionId === task.executionId,
			)?.actual;
			expect(observed).toMatchObject({
				status: "completed",
				runtimeObserved: true,
				preparedRuntime: {
					configurationRevision: configuration.revision,
					imageDigest: configuration.source.imageDigest,
				},
				facts: {
					actualModelObserved: true,
					models: expect.arrayContaining([
						expect.objectContaining({
							operationRef: "model-op",
							attemptRef: "model-attempt",
							phase: "completed",
							model: expect.objectContaining({
								modelId: "actual-fixture-model",
							}),
							usage: { inputTokens: 2, outputTokens: 1 },
						}),
					]),
					tools: expect.arrayContaining([
						expect.objectContaining({
							toolId: "fixture.echo",
							phase: "completed",
						}),
					]),
				},
				factsTruncated: false,
			});
			expect(host.sideEffectCount()).toBe(1);
			expect(fileJourney.wasProduced()).toBe(true);
			await fileJourney.assertTerminal();
			expect(
				await sql`select delivery_fence::int as fence,status from platform.outbox_items where id=${outbox.id}`,
			).toEqual([{ fence: 1, status: "succeeded" }]);
			expect(
				await sql`select status from platform.conversation_executions where execution_id=${task.executionId}`,
			).toEqual([{ status: "completed" }]);
			expect(
				await sql`select event_payload->>'text' as text from platform.conversation_events where execution_id=${task.executionId} and event_type='text.delta'`,
			).toEqual([{ text: "yes" }]);
			const scores = new PostgresEvaluationScoringV1({
				...database,
				directory,
				loadDataPolicy: async () => policy,
				loadExperimentPolicy: async () => experimentPolicy,
				storage,
				taskPolicy: {
					maximumWaitingTasksPerAgent: 100,
					waitingTimeoutMs: 30000,
				},
				model: async () => {
					throw new Error("Rule never calls model");
				},
			});
			const outboxes = createPostgresOutboxStore(database);
			try {
				const [score] =
					await sql`select id from platform.evaluation_score_intents where sample_task_id=${task.sampleTaskId}`;
				if (!score) throw new Error("missing score");
				const itemId = `evaluation-score:${score.id}`;
				await sql`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${itemId}`;
				const claim = await outboxes.claim({
					itemId,
					leaseOwner: "controlled-score",
					leaseDurationMs: 30000,
				});
				if (!claim) throw new Error("missing scorer claim");
				const { createEvaluationScoreWorkV1 } = await import(
					"@agent-infra/platform-core"
				);
				expect(
					await createEvaluationScoreWorkV1(scores).execute({
						intentId: score.id,
						itemId,
						leaseOwner: "controlled-score",
						deliveryFence: claim.deliveryFence.toString(),
					}),
				).toEqual({ outcome: "completed" });
				expect(
					await sql`select status from platform.evaluation_score_intents where id=${score.id}`,
				).toEqual([{ status: "scored" }]);
			} finally {
				await scores.close();
				await outboxes.close();
			}
		} finally {
			await fileJourney.close();
			await eventTx.close();
			await authStore.close();
			await dispatchStore.close();
			await authority.close();
		}
	},
	30000,
);

it.each([
	"post-send-unknown",
	"checkpoint-lost",
	"commit-response-lost",
	"commit-persistent-failure",
	"definite-not-sent",
] as const)(
	"recovers the original model intent without duplicate business execution: %s",
	async (mode) => {
		const { scoreEvaluationModelV1 } = await import(
			"@agent-infra/model-catalog"
		);
		const { createEvaluationScoreWorkV1, EvaluationModelNotSentErrorV1 } =
			await import("@agent-infra/platform-core");
		const command = {
			...(await dataset()),
			scorerRefs: [{ scorerId: "model", version: "1" }],
		};
		const experiment = await core.create(
			request("runner"),
			randomUUID(),
			command,
		);
		await data.grant(request("admin"), randomUUID(), command.datasetId, {
			expectedRevision: 4,
			principal: { kind: "user", id: "runner" },
			versionIds: [command.versionId],
			operations: ["score"],
			expiresAt: new Date(Date.now() + 50000).toISOString(),
		});
		const [task] = await experiments.samples(experiment.experimentId, 10);
		if (!task) throw new Error("missing sample");
		await sql`update platform.conversation_executions set status='completed',last_event_sequence=2 where execution_id=${task.executionId}`;
		await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)values(${randomUUID()},${task.conversationId},${task.executionId},2,2,'text.delta',${sql.json({ type: "text.delta", text: "yes" })},'runtime',${randomUUID()},${"b".repeat(64)},'2',clock_timestamp())`;
		let lateMetadata: (() => Promise<void>) | undefined;
		if (mode === "definite-not-sent") {
			const {
				createConversationEventUseCaseV1,
				parseConversationOperationFactV2,
			} = await import("@agent-infra/platform-core");
			const { PostgresConversationEventTransactionV1 } = await import(
				"./conversation-events.js"
			);
			const [boundary] =
				await sql`select session_generation,delivery_fence from platform.conversation_executions where execution_id=${task.executionId}`;
			const base = {
				kind: "tool",
				toolId: "connection.github.create_pr",
				operationRef: "late-operation",
				attemptRef: "late-attempt",
				connection: {
					serviceRef: "fixture-service",
					verification: "unverified",
					reason: "receipt_missing",
				},
			};
			const started = {
				...base,
				phase: "started",
				startedAt: "2026-09-04T00:00:00.000Z",
			};
			const completed = {
				...started,
				phase: "completed",
				finishedAt: "2026-09-04T00:00:01.000Z",
				durationMs: 1000,
				resultRef: "fixture-result",
				connection: {
					serviceRef: "fixture-service",
					verification: "unverified",
					callRef: "fixture-call",
					reason: "record_unavailable",
				},
			};
			const persist = async (fact: unknown, key: string, late = false) => {
				const transaction = new PostgresConversationEventTransactionV1(
					database,
				);
				try {
					return await createConversationEventUseCaseV1({
						transaction,
					}).persist({
						schemaVersion: 1,
						conversationId: task.conversationId,
						executionId: task.executionId,
						sessionGeneration: Number(boundary?.session_generation),
						deliveryFence: Number(boundary?.delivery_fence),
						adapterEventKey: key,
						runtimeCursor: key,
						occurredAt: new Date().toISOString(),
						...(late ? { operationMetadataOnly: true } : {}),
						event: {
							schemaVersion: 2,
							type: "execution.operation",
							fact: parseConversationOperationFactV2(fact),
						},
					});
				} finally {
					await transaction.close();
				}
			};
			await sql`update platform.conversations set last_conversation_cursor=2 where id=${task.conversationId}`;
			await sql`update platform.conversation_executions set status='processing' where execution_id=${task.executionId}`;
			for (const [index, fact] of [
				{ ...base, phase: "intent" },
				started,
				completed,
			].entries())
				expect((await persist(fact, `original-${index}`)).outcome).toBe(
					"accepted",
				);
			await sql`update platform.conversation_executions set status='completed' where execution_id=${task.executionId}`;
			lateMetadata = async () => {
				expect(
					(
						await persist(
							{
								...completed,
								connection: {
									serviceRef: "fixture-service",
									verification: "verified",
									callRef: "fixture-call",
								},
							},
							"late-verification",
							true,
						)
					).outcome,
				).toBe("accepted");
			};
		}
		let calls = 0;
		const server = createServer(async (req, res) => {
			calls++;
			for await (const _ of req) {
			}
			if (mode === "post-send-unknown") {
				res.destroy();
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					id: "fixture",
					object: "response",
					status: "completed",
					model: "score-model",
					output: [
						{
							type: "message",
							role: "assistant",
							status: "completed",
							content: [
								{
									type: "output_text",
									text: JSON.stringify({
										status: "scored",
										value: 1,
										reason: "Synthetic",
									}),
								},
							],
						},
					],
				}),
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("missing address");
		const origin = `http://127.0.0.1:${address.port}`;
		const outboxes = createPostgresOutboxStore(database);
		let preflightFailures = 0;
		const store = new PostgresEvaluationScoringV1({
			...database,
			directory,
			loadDataPolicy: async () => policy,
			loadExperimentPolicy: async () => experimentPolicy,
			storage,
			taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
			model: async (_lease, _intent, input) => {
				if (mode === "definite-not-sent" && preflightFailures++ === 0)
					throw new EvaluationModelNotSentErrorV1();
				return scoreEvaluationModelV1({
					endpoint: {
						endpointId: "score-endpoint",
						baseUrl: origin,
						origin,
						protocol: "openai-responses-v1",
						security: { tls: "loopback-http", redirects: "reject" },
						capabilities: {
							streaming: true,
							tools: true,
							reasoningLevels: ["low"],
						},
						allowedModels: ["score-model"],
						available: true,
					},
					modelId: "score-model",
					credential: new TextEncoder().encode("synthetic-scoring-credential"),
					rubric: input.rubric,
					output: input.output,
					minimum: 0,
					maximum: 1,
					maxInputBytes: 65536,
					maxOutputBytes: 4096,
					maxOutputTokens: 256,
					timeoutMs: 1000,
				});
			},
		});
		const [score] =
			await sql`select id from platform.evaluation_score_intents where sample_task_id=${task.sampleTaskId}`;
		if (!score) throw new Error("missing score");
		const itemId = `evaluation-score:${score.id}`;
		const claim = async () => {
			await sql`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${itemId}`;
			const c = await outboxes.claim({
				itemId,
				leaseOwner: "model-fault",
				leaseDurationMs: 30000,
			});
			if (!c) throw new Error("claim rejected");
			return {
				intentId: score.id,
				itemId,
				leaseOwner: "model-fault",
				deliveryFence: c.deliveryFence.toString(),
			};
		};
		try {
			if (mode === "checkpoint-lost" || mode === "commit-persistent-failure") {
				await sql.unsafe(
					`create function platform.eval_checkpoint_failure()returns trigger language plpgsql as $$ begin if ${mode === "checkpoint-lost" ? "NEW.status='result_ready' and OLD.status='unknown'" : "NEW.status='scored'"} then raise exception 'synthetic checkpoint failure'; end if; return NEW; end $$`,
				);
				await sql.unsafe(
					"create trigger eval_checkpoint_failure before update on platform.evaluation_score_intents for each row execute function platform.eval_checkpoint_failure()",
				);
			}
			const commit = store.commit.bind(store);
			let commitFailed = false;
			if (mode === "commit-response-lost")
				store.commit = async (...args) => {
					await commit(...args);
					if (!commitFailed) {
						commitFailed = true;
						throw new Error("synthetic response loss");
					}
				};
			const work = createEvaluationScoreWorkV1(store);
			const first = await claim();
			await work.execute(first);
			expect(calls).toBe(mode === "definite-not-sent" ? 0 : 1);
			const [frozen] =
				await sql`select data->>'resultVersion' as version,data->>'outputObjectId' as output from platform.evaluation_score_intents where id=${score.id}`;
			await lateMetadata?.();

			if (mode === "checkpoint-lost") {
				await sql.unsafe(
					"drop trigger eval_checkpoint_failure on platform.evaluation_score_intents",
				);
				await sql.unsafe("drop function platform.eval_checkpoint_failure()");
			}
			await outboxes.scheduleRetry({
				itemId,
				leaseOwner: first.leaseOwner,
				deliveryFence: BigInt(first.deliveryFence),
				retryDelayMs: 0,
				errorCode: "SYNTHETIC_RESPONSE_LOSS",
			});
			const second = await claim();
			expect(second.deliveryFence).toBe("2");
			await work.execute(second);
			expect(calls).toBe(1);
			expect(
				await sql`select data->>'resultVersion' as version,data->>'outputObjectId' as output from platform.evaluation_score_intents where id=${score.id}`,
			).toEqual([frozen]);

			expect(
				await sql`select status,(data->>'attempts')::int as attempts from platform.evaluation_score_intents where id=${score.id}`,
			).toEqual([
				{
					status:
						mode === "post-send-unknown"
							? "unknown"
							: mode === "commit-persistent-failure"
								? "failed"
								: "scored",
					attempts: ["definite-not-sent", "commit-persistent-failure"].includes(
						mode,
					)
						? 2
						: 1,
				},
			]);
			expect(
				await sql`select count(*)::int as count from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId}`,
			).toEqual([{ count: 2 }]);
			await expect(store.prepare(first)).rejects.toMatchObject({
				code: "denied",
			});
		} finally {
			await sql.unsafe(
				"drop trigger if exists eval_checkpoint_failure on platform.evaluation_score_intents",
			);
			await sql.unsafe(
				"drop function if exists platform.eval_checkpoint_failure()",
			);
			await store.close();
			await outboxes.close();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	},
	30000,
);

it("serializes a human score with deletion before row locks and denies the losing content commit", async () => {
	const command = {
		...(await dataset()),
		scorerRefs: [{ scorerId: "human", version: "1" }],
	};
	const experiment = await core.create(
		request("runner"),
		randomUUID(),
		command,
	);
	await data.grant(request("admin"), randomUUID(), command.datasetId, {
		expectedRevision: 4,
		principal: { kind: "user", id: "runner" },
		versionIds: [command.versionId],
		operations: ["score"],
		expiresAt: new Date(Date.now() + 50000).toISOString(),
	});
	await data.grant(request("admin"), randomUUID(), command.datasetId, {
		expectedRevision: 5,
		principal: { kind: "user", id: "admin" },
		versionIds: [command.versionId],
		operations: ["delete"],
		expiresAt: new Date(Date.now() + 50000).toISOString(),
	});

	const [task] = await experiments.samples(experiment.experimentId, 10);
	if (!task) throw new Error("missing sample");
	await sql`update platform.conversation_executions set status='completed',last_event_sequence=2 where execution_id=${task.executionId}`;
	await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)values(${randomUUID()},${task.conversationId},${task.executionId},2,2,'text.delta',${sql.json({ type: "text.delta", text: "yes" })},'runtime',${randomUUID()},${"c".repeat(64)},'2',clock_timestamp())`;
	let armed = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const scoring = new PostgresEvaluationScoringV1({
		...database,
		directory,
		loadDataPolicy: async () => {
			if (armed) {
				armed = false;
				entered.resolve();
				await release.promise;
			}
			return policy;
		},
		loadExperimentPolicy: async () => experimentPolicy,
		storage,
		taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
	});
	const outboxes = createPostgresOutboxStore(database);
	try {
		const [row] =
			await sql`select id from platform.evaluation_score_intents where sample_task_id=${task.sampleTaskId}`;
		if (!row) throw new Error("missing intent");
		const itemId = `evaluation-score:${row.id}`;
		await sql`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${itemId}`;
		const claim = await outboxes.claim({
			itemId,
			leaseOwner: "human-concurrency",
			leaseDurationMs: 30000,
		});
		if (!claim) throw new Error("missing lease");
		const prepared = await scoring.prepare({
			intentId: row.id,
			itemId,
			leaseOwner: "human-concurrency",
			deliveryFence: claim.deliveryFence.toString(),
		});
		if (!("intent" in prepared) || !prepared.intent)
			throw new Error("missing prepared");
		armed = true;
		const human = createEvaluationHumanScoringV1(scoring).submit(
			request("runner"),
			randomUUID(),
			row.id,
			prepared.intent.revision,
			{ status: "scored", value: 1, reason: "Synthetic" },
		);
		const humanSettled = human.then(
			() => ({ allowed: true }),
			(error) => ({ allowed: false, error }),
		);
		await entered.promise;
		const [version] =
			await sql`select data from platform.evaluation_versions where id=${command.versionId}`;
		const removal = data.remove(
			request("admin"),
			randomUUID(),
			command.datasetId,
			command.versionId,
			version?.data.revision,
		);
		try {
			await expect
				.poll(
					async () => {
						const [wait] =
							await sql`select count(*)::int as count from pg_locks where locktype='advisory' and not granted`;
						return wait?.count;
					},
					{ timeout: 2000 },
				)
				.toBeGreaterThan(0);
		} finally {
			release.resolve();
		}
		await removal;
		expect(await humanSettled).toMatchObject({
			allowed: false,
			error: { code: "denied" },
		});
		expect(
			await sql`select status from platform.evaluation_versions where id=${command.versionId}`,
		).toEqual([{ status: "deleting" }]);
		expect(
			await sql`select count(*)::int as count from platform.audit_events where target_id=${row.id} and action='evaluation.score.human'`,
		).toEqual([{ count: 0 }]);
	} finally {
		release.resolve();
		await scoring.close();
		await outboxes.close();
	}
}, 30000);

it.each(["cancelled", "failed", "unknown"] as const)(
	"settles only real business terminal states for independent scoring: %s",
	async (status) => {
		const command = await dataset();
		const experiment = await core.create(
			request("runner"),
			randomUUID(),
			command,
		);
		await data.grant(request("admin"), randomUUID(), command.datasetId, {
			expectedRevision: 4,
			principal: { kind: "user", id: "runner" },
			versionIds: [command.versionId],
			operations: ["score"],
			expiresAt: new Date(Date.now() + 50000).toISOString(),
		});
		const [task] = await experiments.samples(experiment.experimentId, 10);
		if (!task) throw new Error("missing task");
		if (status === "cancelled") {
			const {
				createConversationExecutionUseCaseV1,
				parseTaskAuthorizationBoundaryV1,
			} = await import("@agent-infra/platform-core");
			const { PostgresConversationExecutionTransactionV1 } = await import(
				"./conversation-execution.js"
			);
			const [record] =
				await sql`select boundary from platform.task_authorization_records where execution_id=${task.executionId}`;
			const boundary = parseTaskAuthorizationBoundaryV1(record?.boundary);
			const transaction = new PostgresConversationExecutionTransactionV1({
				...database,
				userDirectory: directory,
				evaluationPolicy: {
					data: async () => policy,
					experiment: async () => experimentPolicy,
				},
			});
			try {
				const cancelled = await createConversationExecutionUseCaseV1({
					transaction,
					authorization: {
						authorize: async () => ({
							outcome: "allowed",
							authority: {
								schemaVersion: 1,
								actorId: "runner",
								agentId: configuration.agentId,
								channelId: "eval",
								authorizationRevision: boundary.agentAuthorizationRevision,
								supportsSupplementaryInstruction: false,
								taskBoundary: boundary,
							},
						}),
					},
				}).stop({
					schemaVersion: 1,
					command: "stop",
					conversationId: task.conversationId,
					targetExecutionId: task.executionId,
					idempotencyKey: randomUUID(),
					requestId: randomUUID(),
					traceId: randomUUID(),
				});
				expect(cancelled.outcome).toBe("accepted");
			} finally {
				await transaction.close();
			}
		} else
			await sql`update platform.conversation_executions set status=${status} where execution_id=${task.executionId}`;
		expect(
			await sql`select status from platform.conversation_executions where execution_id=${task.executionId}`,
		).toEqual([{ status }]);
		expect(
			await sql`select status from platform.evaluation_experiments where id=${experiment.experimentId}`,
		).toEqual([{ status: "active" }]);
		const scoring = new PostgresEvaluationScoringV1({
			...database,
			directory,
			loadDataPolicy: async () => policy,
			loadExperimentPolicy: async () => experimentPolicy,
			storage,
			taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
			model: async () => {
				throw new Error("Must not send model");
			},
		});
		const outbox = createPostgresOutboxStore(database);
		try {
			const [score] =
				await sql`select id from platform.evaluation_score_intents where sample_task_id=${task.sampleTaskId}`;
			if (!score) throw new Error("missing score");
			const itemId = `evaluation-score:${score.id}`;
			await sql`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${itemId}`;
			const claim = await outbox.claim({
				itemId,
				leaseOwner: "cancelled-score",
				leaseDurationMs: 30000,
			});
			if (!claim) throw new Error("missing lease");
			const lease = {
				intentId: score.id,
				itemId,
				leaseOwner: "cancelled-score",
				deliveryFence: claim.deliveryFence.toString(),
			};
			const { createEvaluationScoreWorkV1 } = await import(
				"@agent-infra/platform-core"
			);
			const result = await createEvaluationScoreWorkV1(scoring).execute(lease);
			expect(result.outcome).toBe(
				status === "unknown" ? "waiting" : "completed",
			);
			if (result.outcome === "completed")
				await outbox.markSucceeded({
					itemId,
					leaseOwner: lease.leaseOwner,
					deliveryFence: claim.deliveryFence,
				});
			expect(
				await sql`select status,data->>'failureCode' as code from platform.evaluation_score_intents where id=${score.id}`,
			).toEqual([
				{
					status: status === "unknown" ? "waiting_output" : "not_applicable",
					code: status === "unknown" ? null : "TASK_NOT_COMPLETED",
				},
			]);
			expect(
				await sql`select count(*)::int as count from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId}`,
			).toEqual([{ count: 2 }]);
			expect(
				await sql`select count(*)::int as count from platform.evaluation_derived_objects where version_id=${command.versionId}`,
			).toEqual([{ count: 0 }]);
		} finally {
			await scoring.close();
			await outbox.close();
		}
	},
	30000,
);

it("settles whole-experiment cancellation through metadata-only worker control", async () => {
	const preserved = new Map<string, unknown>();
	let catalogCalls = 0;
	let decryptCalls = 0;
	const worker = createEvaluationScoringWorkerV1({
		...database,
		directory,
		loadDataPolicy: async () => policy,
		loadExperimentPolicy: async () => experimentPolicy,
		storage,
		taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
		batchSize: 100,
		leaseMs: 30000,
		retryDelayMs: 1000,
		catalog: createDeploymentModelCatalogAdapterV1({
			load: async () => {
				catalogCalls++;
				throw new Error("unexpected catalog");
			},
		}),
		decryptor: {
			decrypt: async () => {
				decryptCalls++;
				throw new Error("unexpected decrypt");
			},
		},
	});
	const ids = [];
	try {
		for (const status of ["waiting", "completed", "failed", "unknown"]) {
			const command = await dataset();
			await data.grant(request("admin"), randomUUID(), command.datasetId, {
				expectedRevision: 4,
				principal: { kind: "user", id: "runner" },
				versionIds: [command.versionId],
				operations: ["score"],
				expiresAt: new Date(Date.now() + 50000).toISOString(),
			});
			const experiment = await core.create(
				request("runner"),
				randomUUID(),
				command,
			);
			ids.push(experiment.experimentId);
			const tasks = await experiments.samples(experiment.experimentId, 10);
			const first = tasks[0];
			if (!first) throw new Error("missing task");
			if (status !== "waiting")
				await sql`update platform.conversation_executions set status=${status} where execution_id=${first.executionId}`;
			await core.cancel(
				request("runner"),
				experiment.experimentId,
				randomUUID(),
			);
			const [grant] =
				await sql`select data from platform.evaluation_grants where dataset_id=${command.datasetId} and data->'operations' ? 'score'`;
			await data.revoke(
				request("admin"),
				randomUUID(),
				command.datasetId,
				grant?.data.grantId,
				grant?.data.revision,
			);
		}

		const preservationCommand = await dataset();
		const preservationExperiment = await core.create(
			request("runner"),
			randomUUID(),
			{
				...preservationCommand,
				scorerRefs: [
					{ scorerId: "exact", version: "1" },
					{ scorerId: "human", version: "1" },
					{ scorerId: "model", version: "1" },
				],
			},
		);
		ids.push(preservationExperiment.experimentId);
		const rows =
			await sql`select i.id,i.data from platform.evaluation_score_intents i join platform.evaluation_sample_tasks s on s.id=i.sample_task_id where s.experiment_id=${preservationExperiment.experimentId} order by i.id`;
		const statuses = [
			"scored",
			"not_applicable",
			"failed",
			"unknown",
			"result_ready",
			"pending",
		] as const;
		for (const [index, row] of rows.entries()) {
			const status = statuses[index];
			if (!status) throw new Error("missing status");
			const value = {
				...row.data,
				status,
				...(status === "scored"
					? {
							value: 1,
							passed: true,
							scoreActor: { kind: "user", id: "runner" },
							reasonObjectId: randomUUID(),
						}
					: {}),
				...(status === "result_ready"
					? { reasonObjectId: randomUUID(), resultVersion: "fixed-result" }
					: {}),
				...(status === "unknown" ? { attempts: 1 } : {}),
			};
			await sql`update platform.evaluation_score_intents set status=${status},result_version=${value.resultVersion ?? "unobserved"},data=${sql.json(value)} where id=${row.id}`;
			if (status !== "pending") preserved.set(row.id, value);
		}
		await core.cancel(
			request("runner"),
			preservationExperiment.experimentId,
			randomUUID(),
		);

		let downloads = 0;
		const downloadedRefs: string[] = [];
		const download = storage.download;
		storage.download = async (...args) => {
			downloads++;
			downloadedRefs.push(args[0].objectRef);
			return download(...args);
		};
		try {
			for (let round = 0; round < 3; round++) {
				await sql`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where operation='evaluation.score.v1' and status in('pending','retry_scheduled')`;
				await worker.runOnce();
			}
		} finally {
			storage.download = download;
		}
		const [pending] =
			await sql`select i.id,i.data from platform.evaluation_score_intents i join platform.outbox_items o on o.scope_id=i.id::text and o.operation='evaluation.score.v1' where i.status='waiting_output' and o.status='retry_scheduled' limit 1`;
		if (!pending) throw new Error("missing unconfirmed stop");
		const outbox = createPostgresOutboxStore(database);
		const metadataStore = new PostgresEvaluationScoringV1({
			...database,
			directory,
			loadDataPolicy: async () => policy,
			loadExperimentPolicy: async () => experimentPolicy,
			storage,
			taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
		});
		try {
			const itemId = `evaluation-score:${pending.id}`;
			await sql`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${itemId}`;
			const claim = await outbox.claim({
				itemId,
				leaseOwner: "binding-probe",
				leaseDurationMs: 30000,
			});
			if (!claim) throw new Error("missing claim");
			const lease = {
				intentId: pending.id,
				itemId,
				leaseOwner: "binding-probe",
				deliveryFence: claim.deliveryFence.toString(),
			};
			await expect(
				metadataStore.prepare({
					...lease,
					deliveryFence: String(claim.deliveryFence - 1n),
				}),
			).rejects.toThrow();
			await sql`update platform.evaluation_score_intents set data=jsonb_set(data,'{executionId}',to_jsonb(${randomUUID()}::text)) where id=${pending.id}`;
			try {
				await expect(metadataStore.prepare(lease)).rejects.toMatchObject({
					code: "unavailable",
				});
			} finally {
				await sql`update platform.evaluation_score_intents set data=${sql.json(pending.data)} where id=${pending.id}`;
			}
			await outbox.scheduleRetry({
				itemId,
				leaseOwner: lease.leaseOwner,
				deliveryFence: claim.deliveryFence,
				retryDelayMs: 1000,
				errorCode: "TEST_RESTORE",
			});
		} finally {
			await metadataStore.close();
			await outbox.close();
		}
		const scores =
			await sql`select i.id,s.experiment_id,e.status as task_status,i.status as score_status,(i.data->>'attempts')::int as attempts,i.data->>'failureCode' as code,o.status as outbox_status from platform.evaluation_score_intents i join platform.evaluation_sample_tasks s on s.id=i.sample_task_id join platform.conversation_executions e on e.execution_id=s.execution_id join platform.outbox_items o on o.scope_id=i.id::text and o.operation='evaluation.score.v1' where s.experiment_id in ${sql(ids)} order by s.experiment_id,e.execution_id`;
		const taskCount =
			await sql`select count(*)::int as count from platform.evaluation_sample_tasks where experiment_id in ${sql(ids)}`;
		const downloadedBindings =
			await sql`select v.id::text as version_id,v.data->>'objectRef' as object_ref,'source' as kind,e.id::text as experiment_id,e.status from platform.evaluation_versions v left join platform.evaluation_experiments e on e.version_id=v.id where v.data->>'objectRef' in ${sql(downloadedRefs.length ? downloadedRefs : ["none"])} union all select d.version_id::text,d.data->>'objectRef',d.kind,e.id::text,e.status from platform.evaluation_derived_objects d left join platform.evaluation_experiments e on e.version_id=d.version_id where d.data->>'objectRef' in ${sql(downloadedRefs.length ? downloadedRefs : ["none"])}`;
		expect(
			downloads,
			JSON.stringify({
				cancelledExperimentIds: ids,
				downloadedRefs,
				downloadedBindings,
			}),
		).toBe(0);
		expect(taskCount).toEqual([{ count: 10 }]);
		expect(
			await sql`select count(*)::int as count from platform.evaluation_score_intents where status='not_applicable' and (data->'value'<>'null'::jsonb or data->'passed'<>'null'::jsonb)`,
		).toEqual([{ count: 0 }]);
		expect(catalogCalls).toBe(0);
		expect(decryptCalls).toBe(0);
		for (const row of scores) {
			if (preserved.has(row.id)) {
				const [saved] =
					await sql`select data from platform.evaluation_score_intents where id=${row.id}`;
				expect(saved?.data).toEqual(preserved.get(row.id));
				expect(row.outbox_status).toBe("succeeded");
				continue;
			}
			expect(row.score_status).toBe(
				row.task_status === "unknown" ? "waiting_output" : "not_applicable",
			);
			expect(row.code).toBe(
				row.task_status === "unknown"
					? null
					: row.task_status === "completed"
						? "EXPERIMENT_CANCELLED"
						: "TASK_NOT_COMPLETED",
			);
		}
	} finally {
		await worker.close();
	}
}, 30000);

async function evaluationFileJourney({
	principalKind,
	task,
	command,
	signer,
	authority,
}: {
	principalKind: "user" | "application";
	task: Awaited<ReturnType<typeof experiments.samples>>[number];
	command: Awaited<ReturnType<typeof dataset>>;
	signer: {
		privateKey: import("node:crypto").KeyObject;
		publicKey: import("node:crypto").KeyObject;
	};
	authority: import("./evaluation-task-authority.js").PostgresEvaluationTaskAuthorityV1;
}) {
	const { assemblePlatformFilesV1 } = await import(
		"../../../apps/platform-api/src/file-assembly.js"
	);
	const { createPlatformHealthApp } = await import(
		"../../../apps/platform-api/src/app.js"
	);
	const { registerFileRoutesV1 } = await import(
		"../../../apps/platform-api/src/http/file-routes.js"
	);
	const { RuntimeBusinessGrantClaimsV4Schema } = await import(
		"@agent-infra/contracts/runtime"
	);
	const { FileAccessResponseV1Schema } = await import(
		"@agent-infra/contracts/files"
	);
	const { sessionSandboxFileExchangeTokenV1 } = await import(
		"@agent-infra/platform-core"
	);
	const fileStorage = await startMinioFileFixtureV1();
	let actorResolutions = 0;
	const limits = {
		revision: "fixture",
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		maxBytes: 4096,
		mediaTypes: ["text/plain"],
	};
	const serviceToken = "synthetic-eval-runtime-file-service";
	const files = assemblePlatformFilesV1({
		...database,
		identity: { resolve: async () => null, hydrateUsers: async () => [] },
		conversationAuthorization: {
			authorize: async () => {
				throw new Error("Eval must not impersonate a Web user");
			},
		},
		readCurrentLimits: async () => {
			throw new Error("Eval must use service-only limits");
		},
		evaluationCurrent: authority.conversationCurrent.bind(authority),
		evaluationFileCurrent: authority.fileCurrent.bind(authority),
		deployment: {
			storage: fileStorage.storage,
			issuer: "file-fixture",
			keyVersion: "file-fixture",
			privateKey: signer.privateKey,
			publicKeys: new Map([["file-fixture", signer.publicKey]]),
			runtimeIssuer: "fixture",
			runtimeWorkerId: "eval-fixture-worker",
			runtimePublicKeys: new Map([["fixture", signer.publicKey]]),
			intentTtlMs: 60000,
			accessTtlMs: 30000,
			maxConcurrentTransfers: 2,
			services: [{ token: serviceToken, agentIds: [configuration.agentId] }],
			resolveActor: async () => {
				actorResolutions++;
				throw new Error("Application is not a user");
			},
			readLimits: async () => ({
				configurationRevision: configuration.revision,
				declarations: { agent: limits, channel: limits, deployment: limits },
			}),
		},
	});
	const fileApp = createPlatformHealthApp();
	registerFileRoutesV1(fileApp, files.dependencies);
	const fileServer = serve({
		fetch: fileApp.fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	if (!fileServer.listening)
		await new Promise<void>((resolve) => fileServer.once("listening", resolve));
	const fileAddress = fileServer.address();
	if (!fileAddress || typeof fileAddress === "string")
		throw new Error("file fixture server");
	const fileOrigin = `http://127.0.0.1:${fileAddress.port}`;
	let fileProduced = false;
	let checkRevokedFile: (() => Promise<void>) | undefined;
	const produceFile = async (
		runtimeRequest: import("../../platform-core/src/conversation-dispatch.js").ConversationRuntimeDispatchRequestV1,
	) => {
		const [record] =
			await sql`select id,boundary from platform.task_authorization_records where execution_id=${task.executionId}`;
		const issuedAt = Date.now() - 1000;
		const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
			schemaVersion: 4,
			issuer: "fixture",
			audience: "runtime_host",
			issuedAt,
			expiresAt: issuedAt + 30000,
			grantId: randomUUID(),
			workerId: "eval-fixture-worker",
			principal: { kind: principalKind, id: "runner" },
			executionSource: "eval",
			relayKeyBinding: {
				purpose: "agent-default",
				subjectId: configuration.agentId,
				ciphertextRef: "eval-default",
				version: 1,
			},
			agentId: configuration.agentId,
			channelId: "eval",
			conversationId: task.conversationId,
			executionId: task.executionId,
			turnId: runtimeRequest.turnId,
			sessionGeneration: runtimeRequest.sessionGeneration,
			traceId: runtimeRequest.traceId,
			hostSessionRef: null,
			operation: {
				kind: "execution",
				id: task.executionId,
				deliveryFence: runtimeRequest.deliveryFence,
				executionDeliveryFence: runtimeRequest.deliveryFence,
			},
			allowedCommands: ["turn.submit"],
			purpose: "business",
			authorizationRecordId: record?.id,
			attachments: [],
			requestDigest: "a".repeat(64),
		});
		const header = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				kid: "fixture",
				typ: "runtime-execution+jws",
			}),
		).toString("base64url");
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const signing = `${header}.${payload}`;
		const executionGrant = {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: `${signing}.${sign(null, Buffer.from(signing), signer.privateKey).toString("base64url")}`,
		};
		const [sandbox] =
			await sql`select sandbox_id,resource_fence,session_generation,resource_policy->>'namespace' as namespace from platform.session_sandbox_allocations where conversation_id=${task.conversationId}`;
		if (!sandbox) throw new Error("no sandbox");
		const token = sessionSandboxFileExchangeTokenV1(serviceToken, {
			sandboxId: sandbox.sandbox_id,
			namespace: sandbox.namespace,
			generation: Number(sandbox.session_generation),
			resourceFence: Number(sandbox.resource_fence),
		});
		const text = "synthetic file output";
		const descriptor = {
			name: "answer.txt",
			mediaType: "text/plain",
			sizeBytes: Buffer.byteLength(text),
			sha256: createHash("sha256").update(text).digest("hex"),
		};
		const key = randomUUID();
		const exchanged = await fetch(
			`${fileOrigin}/internal/v1/files/runtime-exchange`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify({
					schemaVersion: 2,
					executionGrant,
					idempotencyKey: key,
					operation: "result",
					descriptor,
				}),
			},
		);
		expect(exchanged.status).toBe(200);
		const access = FileAccessResponseV1Schema.parse(await exchanged.json());
		const transferHeaders = {
			Authorization: `Bearer ${token}`,
			"X-Platform-File-Grant": access.grant.token,
		};
		const uploaded = await fetch(`${fileOrigin}${access.path}`, {
			method: "PUT",
			headers: { ...transferHeaders, "Content-Type": "text/plain" },
			body: text,
		});
		expect(uploaded.status).toBe(204);
		const completed = await fetch(
			`${fileOrigin}/api/v1/conversations/${task.conversationId}/files/${access.file.fileId}/complete`,
			{
				method: "POST",
				headers: {
					...transferHeaders,
					"Content-Type": "application/json",
					"Idempotency-Key": randomUUID(),
				},
				body: JSON.stringify({ schemaVersion: 1, accessId: access.accessId }),
			},
		);
		expect(completed.status).toBe(200);
		const attachmentId = randomUUID();
		const objectRef = randomUUID();
		const bodyBytes = new TextEncoder().encode("synthetic input bytes");
		const inputDescriptor = {
			name: "input.txt",
			mediaType: "text/plain",
			sizeBytes: bodyBytes.length,
			sha256: createHash("sha256").update(bodyBytes).digest("hex"),
		};
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		await fileStorage.storage.upload({
			objectRef,
			descriptor: inputDescriptor,
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bodyBytes);
					controller.close();
				},
			}),
			expiresAt,
		});
		const stored = await fileStorage.storage.inspect(objectRef);
		if (!stored) throw new Error("input object missing");
		const file = {
			actorId: "runner",
			agentId: configuration.agentId,
			channelId: "eval",
			conversationId: task.conversationId,
			fileId: attachmentId,
			objectRef,
			kind: "attachment",
			idempotencyKey: randomUUID(),
			descriptor: inputDescriptor,
			status: "available",
			executionId: task.executionId,
			messageId: null,
			sessionGeneration: runtimeRequest.sessionGeneration,
			objectVersion: stored.version,
			etag: stored.etag,
			createdAt: new Date().toISOString(),
			expiresAt,
			updatedAt: new Date().toISOString(),
			revision: 1,
		};
		await sql`insert into platform.files(file_id,conversation_id,actor_id,idempotency_key,record,updated_at)values(${attachmentId},${task.conversationId},'runner',${file.idempotencyKey},${sql.json(file)},clock_timestamp())`;
		const signGrant = (value: typeof claims) => {
			const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
			const content = `${header}.${payload}`;
			return {
				schemaVersion: 4,
				format: "runtime-execution-jws",
				token: `${content}.${sign(null, Buffer.from(content), signer.privateKey).toString("base64url")}`,
			};
		};
		const readClaims = {
			...claims,
			attachments: [{ attachmentId, operations: ["read" as const] }],
		};
		const exchangeRead = async (value: typeof readClaims, key = randomUUID()) =>
			fetch(`${fileOrigin}/internal/v1/files/runtime-exchange`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify({
					schemaVersion: 2,
					executionGrant: signGrant(value),
					idempotencyKey: key,
					operation: "read",
					fileId: attachmentId,
				}),
			});
		const readResponse = await exchangeRead(readClaims);
		expect(readResponse.status).toBe(200);
		const readAccess = FileAccessResponseV1Schema.parse(
			await readResponse.json(),
		);
		const read = () =>
			fetch(`${fileOrigin}${readAccess.path}`, {
				headers: {
					Authorization: `Bearer ${token}`,
					"X-Platform-File-Grant": readAccess.grant.token,
				},
			});
		let response = await read();
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(
			Buffer.from(bodyBytes),
		);
		expect(
			(
				await exchangeRead({
					...readClaims,
					principal: {
						kind: principalKind === "application" ? "user" : "application",
						id: "runner",
					},
				})
			).status,
		).toBe(404);
		const accessClaims = files.dependencies.codec.verify(readAccess.grant);
		if (!accessClaims.execution?.evaluation)
			throw new Error("missing signed Eval binding");
		const forged = files.dependencies.codec.sign({
			...accessClaims,
			keyVersion: "file-fixture",
			idempotencyKey: "forged-fixture",
			execution: {
				...accessClaims.execution,
				evaluation: {
					...accessClaims.execution.evaluation,
					principal: {
						kind: principalKind === "application" ? "user" : "application",
						id: "runner",
					},
				},
			},
		});
		expect(
			(
				await fetch(`${fileOrigin}${readAccess.path}`, {
					headers: {
						Authorization: `Bearer ${token}`,
						"X-Platform-File-Grant": forged.token,
					},
				})
			).status,
		).toBe(404);
		await sql`update platform.conversation_executions set delivery_fence=delivery_fence+1 where execution_id=${task.executionId}`;
		try {
			expect((await read()).status).toBe(404);
			expect((await exchangeRead(readClaims)).status).toBe(404);
		} finally {
			await sql`update platform.conversation_executions set delivery_fence=${runtimeRequest.deliveryFence} where execution_id=${task.executionId}`;
		}
		await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where agent_id=${configuration.agentId} and principal_type=${principalKind} and principal_id='runner' and grant_type='use'`;
		try {
			expect((await read()).status).toBe(404);
		} finally {
			await sql`update platform.agent_principal_grants set revoked_at=null where agent_id=${configuration.agentId} and principal_type=${principalKind} and principal_id='runner' and grant_type='use'`;
		}
		if (principalKind === "application") {
			await sql`update platform.platform_applications set status='disabled' where id='runner'`;
			try {
				expect((await read()).status).toBe(404);
			} finally {
				await sql`update platform.platform_applications set status='active' where id='runner'`;
			}
		}
		const [workload] =
			await sql`select state from platform.workload_reconciliations where agent_id=${configuration.agentId}`;
		await sql`update platform.workload_reconciliations set state=jsonb_set(state,'{capabilities,attachments}','false'::jsonb) where agent_id=${configuration.agentId}`;
		try {
			expect((await read()).status).toBe(404);
		} finally {
			await sql`update platform.workload_reconciliations set state=${sql.json(workload?.state)} where agent_id=${configuration.agentId}`;
		}
		await sql`update platform.agents set current_configuration_revision=current_configuration_revision+1 where id=${configuration.agentId}`;
		try {
			expect((await read()).status).toBe(404);
		} finally {
			await sql`update platform.agents set current_configuration_revision=${configuration.revision} where id=${configuration.agentId}`;
		}
		const beforeLimits = limits.maxBytes;
		limits.maxBytes = 1;
		try {
			expect((await read()).status).toBe(404);
		} finally {
			limits.maxBytes = beforeLimits;
		}
		const oldGrant =
			await sql`select id,data from platform.evaluation_grants where dataset_id=${command.datasetId} and data->'principal'->>'kind'=${principalKind} and data->'operations' ? 'run'`;
		const runGrant = oldGrant[0];
		if (!runGrant) throw new Error("run grant missing");
		await sql`update platform.evaluation_grants set data=jsonb_set(data,'{expiresAt}',to_jsonb(${new Date(Date.now() - 1).toISOString()}::text)) where id=${runGrant.id}`;
		try {
			expect((await read()).status).toBe(404);
		} finally {
			await sql`update platform.evaluation_grants set data=${sql.json(runGrant.data)} where id=${runGrant.id}`;
		}
		response = await read();
		expect(response.status).toBe(200);
		expect(
			createHash("sha256")
				.update(Buffer.from(await response.arrayBuffer()))
				.digest("hex"),
		).toBe(inputDescriptor.sha256);
		checkRevokedFile = async () => {
			expect((await read()).status).toBe(404);
			expect((await exchangeRead(readClaims)).status).toBe(404);
		};

		fileProduced = true;
		expect(actorResolutions).toBe(0);
	};
	return {
		produceFile,
		wasProduced: () => fileProduced,
		assertTerminal: () => checkRevokedFile?.(),
		close: async () => {
			await files.close();
			if ("closeAllConnections" in fileServer) fileServer.closeAllConnections();
			await new Promise<void>((resolve) => fileServer.close(() => resolve()));
			await fileStorage.close();
		},
	};
}

it("settles human scores after their completed outbox when cancelling an experiment", async () => {
	const worker = createEvaluationScoringWorkerV1({
		...database,
		directory,
		loadDataPolicy: async () => policy,
		loadExperimentPolicy: async () => experimentPolicy,
		storage,
		taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
		batchSize: 100,
		leaseMs: 30000,
		retryDelayMs: 1000,
		catalog: createDeploymentModelCatalogAdapterV1({
			load: async () => {
				throw new Error("Human cannot resolve model");
			},
		}),
		decryptor: {
			decrypt: async () => {
				throw new Error("Human cannot read Key");
			},
		},
	});
	try {
		const humanCommand = {
			...(await dataset()),
			scorerRefs: [{ scorerId: "human", version: "1" }],
		};
		await data.grant(request("admin"), randomUUID(), humanCommand.datasetId, {
			expectedRevision: 4,
			principal: { kind: "user", id: "runner" },
			versionIds: [humanCommand.versionId],
			operations: ["score"],
			expiresAt: new Date(Date.now() + 50000).toISOString(),
		});
		const humanExperiment = await core.create(
			request("runner"),
			randomUUID(),
			humanCommand,
		);
		for (const task of await experiments.samples(
			humanExperiment.experimentId,
			10,
		)) {
			await sql`update platform.conversation_executions set status='completed',last_event_sequence=2 where execution_id=${task.executionId}`;
			await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,sequence,conversation_cursor,event_type,event_payload,source,adapter_event_key,event_digest,runtime_cursor,occurred_at)values(${randomUUID()},${task.conversationId},${task.executionId},2,2,'text.delta',${sql.json({ type: "text.delta", text: "yes" })},'runtime',${randomUUID()},${"e".repeat(64)},'2',clock_timestamp())`;
		}
		await worker.runOnce();
		expect(
			await sql`select distinct i.status as score_status,o.status as outbox_status from platform.evaluation_score_intents i join platform.evaluation_sample_tasks s on s.id=i.sample_task_id join platform.outbox_items o on o.scope_id=i.id::text and o.operation='evaluation.score.v1' where s.experiment_id=${humanExperiment.experimentId}`,
		).toEqual([{ score_status: "awaiting_human", outbox_status: "succeeded" }]);
		const before =
			await sql`select i.id,i.data from platform.evaluation_score_intents i join platform.evaluation_sample_tasks s on s.id=i.sample_task_id where s.experiment_id=${humanExperiment.experimentId} order by i.id`;
		await sql.unsafe(
			`create function platform.eval_cancel_human_failure()returns trigger language plpgsql as $$ begin if NEW.action='evaluation.experiment.cancel' then raise exception 'synthetic cancel audit failure';end if;return NEW;end $$`,
		);
		await sql.unsafe(
			"create trigger eval_cancel_human_failure before insert on platform.audit_events for each row execute function platform.eval_cancel_human_failure()",
		);
		try {
			await expect(
				core.cancel(
					request("runner"),
					humanExperiment.experimentId,
					randomUUID(),
				),
			).rejects.toThrow();
			expect(
				await sql`select i.id,i.data from platform.evaluation_score_intents i join platform.evaluation_sample_tasks s on s.id=i.sample_task_id where s.experiment_id=${humanExperiment.experimentId} order by i.id`,
			).toEqual(before);
		} finally {
			await sql.unsafe(
				"drop trigger eval_cancel_human_failure on platform.audit_events",
			);
			await sql.unsafe("drop function platform.eval_cancel_human_failure()");
		}
		await core.cancel(
			request("runner"),
			humanExperiment.experimentId,
			randomUUID(),
		);
		expect(
			await sql`select distinct i.status as score_status,i.data->>'failureCode' as code,o.status as outbox_status from platform.evaluation_score_intents i join platform.evaluation_sample_tasks s on s.id=i.sample_task_id join platform.outbox_items o on o.scope_id=i.id::text and o.operation='evaluation.score.v1' where s.experiment_id=${humanExperiment.experimentId}`,
		).toEqual([
			{
				score_status: "not_applicable",
				code: "EXPERIMENT_CANCELLED",
				outbox_status: "succeeded",
			},
		]);
		expect(
			(await core.get(request("runner"), humanExperiment.experimentId))
				.experiment.status,
		).toBe("cancelled");
	} finally {
		await worker.close();
	}
}, 30000);

it.each(["user", "application"] as const)(
	"requires current %s caller scope/use for HTTP cancellation while revoked data run stays unavailable",
	async (kind) => {
		const command = await dataset();
		if (kind === "application")
			await data.grant(request("admin"), randomUUID(), command.datasetId, {
				expectedRevision: 4,
				principal: { kind, id: "runner" },
				versionIds: [command.versionId],
				operations: ["run"],
				expiresAt: new Date(Date.now() + 50000).toISOString(),
			});
		const material = `papi_${(kind === "user" ? "H" : "J").repeat(43)}`;
		const credentialId = `http-cancel-${kind}`;
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes)values(${credentialId},${kind},'runner',${createHash("sha256").update(material).digest("hex")},${sql.json(["eval:run"])})`;
		const experiment = await core.create(
			{
				...request("runner"),
				authentication: { kind: "credential", material },
			},
			randomUUID(),
			command,
		);
		const tasks = await experiments.samples(experiment.experimentId, 10);
		const task = tasks[0];
		if (!task) throw new Error("missing task");
		const unused = async (): Promise<never> => {
			throw new Error("unused");
		};
		const assembly = assemblePlatformApi({
			...database,
			identity: {
				...directory,
				resolve: async () => null,
				hydrateUsers: async () => [],
			},
			evaluation: {
				storage,
				loadPolicy: async () => policy,
				loadExperimentPolicy: async () => experimentPolicy,
			},
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 100,
				waitingTimeoutMs: 30000,
			},
			admissions: {
				authorizationAdmission: { authorize: unused },
				imageAdmission: { admitImage: unused },
				modelAdmission: { admitModels: unused },
				secretAdmission: { admitSecrets: unused },
				channelAdmission: { admitChannels: unused },
			},
			allocateApplicationIds: unused,
			prepareApplicationSecrets: unused,
			prepareConfigurationSecrets: unused,
			presentAgent: unused,
		});
		const server = serve({
			fetch: createPlatformApp(assembly.dependencies).fetch,
			hostname: "127.0.0.1",
			port: 0,
		});
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("address");
		const base = `http://127.0.0.1:${address.port}`;
		const expPath = `/api/v2/evaluation/experiments/${experiment.experimentId}/cancel`;
		const taskPath = `/api/v1/conversations/${task.conversationId}/tasks/${task.executionId}`;
		const cancel = (path: string) =>
			fetch(base + path, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${material}`,
					"Content-Type": "application/json",
					"Idempotency-Key": randomUUID(),
				},
				body: JSON.stringify(path === expPath ? {} : { schemaVersion: 1 }),
			});
		try {
			await sql`update platform.platform_api_credentials set scopes=${sql.json(["agent:read"])} where id=${credentialId}`;
			for (const path of [expPath, `${taskPath}/cancel`])
				expect((await cancel(path)).status).toBeGreaterThanOrEqual(400);
			await sql`update platform.platform_api_credentials set scopes=${sql.json(["eval:run"])} where id=${credentialId}`;
			await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where agent_id=${configuration.agentId} and principal_type=${kind} and principal_id='runner' and grant_type='use'`;
			try {
				for (const path of [expPath, `${taskPath}/cancel`])
					expect((await cancel(path)).status).toBeGreaterThanOrEqual(400);
			} finally {
				await sql`update platform.agent_principal_grants set revoked_at=null where agent_id=${configuration.agentId} and principal_type=${kind} and principal_id='runner' and grant_type='use'`;
			}
			const [grant] =
				await sql`select data from platform.evaluation_grants where dataset_id=${command.datasetId} and data->'principal'->>'kind'=${kind} and data->'principal'->>'id'='runner' and data->'operations' ? 'run'`;
			await data.revoke(
				request("admin"),
				randomUUID(),
				command.datasetId,
				grant?.data.grantId,
				grant?.data.revision,
			);
			expect(
				(
					await fetch(base + taskPath, {
						headers: { Authorization: `Bearer ${material}` },
					})
				).status,
			).toBe(404);
			expect((await cancel(`${taskPath}/cancel`)).status).toBe(202);
			expect((await cancel(expPath)).status).toBe(200);
			await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id=${credentialId}`;
			expect((await cancel(expPath)).status).toBeGreaterThanOrEqual(400);
			expect(
				await sql`select distinct status from platform.conversation_executions where execution_id in(select execution_id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId})`,
			).toEqual([{ status: "cancelled" }]);
		} finally {
			if ("closeAllConnections" in server) server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await assembly.close();
		}
	},
	30000,
);
