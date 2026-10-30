import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createDeploymentModelCatalogAdapterV1 } from "@agent-infra/model-catalog";
import {
	createEvaluationDataV1,
	evaluationRetainedMetadataFieldsV1,
	parseEvaluationExperimentPolicyV1,
	parseEvaluationPolicyV1,
} from "@agent-infra/platform-core";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import { createRelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import { createRelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import { serve } from "@hono/node-server";
import { startMinioFileFixtureV1 } from "../../../packages/object-storage/src/minio.test-support.js";
import {
	type ConversationRuntimeEvent,
	createConversationDispatchUseCaseV1,
} from "../../../packages/platform-core/src/conversation-dispatch.js";
import { createConversationEventUseCaseV1 } from "../../../packages/platform-core/src/conversation-events.js";
import { FakeConversationRuntimeHostV1 } from "../../../packages/platform-core/src/fake-conversation-runtime-host.js";
import {
	readCurrentTaskApiUseGrantV1,
	readCurrentTaskApplicationV1,
} from "../../../packages/platform-store/src/application-task-authorization.js";
import { PostgresConversationDispatchStoreV1 } from "../../../packages/platform-store/src/conversation-dispatch.js";
import { PostgresConversationEventTransactionV1 } from "../../../packages/platform-store/src/conversation-events.js";
import { PostgresEvaluationDataStoreV1 } from "../../../packages/platform-store/src/evaluation-data.js";
import { PostgresEvaluationTaskAuthorityV1 } from "../../../packages/platform-store/src/evaluation-task-authority.js";
import {
	openPostgresTestClient,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { markSessionSandboxReadyFixture } from "../../../packages/platform-store/src/session-sandbox.fixture.js";
import { PostgresTaskAuthorizationStoreV1 } from "../../../packages/platform-store/src/task-authorization.js";
import { createConversationRuntimeV2 } from "../../platform-worker/src/conversation-runtime.js";
import { createEvaluationScoringWorkerV1 } from "../../platform-worker/src/evaluation-scoring-worker.js";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "../../platform-worker/src/kubernetes.fixture.js";
import { workloadResourceConfigurationHashV1 } from "../../platform-worker/src/workload-runtime.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi } from "./assembly.js";
import { waitForOwnedContainerNetworkReady } from "./evaluation-browser-network.js";

const roles = {
	manager: "eval-manager",
	runner: "eval-runner",
	grader: "eval-grader",
	reviewer: "eval-reviewer",
	analyst: "eval-analyst",
	owner: "eval-owner",
	outsider: "eval-outsider",
} as const;
type Role = keyof typeof roles;
const agentId = "evaluation-browser-agent";
const fixtureScope = "browser-evaluation";
const approvalId = "browser-synthetic";
const workerId = "evaluation-browser-worker";
const user = (userId: string) => ({
	schemaVersion: 1 as const,
	userId,
	accountStatus: "active" as const,
	organizationIds: [],
	authorizationRevision: "identity-1",
});
async function listen(server: Server) {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return originOf(server);
}
function originOf(server: Server | ReturnType<typeof serve>) {
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Fixture address unavailable");
	return `http://127.0.0.1:${address.port}`;
}
async function closeServer(
	server: Server | ReturnType<typeof serve> | undefined,
) {
	if (!server) return;
	if ("closeAllConnections" in server) server.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

/** Synthetic, test-only assembly. Tasks and scores use production stores/workers; the Runtime port is controlled. */
export async function startEvaluationWorkflowBrowserFixture() {
	const database = await startPostgresTestDatabase(
		"evaluation-workflow-browser",
	);
	const cleanup: Array<() => Promise<unknown>> = [() => database.stop()];
	let api: ReturnType<typeof serve> | undefined;
	let modelServer: Server | undefined;
	let closing: Promise<void> | undefined;
	let ticking: Promise<void> | undefined;
	let stopped = false;
	const close = () => {
		closing ??= (async () => {
			stopped = true;
			await ticking?.catch(() => {});
			const failures: unknown[] = [];
			for (const stop of [
				() => closeServer(api),
				...cleanup.reverse(),
				() => closeServer(modelServer),
			]) {
				try {
					await stop();
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length)
				throw new AggregateError(failures, "Fixture cleanup failed");
		})();
		return closing;
	};
	try {
		await migratePlatformDatabase(database);
		const sql = openPostgresTestClient(database, 4);
		const json = (value: unknown) => value as Parameters<typeof sql.json>[0];
		cleanup.push(() => sql.end());
		const objects = await startMinioFileFixtureV1("file", "eval");
		cleanup.push(() => objects.close());
		await waitForOwnedContainerNetworkReady([
			{ containerName: database.containerName },
			{ containerName: objects.containerName },
		]);
		const storage = objects.storage;
		const validUntil = new Date(Date.now() + 30 * 60000).toISOString();
		const retention = {
			contentMs: 1800000,
			metadataMs: 3600000,
			deleteWithinMs: 10000,
		};
		const policy = parseEvaluationPolicyV1({
			schemaVersion: 1,
			policyId: "browser-evaluation",
			revision: 1,
			validUntil,
			managers: [
				{
					principal: { kind: "user", id: roles.manager },
					scopes: [fixtureScope],
					operations: [
						"create",
						"import",
						"read",
						"run",
						"score",
						"review",
						"analyze",
						"manage_grants",
						"delete",
					],
					maxGrantMs: 1800000,
				},
			],
			retainedMetadataFields: evaluationRetainedMetadataFieldsV1,
			materialApprovals: [
				{
					approvalId,
					scope: fixtureScope,
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
			pendingMs: 300000,
		});
		const configuration = {
			schemaVersion: 1 as const,
			agentId,
			revision: 1,
			source: {
				kind: "standard" as const,
				templateId: "template_01",
				imageDigest: `sha256:${"a".repeat(64)}`,
				admissionRevision: "image_policy_1",
				allowedEnvironmentKeys: [],
				allowedSecretKeys: [],
				platformManagedKeys: [],
				connectionEnabled: false,
			},
			modelConfiguration: {
				catalogRevision: "browser-models",
				options: ["baseline", "candidate"].map((id) => ({
					optionId: `model_${id}`,
					endpointId: "model-endpoint",
					modelId: `synthetic-${id}`,
					reasoningLevels: ["low"],
					credential: { secretId: `secret_${id}`, version: 1, isSet: true },
				})),
				defaultOptionId: "model_baseline",
				defaultReasoningLevel: "low",
			},
			environment: [],
			secrets: [],
			channels: [],
			channelRevision: "channels_1",
			actions: [],
			actionSetRevision: "actions_1",
		};
		const scorerBase = {
			scorerId: "rule",
			version: "1",
			rubricId: "quality",
			minimum: 0,
			maximum: 1,
			passThreshold: 1,
			maxInputBytes: 65536,
			maxOutputBytes: 4096,
			timeoutMs: 5000,
			maxAttempts: 2,
			retryDelayMs: 1,
			datasetScopes: [fixtureScope],
		};
		const scorers = [
			{
				...scorerBase,
				scorerId: "rule",
				implementation: { kind: "rule", rule: "exact_match" },
			},
			{ ...scorerBase, scorerId: "human", implementation: { kind: "human" } },
			{
				...scorerBase,
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
		].map((entry) => ({
			...entry,
			configurationDigest: createHash("sha256")
				.update(JSON.stringify(entry))
				.digest("hex"),
		}));
		const experimentPolicy = parseEvaluationExperimentPolicyV1({
			schemaVersion: 1,
			policyId: policy.policyId,
			revision: 1,
			validUntil,
			maximumTasks: 100,
			maximumInputBytes: 65536,
			variants: ["baseline", "candidate"].map((variantId) => ({
				variantId,
				agentId,
				configurationRevision: 1,
				modelOptionId: `model_${variantId}`,
				reasoningLevel: "low",
				toolEnvironment: "synthetic-browser",
			})),
			scorers,
		});
		const analysisPolicy = {
			schemaVersion: 1 as const,
			policyId: "browser-analysis",
			revision: 1,
			validUntil,
			maximumWindowMs: 31 * 86400000,
			maximumTasks: 1000,
			maximumModelFacts: 10000,
			feedbackMetadataMs: 3600000,
		};
		const directory = { resolveUser: async (id: string) => user(id) };
		await sql`insert into platform.agents(id,current_configuration_revision,authorization_revision)values(${agentId},1,'agent-1')`;
		await sql`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration)values(${agentId},1,'template_01',clock_timestamp(),${sql.json(json(configuration))})`;
		await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence)values('evaluation-browser-application',${agentId},${roles.owner},'Evaluation workflow','Synthetic browser fixture','available','fixture','fixture',clock_timestamp(),1,1,'ready','running',1,1)`;
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at)values(${agentId},${roles.owner},clock_timestamp())`;
		for (const id of Object.values(roles).filter(
			(id) => id !== roles.outsider,
		)) {
			await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision)values(${agentId},'user',${id},'use','use-1')`;
			await sql`insert into platform.agent_availability(agent_id,target_type,target_id)values(${agentId},'user',${id})`;
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
		for (const purpose of ["agent-default", "personal"] as const) {
			const subjectId = purpose === "agent-default" ? agentId : roles.runner;
			const keyId = `browser-${purpose}`;
			const ciphertext = encryptor.encrypt({
				purpose,
				subjectId,
				keyId,
				keyVersion: 1,
				plaintext: "synthetic-browser-model-key",
			});
			await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version)values(${purpose},${subjectId},1,1)`;
			await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext)values(${purpose},${subjectId},1,${keyId},${sql.json(json(ciphertext))})`;
		}
		const desired = workloadDesiredFixture(1, agentId, "internal-only");
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
		await sql`insert into platform.workload_reconciliations(agent_id,revision,state,next_attempt_at)values(${agentId},1,${sql.json(json({ schemaVersion: 1, agentId, sourceConfigurationRevision: 1, sourceLifecycleRevision: 1, revision: 1, fence: 1, phase: "ready", candidate: version, verified: version, verifiedRevision: 1, identity: { uid: "browser-fixture-workload", generation: 1 }, rollback: false, failureCode: null, attempts: 0, capabilities: { attachments: false, resultFiles: false } }))},clock_timestamp())`;
		const unused = async (): Promise<never> => {
			throw new Error("Unconfigured fixture operation");
		};
		const identity = {
			...directory,
			resolve: async (request: Request) => {
				const id = /(?:^|;\s*)session=([^;]+)/.exec(
					request.headers.get("Cookie") ?? "",
				)?.[1];
				return id && Object.values(roles).some((role) => role === id)
					? { ...user(id), displayName: id, roles: ["employee" as const] }
					: null;
			},
			hydrateUsers: async (ids: readonly string[]) =>
				ids.map((id) => ({
					userId: id,
					displayName: id,
					roles: ["employee" as const],
				})),
		};
		const assembly = assemblePlatformApi({
			...database,
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 100,
				waitingTimeoutMs: 30000,
			},
			identity,
			directory: {
				identity,
				search: async ({ kind, query, ids, limit }) =>
					kind === "user"
						? Object.values(roles)
								.filter((id) =>
									ids.length
										? ids.includes(id)
										: id.includes(query.toLowerCase()),
								)
								.slice(0, limit)
								.map((id) => ({
									kind: "user" as const,
									canonicalId: id,
									displayName: id,
								}))
						: [],
			},
			evaluation: {
				storage,
				loadPolicy: async () => policy,
				loadExperimentPolicy: async () => experimentPolicy,
				loadAnalysisPolicy: async () => analysisPolicy,
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
			presentAgent: async ({ configuration: current }) => ({
				source: { kind: "standard", templateId: "template_01" },
				resourceProfile: {
					profileId: "standard",
					displayName: "Test",
					estimatedResources: {
						cpuMillicores: 100,
						memoryMiB: 128,
						storageGiB: 1,
					},
				},
				modelOptions: current.modelOptions.map((option) => ({
					optionId: option.optionId,
					modelId: option.modelId,
					displayName: option.modelId,
					reasoningLevels: [...option.reasoningLevels],
				})),
				channels: [{ kind: "web", status: "available" }],
				capabilities: {
					modelSelection: false,
					attachments: false,
					resultFiles: false,
					connection: false,
					supplementaryInstruction: false,
				},
				interactionUrl: null,
			}),
		});
		cleanup.push(() => assembly.close());
		api = serve({
			fetch: createPlatformApp(assembly.dependencies).fetch,
			hostname: "127.0.0.1",
			port: 0,
		});
		if (!api.listening)
			await new Promise<void>((resolve) => api?.once("listening", resolve));
		const origin = originOf(api);
		let modelCalls = 0;
		modelServer = createServer(async (request, response) => {
			for await (const _ of request) {
				/* Consume the real HTTP request before replying. */
			}
			if (
				request.headers.authorization !== "Bearer synthetic-browser-model-key"
			) {
				response.writeHead(403).end();
				return;
			}
			modelCalls++;
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					id: `synthetic-${modelCalls}`,
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
										reason: "Synthetic rubric judgment",
									}),
								},
							],
						},
					],
				}),
			);
		});
		const modelOrigin = await listen(modelServer);
		const scoring = createEvaluationScoringWorkerV1({
			...database,
			directory,
			storage,
			loadDataPolicy: async () => policy,
			loadExperimentPolicy: async () => experimentPolicy,
			taskPolicy: { maximumWaitingTasksPerAgent: 100, waitingTimeoutMs: 30000 },
			batchSize: 100,
			leaseMs: 30000,
			retryDelayMs: 1,
			catalog: createDeploymentModelCatalogAdapterV1({
				load: async () => ({
					schemaVersion: 1,
					revision: "score-catalog",
					validUntil: Date.parse(validUntil),
					endpoints: [
						{
							endpointId: "score-endpoint",
							baseUrl: modelOrigin,
							origin: modelOrigin,
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
		cleanup.push(() => scoring.close());
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
		cleanup.push(
			() => dispatchStore.close(),
			() => authStore.close(),
			() => authority.close(),
			() => eventTx.close(),
		);
		const signer = generateKeyPairSync("ed25519");
		const runtime = createConversationRuntimeV2({
			workerId,
			signing: {
				issuer: "fixture",
				workerId,
				keyId: "fixture",
				privateKey: signer.privateKey,
			},
			directory,
			taskAuthorizationStore: authStore,
			dispatchStore,
			channelAuthorizationCurrent: (record) =>
				record.boundary.channelId === "eval"
					? authority.current(record.boundary)
					: Promise.resolve(true),
			resolveCurrentApplication: (applicationId, selectedAgentId) =>
				sql.begin((tx) =>
					readCurrentTaskApplicationV1(tx, {
						applicationId,
						agentId: selectedAgentId,
					}),
				),
			resolveCurrentApiUseGrant: (principal, selectedAgentId) =>
				sql.begin((tx) =>
					readCurrentTaskApiUseGrantV1(tx, {
						principal,
						agentId: selectedAgentId,
					}),
				),
			resolveRuntimeHost: unused,
		});
		const host = new FakeConversationRuntimeHostV1();
		const events = new Map<string, ConversationRuntimeEvent[]>();
		const dispatch = createConversationDispatchUseCaseV1({
			store: dispatchStore,
			authorization: runtime.authorization,
			runtimeHost: {
				dispatch: async (request) => {
					const startedAt = new Date().toISOString();
					const optionId = request.selection?.modelOptionId ?? "model_baseline";
					const option = configuration.modelConfiguration.options.find(
						(item) => item.optionId === optionId,
					);
					if (!option) throw new Error("Unapproved fixture model");
					const records: ConversationRuntimeEvent[] = (
						["intent", "started", "completed"] as const
					).map((phase, index) => ({
						schemaVersion: 2,
						type: "operation",
						executionId: request.executionId,
						adapterEventKey: `${request.executionId}-model-${phase}`,
						cursor: `model-${index}`,
						occurredAt: startedAt,
						payload: {
							kind: "model",
							phase,
							operationRef: `model-${request.executionId}`,
							attemptRef: `attempt-${request.executionId}`,
							...(phase !== "intent" ? { startedAt } : {}),
							...(phase === "completed"
								? {
										finishedAt: startedAt,
										durationMs: 0,
										usage: { inputTokens: 2, outputTokens: 1 },
									}
								: {}),
							model: {
								configVersion: "1",
								modelOptionId: option.optionId,
								modelId: option.modelId,
								reasoningLevel: "low",
							},
						},
					}));
					records.push(
						{
							schemaVersion: 1,
							type: "text",
							executionId: request.executionId,
							adapterEventKey: `${request.executionId}-text`,
							cursor: "text",
							occurredAt: startedAt,
							payload: { delta: "yes" },
						},
						{
							schemaVersion: 1,
							type: "completed",
							executionId: request.executionId,
							adapterEventKey: `${request.executionId}-complete`,
							cursor: "complete",
							occurredAt: new Date().toISOString(),
							payload: { status: "completed" },
						},
					);
					events.set(request.executionId, records);
					return host.dispatch(request);
				},
				recoverStatus: host.recoverStatus.bind(host),
				async *events(request) {
					yield* events.get(request.executionId) ?? [];
				},
			},
			events: createConversationEventUseCaseV1({ transaction: eventTx }),
		});
		const tick = () => {
			if (stopped) return Promise.reject(new Error("Fixture is closed"));
			ticking ??= (async () => {
				const due = await sql<
					{ id: string; scope_id: string }[]
				>`select id,scope_id from platform.outbox_items where operation='conversation.turn.submit.v1' and status in ('pending','retry_scheduled') order by created_at,id limit 101`;
				if (due.length > 100) throw new Error("Fixture Task budget exceeded");
				for (const item of due) {
					await markSessionSandboxReadyFixture(sql, item.scope_id);
					const result = await dispatch.dispatch({
						schemaVersion: 1,
						itemId: item.id,
						workerId,
					});
					if (!["accepted", "recovered", "idle"].includes(result.outcome))
						throw new Error(`Fixture dispatch ${result.outcome}`);
				}
				await scoring.runOnce();
			})().finally(() => {
				ticking = undefined;
			});
			return ticking;
		};
		const dataStore = new PostgresEvaluationDataStoreV1({
			...database,
			directory,
		});
		cleanup.push(() => dataStore.close());
		const data = createEvaluationDataV1({
			store: dataStore,
			loadPolicy: async () => policy,
			storage,
		});
		const request = (role: Role) => ({
			authentication: { kind: "browser" as const, userId: roles[role] },
			requestId: randomUUID(),
			traceId: randomUUID(),
		});
		const content = {
			schemaVersion: 1,
			provenance: { approvalId },
			samples: [
				{
					id: "answer",
					input: "Synthetic question",
					context: null,
					taskType: "answer",
					expectedResult: "yes",
				},
			],
			rubric: [{ id: "quality", description: "Answer yes" }],
		};
		const dataset = await data.create(request("manager"), randomUUID(), {
			name: "Browser workflow dataset",
			scope: fixtureScope,
		});
		const reserved = await data.reserve(
			request("manager"),
			randomUUID(),
			dataset.datasetId,
			{ expectedRevision: dataset.revision, sourceVersionId: null },
		);
		let revision = 2;
		const grant = async (
			role: Role,
			operations: Array<
				"import" | "read" | "run" | "score" | "review" | "analyze" | "delete"
			>,
		) =>
			data.grant(request("manager"), randomUUID(), dataset.datasetId, {
				expectedRevision: revision++,
				principal: { kind: "user", id: roles[role] },
				versionIds: [reserved.versionId],
				operations,
				expiresAt: validUntil,
			});
		await grant("manager", ["import", "read", "delete"]);
		await data.upload(
			request("manager"),
			randomUUID(),
			dataset.datasetId,
			reserved.versionId,
			new TextEncoder().encode(JSON.stringify(content)),
		);
		await grant("runner", ["run", "score"]);
		await grant("grader", ["score"]);
		await grant("reviewer", ["review"]);
		await grant("analyst", ["analyze"]);
		async function createOnlineTask() {
			const headers = {
				Cookie: `session=${roles.runner}`,
				"Content-Type": "application/json",
				"Idempotency-Key": randomUUID(),
			};
			const created = await fetch(
				`${origin}/api/v1/agents/${agentId}/conversations`,
				{ method: "POST", headers, body: JSON.stringify({ schemaVersion: 1 }) },
			);
			if (created.status !== 201)
				throw new Error(`Fixture online conversation ${created.status}`);
			const conversation = (await created.json()) as { conversationId: string };
			await markSessionSandboxReadyFixture(sql, conversation.conversationId);
			const submitted = await fetch(
				`${origin}/api/v1/conversations/${conversation.conversationId}/messages`,
				{
					method: "POST",
					headers: { ...headers, "Idempotency-Key": randomUUID() },
					body: JSON.stringify({
						schemaVersion: 1,
						text: "Synthetic feedback task",
					}),
				},
			);
			if (submitted.status !== 202) {
				const failure = (await submitted.json()) as { code?: unknown };
				throw new Error(
					`Fixture online Task ${submitted.status} ${typeof failure.code === "string" ? failure.code : "unknown"}`,
				);
			}
			const accepted = (await submitted.json()) as { executionId: string };
			await tick();
			return {
				conversationId: conversation.conversationId,
				executionId: accepted.executionId,
			};
		}
		return {
			origin,
			roles,
			agentId,
			fixtureScope,
			approvalId,
			content,
			datasetId: dataset.datasetId,
			versionId: reserved.versionId,
			tick,
			createOnlineTask,
			close,
			modelCalls: () => modelCalls,
			runtimeCalls: () => host.sideEffectCount(),
		};
	} catch (error) {
		await close();
		throw error;
	}
}
