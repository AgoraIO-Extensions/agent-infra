import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
	EvaluationExperimentV1Schema,
	EvaluationScoreMetadataV1Schema,
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
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPlatformApp } from "../../../apps/platform-api/src/app.js";
import { assemblePlatformApi } from "../../../apps/platform-api/src/assembly.js";
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
	expect(malformed.map((r) => r.status)).toEqual([400, 400, 404, 400]);
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
	const server = createServer(async (req, res) => {
		calls++;
		let body = "";
		for await (const chunk of req) body += chunk;
		expect(req.headers.authorization).toBe("Bearer synthetic-score-key");
		expect(JSON.parse(body)).toMatchObject({ tools: [], tool_choice: "none" });
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
		decryptor: createRelayKeyWorkerDecryptorV1({
			keys: [
				{
					keyVersion: "fixture",
					privateKeyPkcs8DerBase64: pair.privateKey
						.export({ format: "der", type: "pkcs8" })
						.toString("base64"),
				},
			],
		}),
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
			if (!prepared.input || !prepared.intent) throw new Error("input missing");
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
		const human = scores.find((s) => s.scorer_id === "human");
		if (!human) throw new Error("missing score");
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
		expect(await reviewContext.json()).toEqual(result);
		const reviewKey = randomUUID();
		const reviewed = await http(
			`/scores/${human.id}/reviews`,
			"reviewer",
			{ expectedRevision: saved.revision, result },
			reviewKey,
		);
		expect(
			await http(
				`/scores/${human.id}/reviews`,
				"reviewer",
				{ expectedRevision: saved.revision, result },
				reviewKey,
			),
		).toEqual(reviewed);
		const [audit] =
			await sql`select actor_id from platform.audit_events where action='evaluation.score.reviewed' and target_id=${human.id}`;
		expect(audit?.actor_id).toBe("reviewer");
		await worker.runOnce();
		expect(calls).toBe(2);
		expect(
			await sql`select id from platform.evaluation_sample_tasks where experiment_id=${experiment.experimentId}`,
		).toHaveLength(2);
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
		experimentPolicy = { ...original, variants: [] };
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
		const cancelled = await core.cancel(
			request("runner"),
			experiment.experimentId,
			randomUUID(),
		);
		expect(cancelled.status).toBe("cancelled");
		await expect(
			core.cancel(request("reviewer"), experiment.experimentId, randomUUID()),
		).rejects.toMatchObject({ code: "denied" });
	} finally {
		await query.close();
		await authority.close();
	}
}, 30000);
