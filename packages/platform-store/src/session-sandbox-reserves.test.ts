import { createHash } from "node:crypto";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	createFakeModelCatalogAdapterV1,
	projectRuntimeModelConfigurationV4,
} from "@agent-infra/model-catalog";
import {
	type ConversationExecutionAuthorityV1,
	createConversationExecutionUseCaseV1,
	createConversationTaskAdmissionUseCaseV1,
	decodeAgentConfigurationRecordV3,
	type SessionSandboxReserveConfigurationV1,
	type SessionSandboxReserveOperationInputV1,
	sessionSandboxReserveResourceKindsV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { createPlatformSessionReserveWorkerV1 } from "../../../apps/platform-worker/src/session-reserve-worker.js";
import { catalogFixture } from "../../model-catalog/src/catalog.fixture.js";
import { PostgresAgentConfigurationQueryV1 } from "./agent-configuration.query.js";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import {
	claimSandboxReconciliation,
	recordSandboxExecutorRetirement,
	recordSandboxExecutorStartup,
	recordSandboxObservation,
} from "./session-sandbox-reconciliation.js";
import {
	PostgresSessionSandboxReserveStoreV1,
	releaseSessionSandboxComputeBudgetV1,
	reserveSessionSandboxPreparationBudgetV1,
} from "./session-sandbox-reserves.js";

const imageDigest = `sha256:${"a".repeat(64)}`;
const resourceHash = "b".repeat(64);
const resources = { cpuMillis: 1000, memoryBytes: 1024, storageBytes: 2048 };
const config: SessionSandboxReserveConfigurationV1 = {
	schemaVersion: 1,
	enabled: true,
	revision: 1,
	namespace: "reserve-test",
	totalBudget: { cpuMillis: 10000, memoryBytes: 10240, storageBytes: 20480 },
	resourceCosts: [{ resourceConfigurationHash: resourceHash, resources }],
	maximumReserves: 4,
	maximumConcurrentCreates: 2,
	ttlMs: 60000,
	cooldownMs: 1000,
	failureBackoffMs: 1000,
	profiles: [
		{
			agentId: "agent",
			templateId: "codex",
			imageDigest,
			resourceConfigurationHash: resourceHash,
			resources,
			storageConfigurationVersion: "storage-v1",
			networkPolicyVersion: "network-v1",
			signingConfigurationVersion: "signing-v1",
			transportConfigurationVersion: "transport-v1",
			connectionConfigurationVersion: "connection-v1",
			minimum: 1,
			maximum: 4,
		},
	],
};
const directory: TaskUserDirectoryV1 = {
	async resolveUser(userId) {
		return {
			schemaVersion: 1,
			userId,
			accountStatus: "active",
			organizationIds: [],
			authorizationRevision: "user-1",
		};
	},
};
function authority(
	actorId = "user-a",
	channelId = "web",
): ConversationExecutionAuthorityV1 {
	return {
		schemaVersion: 1,
		actorId,
		agentId: "agent",
		channelId,
		authorizationRevision: "agent-1",
		supportsSupplementaryInstruction: false,
		taskBoundary: {
			schemaVersion: 1,
			principal: { kind: "user", id: actorId },
			agentId: "agent",
			channelId,
			identityRevision: "user-1",
			agentAuthorizationRevision: "agent-1",
			accessSources: [{ kind: "owner", userId: actorId }],
		},
	};
}
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
const stores: { close(): Promise<void> }[] = [];
function reserves(configuration = config) {
	const store = new PostgresSessionSandboxReserveStoreV1({
		databaseUrl: database.databaseUrl,
		configuration,
	});
	stores.push(store);
	return store;
}
function execution(
	configuration: SessionSandboxReserveConfigurationV1 | null = config,
) {
	const store = new PostgresConversationExecutionTransactionV1({
		databaseUrl: database.databaseUrl,
		userDirectory: directory,
		sessionSandboxReserves: configuration ?? undefined,
	});
	stores.push(store);
	return store;
}
function create(
	store = execution(),
	actorId = "user-a",
	channelId = "web",
	key = "create",
) {
	return createConversationExecutionUseCaseV1({
		transaction: store,
		authorization: {
			authorize: async () => ({
				outcome: "allowed",
				authority: authority(actorId, channelId),
			}),
		},
	}).createConversation({
		schemaVersion: 1,
		agentId: "agent",
		idempotencyKey: key,
		requestId: "request",
		traceId: "trace",
	});
}
async function prepared(store = reserves()) {
	const sandboxId = await store.prepare("agent");
	expect(sandboxId).toBeTypeOf("string");
	const lease = await store.claimLease({
		sandboxId: sandboxId as string,
		workerId: "worker-a",
		leaseDurationMs: 30000,
	});
	if (!lease) throw new Error("Expected reserve lease");
	for (const kind of sessionSandboxReserveResourceKindsV1) {
		const intent: SessionSandboxReserveOperationInputV1 = {
			attemptId: `create-${kind}`,
			operation: "create",
			kind,
			name: `sandbox-${sandboxId}`,
			status: "pending",
			resource: null,
			absent: false,
		};
		expect(await store.recordIntent(lease, intent)).toBe(true);
		expect(
			await store.recordCreateResponse(lease, {
				attemptId: intent.attemptId,
				response: "created",
				resource: {
					kind,
					name: intent.name,
					namespace: config.namespace,
					uid: `${kind}-uid-${sandboxId}`,
					resourceVersion: "1",
				},
			}),
		).toBe(true);
	}
	return {
		store,
		lease,
		sandboxId: sandboxId as string,
		sessionId: lease.sessionId,
	};
}
async function ready(store = reserves()) {
	const reserve = await prepared(store);
	expect(
		await store.markReady(reserve.lease, {
			bootstrapReady: true,
			businessStateAbsent: true,
		}),
	).toBe(true);
	return reserve;
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("reserves-3777");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 10, onnotice: () => {} });
}, 120000);
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
});
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});
async function seedReserveAgent(
	template: "codex" | "claude" | "pi" | "opencode" = "codex",
	paseoPod = template !== "codex",
	withBrowser = false,
) {
	await sql`truncate platform.agents, platform.conversations, platform.platform_applications, platform.platform_api_credentials, platform.relay_key_subjects cascade`;
	await sql`truncate platform.outbox_items, platform.idempotency_records, platform.audit_events, platform.session_sandbox_reserves, platform.session_sandbox_budgets, platform.session_sandbox_resource_charges, platform.platform_user_disables`;
	const configuration = decodeAgentConfigurationRecordV3({
		schemaVersion: 3,
		agentId: "agent",
		revision: 1,
		source: {
			kind: "standard",
			templateId: template,
			imageDigest,
			admissionRevision: "admitted",
			allowedEnvironmentKeys: [],
			allowedSecretKeys: [],
			platformManagedKeys: [],
			connectionEnabled: false,
		},
		modelConfiguration: {
			catalogRevision: "catalog-a",
			options: [
				{
					optionId: "primary",
					endpointId: "endpoint-a",
					modelId: "model-a",
					reasoningLevels: ["high"],
				},
			],
			defaultOptionId: "primary",
			defaultReasoningLevel: "high",
		},
		environment: [],
		secrets: [],
		channels: [],
		channelRevision: "channels-a",
	});
	const projection = await projectRuntimeModelConfigurationV4({
		configuration,
		catalog: createFakeModelCatalogAdapterV1(
			template !== "codex"
				? {
						...catalogFixture(),
						endpoints: catalogFixture().endpoints.map((e) => ({
							...e,
							protocol: "anthropic-messages-v1" as const,
							authentication: "bearer" as const,
						})),
					}
				: catalogFixture(),
		),
		standardTemplateBinding: {
			templateId: template,
			imageDigest,
			driver: template === "opencode" ? "acp" : template,
			protocol:
				template !== "codex" ? "anthropic-messages-v1" : "openai-responses-v1",
			...(paseoPod ? { transport: "paseo-sdk-pod" as const } : {}),
		},
		signal: AbortSignal.timeout(1000),
	});
	const manifest = {
		schemaVersion: 1,
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 8080 },
		health: { path: "/healthz" },
		...(withBrowser
			? {
					capabilities: {
						modelSelection: false,
						attachments: false,
						resultFiles: false,
						connection: false,
						supplementaryInstruction: false,
						browser: {
							schemaVersion: 1,
							capabilityVersion: 1,
							operations: ["navigate", "observe", "interact"],
							policy: {
								allowedOrigins: ["https://example.test/"],
								maxContexts: 1,
								maxTabs: 1,
								maxPages: 1,
								maxViewportWidth: 1280,
								maxViewportHeight: 800,
								maxConcurrentActions: 1,
								maxDownloads: 0,
								maxDownloadBytes: 0,
								maxUploadBytes: 0,
								maxScreenshotBytes: 0,
								maxBrowserDurationMs: 60_000,
								maxRetainedProfileBytes: 1048576,
								navigationTimeoutMs: 5000,
								actionTimeoutMs: 5000,
								requireSideEffectConfirmation: true,
								allowUserHandoff: false,
							},
						},
					},
				}
			: {}),
	};
	const deployment = validateAgentWorkloadDesiredV1({
		schemaVersion: 1,
		requestId: "request",
		traceId: "trace",
		agentId: "agent",
		configRevision: 1,
		workloadRevision: 1,
		fence: 1,
		expectedWorkload: { state: "absent" },
		namespaceRef: "test",
		desiredState: "running",
		replicas: 1,
		imageDigest,
		registryAdmission: {
			schemaVersion: 1,
			immutableDigest: imageDigest,
			runtimeManifest: manifest,
			policyEvidence: {
				schemaVersion: 1,
				policyRef: "policy",
				decisionRef: "decision",
				subjectRef: "subject",
				agentId: "agent",
				imageDigest,
				evaluatedAt: "2026-09-07T00:00:00Z",
			},
			runtimeManifestParsingEvidence: {
				schemaVersion: 1,
				labelName: "io.agora.agent.runtime.manifest",
				utf8ByteLength: 128,
				maxDepth: 3,
				duplicateKeysDetected: false,
				unknownFieldsDetected: false,
			},
		},
		runtimeManifest: manifest,
		resourceProfileRef: "standard",
		env: { LOG_LEVEL: "info" },
		service: { name: "agent", port: 8080 },
		health: { path: "/healthz", timeoutSeconds: 5, failureThreshold: 3 },
		persistentVolume: {
			name: "data",
			mountPath: "/workspace",
			storageProfileRef: "persistent",
			accessMode: "ReadWriteOnce",
			retention: "retain",
		},
		serviceAccount: { name: "agent", kubernetesApiAccess: false },
		networkPolicy: {
			deploymentPolicyRef: "isolated",
			ingressMode: "runtime-host-client-only",
			kubernetesApiAccess: false,
			platformDatabaseAccess: false,
			connectionDatabaseAccess: false,
			decryptionKeyringAccess: false,
		},
		route: { name: "agent", exposure: "internal-only", tlsRequired: true },
		secretRefs: [],
	});
	const version = {
		configuration,
		deployment,
		modelProjection: projection,
		executionCapacity: {
			schemaVersion: 1,
			imageDigest,
			resourceProfileRef: "standard",
			resourceConfigurationHash: resourceHash,
			maximumConcurrentExecutions: 8,
			conformanceEvidenceHash: "c".repeat(64),
		},
	};
	const state = {
		schemaVersion: 1,
		agentId: "agent",
		sourceConfigurationRevision: 1,
		sourceLifecycleRevision: 1,
		revision: 1,
		fence: 1,
		phase: "ready",
		candidate: version,
		verified: version,
		verifiedRevision: 1,
		identity: { uid: "workload-agent", generation: 1 },
		rollback: false,
		failureCode: null,
		attempts: 0,
	};
	await sql`insert into platform.agents(id,current_configuration_revision,authorization_revision) values('agent',1,'agent-1')`;
	await sql`insert into platform.agent_configuration_revisions(agent_id,revision,runtime_revision,source_reference,created_at,configuration) values('agent',1,1,${template},now(),${sql.json(configuration as unknown as postgres.JSONValue)})`;
	await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,service_availability,workload_revision,fence) values('application','agent','user-a','Agent','Synthetic','available','trace','request',now(),1,1,'running','ready',1,1)`;
	for (const user of ["user-a", "user-b"])
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values('agent',${user},now())`;
	await sql`insert into platform.workload_reconciliations(agent_id,revision,state,next_attempt_at) values('agent',1,${sql.json(state as unknown as postgres.JSONValue)},now())`;
}
beforeEach(() => seedReserveAgent());

describe("real PostgreSQL reserve/Conversation transactions", () => {
	it("creates a cold Pi browser Session even when its Agent has an approved reserve profile", async () => {
		await seedReserveAgent("pi", true, true);
		const configuration = {
			...config,
			profiles: config.profiles.map((profile) => ({
				...profile,
				templateId: "pi",
			})),
		};
		expect(await reserves(configuration).prepare("agent")).toBeNull();
		const cold = await create(
			execution(configuration),
			"user-a",
			"web",
			"browser-session",
		);
		expect(cold.outcome).toBe("accepted");
		expect(
			await sql`select sandbox_id from platform.session_sandbox_reserves`,
		).toHaveLength(0);
	});

	it.each(["pi", "opencode", "claude", "codex"] as const)(
		"binds the verified %s deployment to cold and prewarmed sessions after a creator edit",
		async (template) => {
			await seedReserveAgent(template, true);
			const previous = process.env.PLATFORM_MAINTENANCE_CONSUMER_IMAGE;
			const images = [
				`registry.example.test/runtime/${template}@${imageDigest}`,
				`sha256:${"0".repeat(64)}`,
			].join(",");
			process.env.PLATFORM_MAINTENANCE_CONSUMER_IMAGE = images;
			try {
				const configuration = {
					...config,
					profiles: config.profiles.map((p) => ({
						...p,
						templateId: template,
					})),
				};
				const query = new PostgresAgentConfigurationQueryV1({
					databaseUrl: database.databaseUrl,
				});
				stores.push(query);
				expect(await query.supportsMaintenanceConsumer("agent", images)).toBe(
					true,
				);
				expect(
					await query.supportsMaintenanceConsumer(
						"agent",
						`unversioned,registry.example.test/runtime@${imageDigest}`,
					),
				).toBe(false);
				expect(
					await query.supportsMaintenanceConsumer("agent", imageDigest),
				).toBe(true);
				expect(
					await query.supportsMaintenanceConsumer("foreign-agent", images),
				).toBe(false);
				expect(
					await query.supportsMaintenanceConsumer(
						"agent",
						`sha256:${"0".repeat(64)}`,
					),
				).toBe(false);
				const prewarmed = await ready(reserves(configuration));
				const [row] = await sql<
					{ maintenance_directory_id: string }[]
				>`update platform.agents set maintenance_activated_at=clock_timestamp() where id='agent' returning maintenance_directory_id`;
				const admitted = await create(
					execution(configuration),
					"user-b",
					"web",
					"after-first-edit",
				);
				expect(admitted).toMatchObject({
					outcome: "accepted",
					result: { conversationId: prewarmed.sessionId },
				});
				const [binding] =
					await sql`select maintenance_directory_id from platform.session_sandbox_allocations where sandbox_id=${prewarmed.sandboxId}`;
				expect(binding?.maintenance_directory_id).toBe(
					row?.maintenance_directory_id,
				);
				const cold = await create(
					execution(configuration),
					"user-b",
					"web",
					"cold-after-edit",
				);
				if (cold.outcome !== "accepted")
					throw new Error("Expected cold Conversation");
				expect(cold.result.conversationId).not.toBe(prewarmed.sessionId);
				const [allocation] =
					await sql`select maintenance_directory_id, maintenance_view_enabled from platform.session_sandbox_allocations where conversation_id=${cold.result.conversationId}`;
				expect(allocation).toMatchObject({
					maintenance_directory_id: row?.maintenance_directory_id,
					maintenance_view_enabled: true,
				});
			} finally {
				if (previous === undefined)
					delete process.env.PLATFORM_MAINTENANCE_CONSUMER_IMAGE;
				else process.env.PLATFORM_MAINTENANCE_CONSUMER_IMAGE = previous;
			}
		},
	);

	it("keeps reserves separate and atomically adopts final IDs/UIDs/fences once under same-key concurrency", async () => {
		const reserve = await ready();
		expect(await sql`select 1 from platform.conversations`).toHaveLength(0);
		expect(
			await sql`select 1 from platform.session_sandbox_allocations`,
		).toHaveLength(0);
		const store = execution();
		const results = await Promise.all(
			Array.from({ length: 8 }, () => create(store)),
		);
		expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(1);
		expect(results.filter((r) => r.outcome === "replayed")).toHaveLength(7);
		for (const result of results)
			expect(result).toMatchObject({
				result: { conversationId: reserve.sessionId },
			});
		const [allocation] =
			await sql`select * from platform.session_sandbox_allocations`;
		expect(allocation).toMatchObject({
			sandbox_id: reserve.sandboxId,
			conversation_id: reserve.sessionId,
			session_generation: "1",
			resource_fence: "1",
			status: "allocated",
		});
		expect(allocation?.resource_observation.resources).toHaveLength(6);
		expect(
			await reserve.store.recordIntent(reserve.lease, {
				attemptId: "stale",
				operation: "delete",
				kind: "Pod",
				name: `sandbox-${reserve.sandboxId}`,
				status: "pending",
				resource: allocation?.resource_observation.resources[0],
				absent: false,
			}),
		).toBe(false);
		expect(await reserve.store.retire(reserve.sandboxId)).toBe(false);
	});
	it("gives different authorized users only one reserve and isolates the other cold allocation", async () => {
		const reserve = await ready();
		const results = await Promise.all([
			create(execution(), "user-a"),
			create(execution(), "user-b"),
		]);
		expect(results.every((r) => r.outcome === "accepted")).toBe(true);
		const rows =
			await sql`select * from platform.session_sandbox_allocations order by actor_id`;
		expect(rows).toHaveLength(2);
		expect(rows.filter((r) => r.sandbox_id === reserve.sandboxId)).toHaveLength(
			1,
		);
		expect(new Set(rows.map((r) => r.conversation_id)).size).toBe(2);
	});
	it.each(["web", "wecom_bot:synthetic"])(
		"rolls claim back with failed original %s outbox transaction",
		async (channel) => {
			const reserve = await ready();
			await sql`create function platform.reserve_test_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic rollback'; end $$`;
			await sql`create trigger reserve_test_failure before insert on platform.outbox_items for each row execute function platform.reserve_test_failure()`;
			try {
				await expect(create(execution(), "user-a", channel)).rejects.toThrow();
			} finally {
				await sql`drop trigger reserve_test_failure on platform.outbox_items`;
				await sql`drop function platform.reserve_test_failure()`;
			}
			expect(
				await sql`select status from platform.session_sandbox_reserves`,
			).toEqual([{ status: "ready" }]);
			expect(await sql`select 1 from platform.conversations`).toHaveLength(0);
			expect(
				await sql`select 1 from platform.idempotency_records`,
			).toHaveLength(0);
			expect(await create(execution(), "user-a", channel)).toMatchObject({
				outcome: "accepted",
				result: { conversationId: reserve.sessionId },
			});
		},
	);
	it("keeps an Agent with a current Owner manual association off reserves (#4199 C2)", async () => {
		const associate = (ownerId: string) =>
			sql`insert into platform.connection_manual_associations(agent_id,connection_agent_id,credential_fingerprint,association_revision,owner_id,credential_ciphertext,verified_at) values ('agent','connection-agent',${"c".repeat(64)},1,${ownerId},${sql.json({ schemaVersion: 1, agentId: "agent", ownerId, secretVersion: 1, crypto: { dekFingerprint: "d".repeat(64) } })},now())`;
		await sql`insert into platform.connection_association_generations(agent_id,last_revision) values ('agent',1)`;
		// A ready reserve made before the association. Whether the Worker had a publication
		// contract then is not part of any profile, so the reserve cannot prove the Host
		// declaration a new Session of an associated Agent needs.
		const before = await ready();
		await associate("user-a");
		// The Agent is not reserve-eligible: no new reserve, and a new Session takes the
		// cold path (the Worker decides the declaration at claim time).
		expect(await reserves().prepare("agent")).toBeNull();
		const cold = await create(execution(), "user-a", "web", "create-1");
		expect(cold.outcome).toBe("accepted");
		expect(cold).not.toMatchObject({
			result: { conversationId: before.sessionId },
		});
		expect(
			await sql`select status from platform.session_sandbox_reserves where sandbox_id = ${before.sandboxId}`,
		).toEqual([{ status: "ready" }]);
		// When the association no longer counts (Owner replaced; replaceAgentAccess leaves the
		// row) the Agent is reserve-eligible again and the same reserve is claimed.
		await sql.begin(async (tx) => {
			await tx`delete from platform.agent_owners where agent_id = 'agent'`;
			await tx`insert into platform.agent_owners(agent_id,owner_id,created_at) values ('agent','user-b',now())`;
		});
		expect(
			await create(execution(), "user-b", "web", "create-2"),
		).toMatchObject({
			outcome: "accepted",
			result: { conversationId: before.sessionId },
		});
	});
	it("refuses a disabled user or changed full env profile before claim", async () => {
		const reserve = await ready();
		await sql`insert into platform.platform_user_disables(user_id) values('user-a')`;
		expect(await create()).toEqual({ outcome: "denied" });
		await sql`delete from platform.platform_user_disables`;
		await sql`update platform.workload_reconciliations set state = jsonb_set(state, '{verified,deployment,env,LOG_LEVEL}', '"debug"')`;
		const result = await create();
		expect(result.outcome).toBe("accepted");
		expect(result).not.toMatchObject({
			result: { conversationId: reserve.sessionId },
		});
		expect(
			await sql`select status from platform.session_sandbox_reserves`,
		).toEqual([{ status: "ready" }]);
	});
	it("unknown create cannot become ready or release budget on absence, and retirement defeats stale create leases", async () => {
		const store = reserves();
		const sandboxId = await store.prepare("agent");
		if (!sandboxId) throw new Error();
		const lease = await store.claimLease({
			sandboxId,
			workerId: "old",
			leaseDurationMs: 30000,
		});
		if (!lease) throw new Error();
		const op: SessionSandboxReserveOperationInputV1 = {
			attemptId: "pod-create",
			operation: "create",
			kind: "Pod",
			name: `sandbox-${sandboxId}`,
			status: "pending",
			resource: null,
			absent: false,
		};
		expect(await store.recordIntent(lease, op)).toBe(true);
		expect(await store.recordResult(lease, { ...op, status: "unknown" })).toBe(
			true,
		);
		expect(
			await store.markReady(lease, {
				bootstrapReady: true,
				businessStateAbsent: true,
			}),
		).toBe(false);
		expect(await store.retire(sandboxId)).toBe(true);
		expect(
			await store.recordResult(lease, {
				...op,
				status: "confirmed",
				absent: true,
			}),
		).toBe(false);
		const cleanup = await store.claimLease({
			sandboxId,
			workerId: "cleanup",
			leaseDurationMs: 30000,
		});
		if (!cleanup) throw new Error();
		expect(
			await store.recordResult(cleanup, {
				...op,
				status: "confirmed",
				absent: true,
			}),
		).toBe(false);
		expect(await store.finishRetirement(cleanup)).toBe(false);
		expect(
			await sql`select released from platform.session_sandbox_resource_charges`,
		).toEqual([{ released: false }]);
	});
	it("restores an unknown reserve to preparing only after every original create response settles", async () => {
		const store = reserves();
		const sandboxId = await store.prepare("agent");
		if (!sandboxId) throw new Error();
		const lease = await store.claimLease({
			sandboxId,
			workerId: "late-response",
			leaseDurationMs: 30000,
		});
		if (!lease) throw new Error();
		const operation: SessionSandboxReserveOperationInputV1 = {
			attemptId: "late-pod",
			operation: "create",
			kind: "Pod",
			name: `sandbox-${sandboxId}`,
			status: "pending",
			resource: null,
			absent: false,
		};
		expect(await store.recordIntent(lease, operation)).toBe(true);
		expect(
			await store.recordResult(lease, { ...operation, status: "unknown" }),
		).toBe(true);
		expect(
			await store.recordCreateResponse(lease, {
				attemptId: operation.attemptId,
				response: "created",
				resource: {
					kind: "Pod",
					name: operation.name,
					namespace: config.namespace,
					uid: "late-pod-uid",
					resourceVersion: "7",
				},
			}),
		).toBe(true);
		expect(
			await sql`select status from platform.session_sandbox_reserves`,
		).toEqual([{ status: "preparing" }]);
	});
	it("accepts late original responses after lease takeover without restoring the original writer's authority", async () => {
		const store = reserves();
		const sandboxId = await store.prepare("agent");
		if (!sandboxId) throw new Error("Expected reserve");
		const original = await store.claimLease({
			sandboxId,
			workerId: "original-writer",
			leaseDurationMs: 30000,
		});
		if (!original) throw new Error("Expected original lease");
		const intents: SessionSandboxReserveOperationInputV1[] =
			sessionSandboxReserveResourceKindsV1.map((kind) => ({
				attemptId: `late-${kind}`,
				operation: "create",
				kind,
				name: `sandbox-${sandboxId}`,
				status: "pending",
				resource: null,
				absent: false,
			}));
		for (const intent of intents) {
			expect(await store.recordIntent(original, intent)).toBe(true);
			expect(
				await store.recordResult(original, { ...intent, status: "unknown" }),
			).toBe(true);
		}
		await sql`update platform.session_sandbox_reserves set lease_expires_at = clock_timestamp() - interval '1 second' where sandbox_id = ${sandboxId}`;
		const current = await store.claimLease({
			sandboxId,
			workerId: "recovery-writer",
			leaseDurationMs: 30000,
		});
		if (!current) throw new Error("Expected recovery lease");
		expect(current.deliveryFence).toBeGreaterThan(original.deliveryFence);
		expect(await store.renewLease(original, 30000)).toBe(false);
		for (const [index, intent] of intents.entries()) {
			const resource = {
				kind: intent.kind,
				name: intent.name,
				namespace: config.namespace,
				uid: `${intent.kind}-late-uid`,
				resourceVersion: "2",
			};
			expect(await store.recordObservation(original, resource)).toBe(false);
			expect(await store.recordObservation(current, resource)).toBe(true);
			expect(
				await store.markReady(current, {
					bootstrapReady: true,
					businessStateAbsent: true,
				}),
			).toBe(false);
			expect(
				await store.recordCreateResponse(current, {
					attemptId: intent.attemptId,
					response: "created",
					resource,
				}),
			).toBe(false);
			expect(
				await store.recordCreateResponse(original, {
					attemptId: intent.attemptId,
					response: "created",
					resource,
				}),
			).toBe(true);
			expect((await store.inspect(sandboxId))?.status).toBe(
				index === intents.length - 1 ? "preparing" : "unknown",
			);
		}
		expect(
			await store.markReady(original, {
				bootstrapReady: true,
				businessStateAbsent: true,
			}),
		).toBe(false);
		expect(
			await store.markReady(current, {
				bootstrapReady: true,
				businessStateAbsent: true,
			}),
		).toBe(true);
		expect(await create()).toMatchObject({
			outcome: "accepted",
			result: { conversationId: original.sessionId },
		});
	});
	it.each(["disabled", "profile-drift"])(
		"does not mark completed creates ready after %s",
		async (change) => {
			const reserve = await prepared();
			let store = reserve.store;
			if (change === "disabled") {
				store = reserves({ ...config, enabled: false, revision: 2 });
				await store.applyConfiguration();
				await expect(reserve.store.prepare("agent")).rejects.toThrow();
			} else {
				await sql`update platform.workload_reconciliations set state = jsonb_set(state, '{verified,deployment,env,LOG_LEVEL}', '"debug"')`;
			}
			expect(
				await store.markReady(reserve.lease, {
					bootstrapReady: true,
					businessStateAbsent: true,
				}),
			).toBe(false);
			expect((await store.inspect(reserve.sandboxId))?.status).toBe(
				"preparing",
			);
			expect(
				await sql`select released from platform.session_sandbox_resource_charges where sandbox_id = ${reserve.sandboxId}`,
			).toEqual([{ released: false }]);
		},
	);
	it("keeps read-only inspection lease-free and paginates old reserves while disabled", async () => {
		const store = reserves();
		const first = await store.prepare("agent");
		const second = await store.prepare("agent");
		if (!first || !second) throw new Error();
		const inspection = await store.inspect(first);
		expect(inspection).toMatchObject({
			sandboxId: first,
			status: "preparing",
			currentProfileDigest: inspection?.profile.digest,
		});
		expect(inspection).not.toHaveProperty("leaseOwner");
		expect(inspection).not.toHaveProperty("deliveryFence");
		const disabled = reserves({ ...config, enabled: false, revision: 2 });
		const page = await disabled.listPage({ limit: 1 });
		expect(page.items).toHaveLength(1);
		expect(page.nextCursor).toBeTypeOf("string");
		const next = await disabled.listPage({
			cursor: page.nextCursor ?? undefined,
		});
		expect(next.items).toHaveLength(1);
		expect(
			new Set([...page.items, ...next.items].map((item) => item.sandboxId)),
		).toEqual(new Set([first, second]));
		await create(execution(), "user-a", "web", "reserve-demand");
		expect(await store.statistics({ windowMs: 60_000 })).toMatchObject({
			profiles: [
				expect.objectContaining({
					agentId: "agent",
					newSessionCount: 1,
					claimedCount: 0,
					replenishmentCount: 0,
					replenishmentUpperBoundMs: null,
				}),
			],
		});
	});
	it("refreshes only a live ready reserve and never revives a claimed or expired row", async () => {
		const reserve = await ready();
		const before = await sql<{ expires_at: Date }[]>`
			select expires_at from platform.session_sandbox_reserves
			where sandbox_id = ${reserve.sandboxId}`;
		expect(await reserve.store.refreshReady(reserve.sandboxId, 120000)).toBe(
			true,
		);
		const after = await sql<{ expires_at: Date }[]>`
			select expires_at from platform.session_sandbox_reserves
			where sandbox_id = ${reserve.sandboxId}`;
		expect(after[0]?.expires_at.getTime()).toBeGreaterThan(
			before[0]?.expires_at.getTime() ?? 0,
		);

		await sql`
			update platform.session_sandbox_reserves
			set expires_at = clock_timestamp() - interval '1 second'
			where sandbox_id = ${reserve.sandboxId}`;
		expect(await reserve.store.refreshReady(reserve.sandboxId, 120000)).toBe(
			false,
		);

		const live = await ready();
		expect(
			await create(execution(), "user-a", "web", "claim-before-refresh"),
		).toMatchObject({
			outcome: "accepted",
			result: { conversationId: live.sessionId },
		});
		expect(await live.store.refreshReady(live.sandboxId, 120000)).toBe(false);
	});
	it("records DELETE acknowledgement versus absence and permits a fresh same-UID retry after rejection", async () => {
		const reserve = await ready();
		expect(await reserve.store.retire(reserve.sandboxId)).toBe(true);
		const cleanup = await reserve.store.claimLease({
			sandboxId: reserve.sandboxId,
			workerId: "cleanup-response",
			leaseDurationMs: 30000,
		});
		if (!cleanup) throw new Error();
		const pod = cleanup.operations.find(
			(operation) =>
				operation.operation === "create" && operation.kind === "Pod",
		);
		if (!pod?.resource) throw new Error();
		const acknowledged: SessionSandboxReserveOperationInputV1 = {
			attemptId: "delete-ack",
			operation: "delete",
			kind: "Pod",
			name: pod.resource.name,
			status: "pending",
			resource: pod.resource,
			absent: false,
		};
		expect(await reserve.store.recordIntent(cleanup, acknowledged)).toBe(true);
		expect(
			await reserve.store.recordDeleteObservation(cleanup, {
				attemptId: acknowledged.attemptId,
			}),
		).toBe(false);
		expect(
			await reserve.store.recordDeleteResponse(cleanup, {
				attemptId: acknowledged.attemptId,
				response: "acknowledged",
				resource: pod.resource,
			}),
		).toBe(true);
		let [row] =
			await sql`select operations from platform.session_sandbox_reserves`;
		let deleteFact = row?.operations.find(
			(
				operation: SessionSandboxReserveOperationInputV1 & {
					writeCompletion?: string;
				},
			) => operation.attemptId === acknowledged.attemptId,
		);
		expect(deleteFact).toMatchObject({
			status: "confirmed",
			absent: false,
			writeCompletion: "response",
		});
		expect(
			await reserve.store.recordDeleteObservation(cleanup, {
				attemptId: acknowledged.attemptId,
			}),
		).toBe(true);
		[row] = await sql`select operations from platform.session_sandbox_reserves`;
		deleteFact = row?.operations.find(
			(
				operation: SessionSandboxReserveOperationInputV1 & {
					writeCompletion?: string;
				},
			) => operation.attemptId === acknowledged.attemptId,
		);
		expect(deleteFact).toMatchObject({
			status: "confirmed",
			absent: true,
			writeCompletion: "response",
		});

		const retryReserve = await ready(reserves());
		expect(await retryReserve.store.retire(retryReserve.sandboxId)).toBe(true);
		const retryLease = await retryReserve.store.claimLease({
			sandboxId: retryReserve.sandboxId,
			workerId: "cleanup-retry",
			leaseDurationMs: 30000,
		});
		if (!retryLease) throw new Error();
		const retryPod = retryLease.operations.find(
			(operation) =>
				operation.operation === "create" && operation.kind === "Pod",
		);
		if (!retryPod?.resource) throw new Error();
		const rejected: SessionSandboxReserveOperationInputV1 = {
			attemptId: "delete-rejected",
			operation: "delete",
			kind: "Pod",
			name: retryPod.resource.name,
			status: "pending",
			resource: retryPod.resource,
			absent: false,
		};
		expect(await retryReserve.store.recordIntent(retryLease, rejected)).toBe(
			true,
		);
		expect(
			await retryReserve.store.recordDeleteResponse(retryLease, {
				attemptId: rejected.attemptId,
				response: "rejected",
				resource: retryPod.resource,
			}),
		).toBe(true);
		const refreshed = { ...retryPod.resource, resourceVersion: "9" };
		expect(
			await retryReserve.store.recordIntent(retryLease, {
				...rejected,
				attemptId: "delete-unobserved-version",
				resource: refreshed,
			}),
		).toBe(false);
		expect(
			await retryReserve.store.recordIntent(retryLease, {
				...rejected,
				attemptId: "delete-repeated-version",
			}),
		).toBe(false);
		expect(
			await retryReserve.store.recordObservation(retryLease, {
				...refreshed,
				uid: "replacement-pod",
			}),
		).toBe(false);
		expect(
			await retryReserve.store.recordObservation(retryLease, refreshed),
		).toBe(true);
		expect(
			await retryReserve.store.recordIntent(retryLease, {
				...rejected,
				attemptId: "delete-retry",
				resource: refreshed,
			}),
		).toBe(true);
		expect(
			await retryReserve.store.recordDeleteResponse(retryLease, {
				attemptId: "delete-retry",
				response: "rejected",
				resource: refreshed,
			}),
		).toBe(true);
		const latest = { ...refreshed, resourceVersion: "10" };
		expect(await retryReserve.store.recordObservation(retryLease, latest)).toBe(
			true,
		);
		expect(
			await retryReserve.store.recordIntent(retryLease, {
				...rejected,
				attemptId: "delete-third",
				resource: latest,
			}),
		).toBe(true);
		expect(
			await retryReserve.store.recordDeleteResponse(retryLease, {
				attemptId: "delete-third",
				response: "rejected",
				resource: latest,
			}),
		).toBe(true);
		const beyondLimit = { ...latest, resourceVersion: "11" };
		expect(
			await retryReserve.store.recordObservation(retryLease, beyondLimit),
		).toBe(true);
		expect(
			await retryReserve.store.recordIntent(retryLease, {
				...rejected,
				attemptId: "delete-fourth",
				resource: beyondLimit,
			}),
		).toBe(false);
		expect(await retryReserve.store.finishRetirement(retryLease)).toBe(false);
	});
	it.each(["acknowledged", "rejected"] as const)(
		"releases only after original DELETE responses (%s) settle and every UID is observed absent",
		async (response) => {
			const reserve = await ready();
			expect(await reserve.store.retire(reserve.sandboxId)).toBe(true);
			const original = await reserve.store.claimLease({
				sandboxId: reserve.sandboxId,
				workerId: "delete-writer",
				leaseDurationMs: 30000,
			});
			if (!original) throw new Error("Expected cleanup lease");
			const deletes: SessionSandboxReserveOperationInputV1[] =
				original.operations.map((operation) => ({
					...operation,
					attemptId: `delete-${operation.kind}`,
					operation: "delete",
					status: "pending",
					absent: false,
				}));
			for (const operation of deletes) {
				expect(await reserve.store.recordIntent(original, operation)).toBe(
					true,
				);
				expect(
					await reserve.store.recordDeleteObservation(original, {
						attemptId: operation.attemptId,
					}),
				).toBe(false);
				expect(
					await reserve.store.recordResult(original, {
						...operation,
						status: "unknown",
					}),
				).toBe(true);
				expect(
					await reserve.store.recordIntent(original, {
						...operation,
						attemptId: `${operation.attemptId}-duplicate`,
					}),
				).toBe(false);
			}
			await sql`update platform.session_sandbox_reserves set lease_expires_at = clock_timestamp() - interval '1 second' where sandbox_id = ${reserve.sandboxId}`;
			const current = await reserve.store.claimLease({
				sandboxId: reserve.sandboxId,
				workerId: "delete-recovery",
				leaseDurationMs: 30000,
			});
			if (!current) throw new Error("Expected new cleanup lease");
			for (const operation of deletes) {
				if (!operation.resource) throw new Error("Expected DELETE identity");
				expect(await reserve.store.finishRetirement(current)).toBe(false);
				expect(
					await reserve.store.recordDeleteObservation(current, {
						attemptId: operation.attemptId,
					}),
				).toBe(false);
				expect(
					await reserve.store.recordResult(current, {
						...operation,
						status: "confirmed",
						absent: true,
					}),
				).toBe(false);
				expect(
					await reserve.store.recordDeleteResponse(current, {
						attemptId: operation.attemptId,
						response,
						resource: operation.resource,
					}),
				).toBe(false);
				expect(
					await reserve.store.recordDeleteResponse(original, {
						attemptId: operation.attemptId,
						response,
						resource: operation.resource,
					}),
				).toBe(true);
				expect(await reserve.store.finishRetirement(current)).toBe(false);
				expect(
					await reserve.store.recordDeleteObservation(original, {
						attemptId: operation.attemptId,
					}),
				).toBe(false);
				expect(
					await reserve.store.recordDeleteObservation(current, {
						attemptId: operation.attemptId,
					}),
				).toBe(true);
			}
			expect(await reserve.store.finishRetirement(original)).toBe(false);
			expect(await reserve.store.finishRetirement(current)).toBe(true);
			expect(await reserve.store.finishRetirement(current)).toBe(false);
			expect(await reserve.store.inspect(reserve.sandboxId)).toBeNull();
			expect(
				await sql`select released from platform.session_sandbox_resource_charges where sandbox_id = ${reserve.sandboxId}`,
			).toEqual([{ released: true }]);
		},
	);
	it("serializes claim versus retirement; the loser cannot clean an adopted resource", async () => {
		const reserve = await ready();
		const [created, retired] = await Promise.all([
			create(),
			reserve.store.retire(reserve.sandboxId),
		]);
		expect(created.outcome).toBe("accepted");
		const [row] =
			await sql`select status from platform.session_sandbox_reserves`;
		expect(row?.status).toBe(retired ? "retiring" : "claimed");
		if (retired)
			expect(created).not.toMatchObject({
				result: { conversationId: reserve.sessionId },
			});
		else
			expect(created).toMatchObject({
				result: { conversationId: reserve.sessionId },
			});
	});
	it("transfers claimed charges without freeing any CPU/memory/PVC while reserve preparation stays capped", async () => {
		const bounded = { ...config, totalBudget: resources };
		const reserve = await ready(reserves(bounded));
		expect(await create(execution(bounded))).toMatchObject({
			result: { conversationId: reserve.sessionId },
		});
		await expect(
			create(execution(bounded), "user-a", "web", "second"),
		).resolves.toMatchObject({ outcome: "accepted" });
		await expect(reserves(bounded).prepare("agent")).resolves.toBeTypeOf(
			"string",
		);
		expect(
			await sql`select released,compute_released from platform.session_sandbox_resource_charges`,
		).toHaveLength(2);
	});
	it("uses the sole approved cost for a legacy allocation without resource policy", async () => {
		const legacy = execution(null);
		await create(legacy);
		await expect(reserves().prepare("agent")).resolves.toBeTypeOf("string");
		expect(
			await sql`select status from platform.session_sandbox_reserves`,
		).toEqual([{ status: "preparing" }]);
	});
	it.each([false, true])(
		"rejects missing API configuration under an enabled DB budget (full: %s)",
		async (full) => {
			const bounded = { ...config, totalBudget: resources };
			await reserves(bounded).applyConfiguration();
			const existing = full
				? await create(execution(bounded), "user-a", "web", "existing")
				: null;
			await expect(
				create(execution(null), "user-a", "web", "missing-reserve-config"),
			).rejects.toThrow();
			const count = full ? 1 : 0;
			expect(await sql`select 1 from platform.conversations`).toHaveLength(
				count,
			);
			expect(
				await sql`select 1 from platform.session_sandbox_allocations`,
			).toHaveLength(count);
			expect(await sql`select 1 from platform.outbox_items`).toHaveLength(
				count,
			);
			expect(
				await sql`select 1 from platform.session_sandbox_resource_charges`,
			).toHaveLength(0);
			expect(
				await sql`select 1 from platform.idempotency_records`,
			).toHaveLength(count);
			if (existing && "result" in existing)
				expect(
					await create(execution(null), "user-a", "web", "existing"),
				).toEqual({ outcome: "replayed", result: existing.result });
		},
	);
	it.each(["budget_exhausted", "budget_configuration_unavailable"] as const)(
		"defers preparation for %s and recovers the original Sandbox after correction",
		async (reason) => {
			const created = await create(
				execution(),
				"user-a",
				"web",
				"prepare-first",
			);
			await create(execution(), "user-b", "web", "prepare-second");
			if (created.outcome !== "accepted")
				throw new Error("Expected cold Session");
			const conversationId = created.result.conversationId;
			const [allocation] =
				await sql`select sandbox_id from platform.session_sandbox_allocations where conversation_id = ${conversationId}`;
			const [outbox] =
				await sql`select id from platform.outbox_items where scope_id = ${conversationId} and operation = 'conversation.sandbox.reconcile.v1'`;
			if (!allocation || !outbox)
				throw new Error("Expected preparation intent");
			await reserves({
				...config,
				revision: 2,
				failureBackoffMs: 60000,
				...(reason === "budget_exhausted"
					? { totalBudget: resources }
					: {
							profiles: [],
							resourceCosts: [
								{ resourceConfigurationHash: "c".repeat(64), resources },
							],
						}),
			}).applyConfiguration();
			const charges =
				await sql`select * from platform.session_sandbox_resource_charges order by sandbox_id`;
			const reasons: string[] = [];
			const claim = () =>
				sql.begin((tx) =>
					claimSandboxReconciliation(
						tx,
						{
							itemId: outbox.id,
							workerId: "budget-worker",
							leaseDurationMs: 30000,
							onWait: (value) => reasons.push(value),
						},
						{
							namespace: config.namespace,
							resourceConfigurationHash: resourceHash,
						},
						directory,
					),
				);
			if (
				reason === "budget_exhausted" ||
				reason === "budget_configuration_unavailable"
			) {
				expect(await claim()).toMatchObject({ purpose: "prepare" });
				return;
			}
			expect(await claim()).toBeNull();
			expect(reasons).toEqual([reason]);
			expect(
				await sql`select status, attempt_count, delivery_fence, lease_owner, available_at > clock_timestamp() as deferred from platform.outbox_items where id = ${outbox.id}`,
			).toEqual([
				{
					status: "retry_scheduled",
					attempt_count: 0,
					delivery_fence: "0",
					lease_owner: null,
					deferred: true,
				},
			]);
			expect(
				await sql`select status, resource_fence, resource_policy from platform.session_sandbox_allocations where sandbox_id = ${allocation.sandbox_id}`,
			).toEqual([
				{ status: "allocated", resource_fence: "0", resource_policy: null },
			]);
			expect(
				await sql`select * from platform.session_sandbox_resource_charges order by sandbox_id`,
			).toEqual(charges);
			expect(await claim()).toBeNull();
			expect(reasons).toEqual([reason, "lease_ineligible"]);
			await reserves({ ...config, revision: 3 }).applyConfiguration();
			await sql`update platform.outbox_items set available_at = clock_timestamp() - interval '1 second' where id = ${outbox.id}`;
			expect(await claim()).toMatchObject({
				sandbox: {
					sandboxId: allocation.sandbox_id,
					sessionId: conversationId,
					generation: 1,
				},
				resourceFence: 1,
				deliveryFence: 1,
				purpose: "prepare",
			});
		},
	);
	it("retains PVC after a stop receipt and gates original-Sandbox preparation on the compute budget", async () => {
		const bounded = {
			...config,
			totalBudget: { ...resources, storageBytes: resources.storageBytes * 2 },
		};
		const original = await ready(reserves(bounded));
		expect(await create(execution(bounded))).toMatchObject({
			outcome: "accepted",
			result: { conversationId: original.sessionId },
		});
		const receipt = {
			schemaVersion: 1,
			sandboxId: original.sandboxId,
			sessionId: original.sessionId,
			sourceGeneration: 1,
			sourceResourceFence: 1,
			targetGeneration: 1,
			targetResourceFence: 1,
		};
		await sql`update platform.session_sandbox_allocations set status = 'stopped', desired_state = 'stopped' where sandbox_id = ${original.sandboxId}`;
		await sql`update platform.outbox_items set payload = payload || ${sql.json({ lifecycle: { stopReceipt: receipt } })} where scope_type = 'conversation' and scope_id = ${original.sessionId} and operation = 'conversation.sandbox.reconcile.v1'`;
		await sql.begin((tx) =>
			releaseSessionSandboxComputeBudgetV1(tx, original.sandboxId),
		);
		expect(
			await sql`select compute_released, released, resources from platform.session_sandbox_resource_charges where sandbox_id = ${original.sandboxId}`,
		).toEqual([{ compute_released: true, released: false, resources }]);
		const replacement = await create(
			execution(bounded),
			"user-b",
			"web",
			"replacement",
		);
		expect(replacement).toMatchObject({ outcome: "accepted" });
		const replacementId =
			"result" in replacement ? replacement.result.conversationId : undefined;
		if (!replacementId) throw new Error("Expected replacement conversation");
		const [replacementAllocation] =
			await sql`select sandbox_id, resource_fence from platform.session_sandbox_allocations where conversation_id = ${replacementId}`;
		if (!replacementAllocation)
			throw new Error("Expected replacement allocation");
		await expect(
			sql.begin((tx) =>
				reserveSessionSandboxPreparationBudgetV1(
					tx,
					original.sandboxId,
					original.lease.profile.policy,
				),
			),
		).resolves.toBeUndefined();
		await sql`update platform.session_sandbox_allocations set status = 'stopped', desired_state = 'stopped' where sandbox_id = ${replacementAllocation.sandbox_id}`;
		await sql`update platform.outbox_items set payload = payload || ${sql.json({ lifecycle: { stopReceipt: { sandboxId: replacementAllocation.sandbox_id, sessionId: replacementId, targetGeneration: 1, targetResourceFence: Number(replacementAllocation.resource_fence) } } })} where scope_type = 'conversation' and scope_id = ${replacementId} and operation = 'conversation.sandbox.reconcile.v1'`;
		await sql.begin((tx) =>
			releaseSessionSandboxComputeBudgetV1(
				tx,
				replacementAllocation.sandbox_id,
			),
		);
		await sql.begin((tx) =>
			reserveSessionSandboxPreparationBudgetV1(
				tx,
				original.sandboxId,
				original.lease.profile.policy,
			),
		);
		expect(
			await sql`select compute_released, released, resources from platform.session_sandbox_resource_charges where sandbox_id = ${original.sandboxId}`,
		).toEqual([{ compute_released: false, released: false, resources }]);
		expect(
			await sql`select sandbox_id, conversation_id from platform.session_sandbox_allocations order by conversation_id`,
		).toHaveLength(2);
		expect(
			await sql`select compute_released from platform.session_sandbox_resource_charges where sandbox_id = ${replacementAllocation.sandbox_id}`,
		).toEqual([]);
	});
	it("rejects absence and stale generation/fence as compute-release authority", async () => {
		const original = await ready();
		await create();
		await sql`update platform.session_sandbox_allocations set status = 'stopped', desired_state = 'stopped', resource_observation = '{"status":"stopped","resources":[]}'::jsonb where sandbox_id = ${original.sandboxId}`;
		for (const stopReceipt of [
			null,
			{
				sandboxId: original.sandboxId,
				sessionId: original.sessionId,
				targetGeneration: 2,
				targetResourceFence: 1,
			},
			{
				sandboxId: original.sandboxId,
				sessionId: original.sessionId,
				targetGeneration: 1,
				targetResourceFence: 2,
			},
		]) {
			await sql`update platform.outbox_items set payload = payload || ${sql.json({ lifecycle: { stopReceipt } })} where scope_type = 'conversation' and scope_id = ${original.sessionId} and operation = 'conversation.sandbox.reconcile.v1'`;
			await sql.begin((tx) =>
				releaseSessionSandboxComputeBudgetV1(tx, original.sandboxId),
			);
			expect(
				await sql`select compute_released, released from platform.session_sandbox_resource_charges where sandbox_id = ${original.sandboxId}`,
			).toEqual([{ compute_released: false, released: false }]);
		}
	});
	it("releases compute for an unavailable allocation after confirmed source cleanup", async () => {
		await ready();
		const created = await create();
		const allocation =
			"result" in created ? created.result.conversationId : undefined;
		if (!allocation) throw new Error("Expected allocation");
		const [row] = await sql<
			{ sandbox_id: string }[]
		>`select sandbox_id from platform.session_sandbox_allocations where conversation_id = ${allocation}`;
		if (!row) throw new Error("Expected allocation row");
		await sql`update platform.session_sandbox_allocations set status = 'unavailable', desired_state = 'stopped', resource_observation = ${sql.json({ status: "stopped", resources: [], sourceStop: { removed: [{ kind: "Pod", name: "sandbox", namespace: "reserve-test" }] } })} where sandbox_id = ${row.sandbox_id}`;
		await reserves().reconcileCapacity("agent");
		expect(
			await sql`select compute_released, released from platform.session_sandbox_resource_charges where sandbox_id = ${row.sandbox_id}`,
		).toEqual([{ compute_released: true, released: false }]);
	});
	it("never-enabled default-off preserves the cold path without charging resources", async () => {
		const off = { ...config, enabled: false };
		const result = await create(
			execution(off),
			"user-a",
			"web",
			"default-off-cold",
		);
		expect(result.outcome).toBe("accepted");
		expect(
			await sql`select 1 from platform.session_sandbox_budgets`,
		).toHaveLength(1);
		expect(
			await sql`select 1 from platform.session_sandbox_resource_charges`,
		).toHaveLength(0);
	});
	it("persists a first disabled revision and fences an older enabled process", async () => {
		const off = { ...config, enabled: false, revision: 7 };
		const disabled = reserves(off);
		await disabled.applyConfiguration();
		expect(
			await sql`select revision, configuration->>'enabled' as enabled from platform.session_sandbox_budgets`,
		).toEqual([{ revision: "7", enabled: "false" }]);
		await expect(reserves(config).prepare("agent")).rejects.toThrow();
	});
	it("preserves cooldown timing when a control revision changes without reserve sizing input", async () => {
		const first = reserves();
		await first.applyConfiguration();
		await sql`update platform.session_sandbox_budgets set reserve_sizing = ${sql.json(
			{
				agent: {
					profileDigest: "profile-v1",
					target: 1,
					lowTarget: 1,
					lowSince: 1234,
				},
			},
		)}`;
		await reserves({ ...config, revision: 2 }).applyConfiguration();
		const [budget] = await sql<
			{ reserve_sizing: { agent: { lowSince: number } } }[]
		>`
			select reserve_sizing from platform.session_sandbox_budgets`;
		expect(budget?.reserve_sizing.agent.lowSince).toBe(1234);
	});
	it("disabling after an existing cold allocation preserves its ledger and permits original preparation", async () => {
		const first = await create(
			execution(config),
			"user-a",
			"web",
			"disable-sequence",
		);
		const firstId = "result" in first ? first.result.conversationId : undefined;
		if (!firstId) throw new Error("Expected first conversation");
		const off = { ...config, enabled: false, revision: 2 };
		await create(execution(off), "user-a", "web", "disable-existing");
		const [allocation] =
			await sql`select sandbox_id from platform.session_sandbox_allocations where conversation_id = ${firstId}`;
		if (!allocation) throw new Error("Expected first allocation");
		await sql.begin((tx) =>
			reserveSessionSandboxPreparationBudgetV1(tx, allocation.sandbox_id, {
				namespace: config.namespace,
				resourceConfigurationHash: resourceHash,
				configurationRevision: 1,
				workloadRevision: 1,
				managementFence: 1,
				imageDigest,
			}),
		);
		expect(
			await sql`select released from platform.session_sandbox_resource_charges where sandbox_id = ${allocation.sandbox_id}`,
		).toEqual([]);
	});
	it.each([false, true])(
		"prepares new cold Sessions after disabling reserves (zeroed input: %s)",
		async (zeroed) => {
			await create(execution(), "user-a", "web", "charged-before-disable");
			const off = {
				...config,
				enabled: false,
				revision: 2,
				...(zeroed
					? {
							totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
							resourceCosts: [],
							profiles: [],
							maximumReserves: 0,
							maximumConcurrentCreates: 0,
						}
					: {}),
			};
			const created = await create(
				execution(off),
				"user-b",
				"web",
				"cold-after-disable",
			);
			if (created.outcome !== "accepted")
				throw new Error("Expected cold Session");
			const conversationId = created.result.conversationId;
			const [allocation] =
				await sql`select sandbox_id from platform.session_sandbox_allocations where conversation_id = ${conversationId}`;
			const [outbox] =
				await sql`select id from platform.outbox_items where scope_id = ${conversationId} and operation = 'conversation.sandbox.reconcile.v1'`;
			if (!allocation || !outbox)
				throw new Error("Expected original Sandbox intent");
			const charges =
				await sql`select * from platform.session_sandbox_resource_charges`;
			expect(charges).toHaveLength(0);
			const claim = await sql.begin((tx) =>
				claimSandboxReconciliation(
					tx,
					{
						itemId: outbox.id,
						workerId: "cold-worker",
						leaseDurationMs: 30000,
					},
					{
						namespace: config.namespace,
						resourceConfigurationHash: resourceHash,
					},
					directory,
				),
			);
			expect(claim).toMatchObject({
				sandbox: {
					sandboxId: allocation.sandbox_id,
					sessionId: conversationId,
					generation: 1,
				},
				resourceFence: 1,
				deliveryFence: 1,
				execution: null,
				purpose: "prepare",
			});
			expect(
				await sql`select * from platform.session_sandbox_resource_charges`,
			).toEqual(charges);
			expect(
				await sql`select status, attempt_count from platform.outbox_items where id = ${outbox.id}`,
			).toEqual([{ status: "processing", attempt_count: 1 }]);
			await expect(
				create(execution(off), "user-b", "web", "cold-after-disable"),
			).resolves.toMatchObject({
				outcome: "replayed",
				result: { conversationId },
			});
		},
	);
	it("still rejects unapproved resources for charged Sessions after disabling", async () => {
		const reserve = await ready();
		await create();
		await reserves({
			...config,
			enabled: false,
			revision: 2,
		}).applyConfiguration();
		const charges =
			await sql`select * from platform.session_sandbox_resource_charges`;
		await expect(
			sql.begin((tx) =>
				reserveSessionSandboxPreparationBudgetV1(tx, reserve.sandboxId, {
					...reserve.lease.profile.policy,
					resourceConfigurationHash: "c".repeat(64),
				}),
			),
		).rejects.toThrow();
		expect(
			await sql`select * from platform.session_sandbox_resource_charges`,
		).toEqual(charges);
	});
	it("allows preparation when an ordinary allocation has no charge", async () => {
		const reserve = await ready();
		await expect(
			sql.begin((tx) =>
				reserveSessionSandboxPreparationBudgetV1(
					tx,
					"00000000-0000-4000-8000-000000000000",
					reserve.lease.profile.policy,
				),
			),
		).resolves.toBeUndefined();
	});
	it("default-off keeps ready reserves unclaimed", async () => {
		const reserve = await ready();
		const off = { ...config, enabled: false, revision: 2 };
		const result = await create(execution(off));
		expect(result.outcome).toBe("accepted");
		expect(result).not.toMatchObject({
			result: { conversationId: reserve.sessionId },
		});
		expect(
			await sql`select status from platform.session_sandbox_reserves`,
		).toEqual([{ status: "ready" }]);
	});
	it("lists with a bounded cursor and exposes lease-free inspection/statistics", async () => {
		const reserve = await ready();
		const page = await reserve.store.listPage({ limit: 1 });
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.sandboxId).toBe(reserve.sandboxId);
		expect(page.nextCursor).toBeNull();
		const inspected = await reserve.store.inspect(reserve.sandboxId);
		expect(inspected).toMatchObject({
			sandboxId: reserve.sandboxId,
			sessionId: reserve.sessionId,
			status: "ready",
		});
		expect(inspected).not.toHaveProperty("leaseOwner");
		const statistics = await reserve.store.statistics({ windowMs: 300000 });
		expect(statistics).toMatchObject({
			windowMs: 300000,
			profiles: [
				expect.objectContaining({
					profileDigest: reserve.lease.profile.digest,
					currentProfileDigest: reserve.lease.profile.digest,
					newSessionCount: 0,
					claimedCount: 0,
				}),
			],
		});
	});
	it("real Worker shrinks three healthy ready reserves after cooldown and drains disabled immediately", async () => {
		const store = reserves();
		await ready(store);
		await ready(store);
		await ready(store);
		const adapter = {
			render: async () => [],
			read: async () => ({ kind: "Pod" }),
			create: async () => {
				throw new Error("Unexpected create");
			},
			remove: async () => "absent" as const,
			bootstrap: async () => ({
				bootstrapReady: true,
				businessStateAbsent: true,
			}),
		};
		const worker = createPlatformSessionReserveWorkerV1({
			databaseUrl: database.databaseUrl,
			configuration: config,
			store,
			adapter,
		});
		try {
			expect(await worker.reconcile()).toMatchObject({ retired: 0 });
			expect(
				(await store.list()).filter((row) => row.status === "ready"),
			).toHaveLength(3);
			await sql`update platform.session_sandbox_budgets set reserve_sizing = jsonb_set(reserve_sizing, '{agent,lowSince}', to_jsonb((extract(epoch from clock_timestamp()) * 1000 - 2000)::bigint))`;
			expect(await worker.reconcile()).toMatchObject({ retired: 2 });
			expect(
				(await store.list()).filter((row) => row.status === "ready"),
			).toHaveLength(1);
		} finally {
			await worker.stop();
		}
		const disabled = {
			...config,
			enabled: false,
			revision: 2,
			cooldownMs: 60_000,
		};
		const drain = createPlatformSessionReserveWorkerV1({
			databaseUrl: database.databaseUrl,
			configuration: disabled,
			adapter,
		});
		try {
			await drain.reconcile();
			expect(
				(await reserves(disabled).list()).every(
					(row) => row.status === "retiring",
				),
			).toBe(true);
		} finally {
			await drain.stop();
		}
	});
	it("shrinks three healthy ready reserves to one only after a persisted cooldown", async () => {
		const store = reserves();
		await ready(store);
		await ready(store);
		await ready(store);
		expect(await store.reconcileCapacity("agent")).toMatchObject({
			target: 1,
			retired: 0,
			prepared: 0,
		});
		expect(
			(await store.list()).filter((row) => row.status === "ready"),
		).toHaveLength(3);
		await sql`update platform.session_sandbox_budgets set reserve_sizing = jsonb_set(reserve_sizing, '{agent,lowSince}', to_jsonb((extract(epoch from clock_timestamp()) * 1000 - 2000)::bigint))`;
		expect(await reserves().reconcileCapacity("agent")).toMatchObject({
			target: 1,
			retired: 2,
			prepared: 0,
		});
		expect(
			(await store.list()).filter((row) => row.status === "ready"),
		).toHaveLength(1);
	});
	it("lists every page while target is zero and rejects out-of-bound page sizes", async () => {
		const reserve = await prepared();
		await sql`insert into platform.session_sandbox_reserves (sandbox_id, session_id, agent_id, namespace, profile_digest, profile, status, operations, expires_at, created_at, updated_at)
			select gen_random_uuid()::text, 'pagination-' || sequence.value, agent_id, namespace, profile_digest, profile, 'preparing', '[]'::jsonb, expires_at, created_at, updated_at
			from platform.session_sandbox_reserves cross join generate_series(1, 104) sequence(value) where sandbox_id = ${reserve.sandboxId}`;
		const disabled = reserves({
			...config,
			enabled: false,
			revision: 2,
			totalBudget: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
			resourceCosts: [],
			profiles: [],
			maximumReserves: 0,
			maximumConcurrentCreates: 0,
		});
		await disabled.applyConfiguration();
		const all = await disabled.list();
		expect(all).toHaveLength(105);
		expect(new Set(all.map((item) => item.sandboxId)).size).toBe(105);
		const first = await disabled.listPage({ limit: 100 });
		expect(first.items).toHaveLength(100);
		expect(first.nextCursor).toBe(first.items.at(-1)?.sandboxId);
		const last = await disabled.listPage({
			cursor: first.nextCursor ?? undefined,
			limit: 100,
		});
		expect(last.items).toHaveLength(5);
		expect(last.nextCursor).toBeNull();
		expect([...first.items, ...last.items]).toEqual(all);
		for (const limit of [0, -1, 101, 1.5]) {
			await expect(disabled.listPage({ limit })).rejects.toThrow();
		}
		expect(await disabled.retire(reserve.sandboxId)).toBe(true);
		expect(
			await disabled.claimLease({
				sandboxId: reserve.sandboxId,
				workerId: "disabled-drain",
				leaseDurationMs: 30000,
			}),
		).toMatchObject({ status: "retiring" });
	});
	it("keeps first ready timing through claim and restart, excluding unknown historical ready times", async () => {
		const first = await ready();
		const second = await ready(first.store);
		const [before] =
			await sql`select created_at, ready_at from platform.session_sandbox_reserves where sandbox_id = ${first.sandboxId}`;
		expect(before?.ready_at).toBeInstanceOf(Date);
		expect(
			await first.store.markReady(first.lease, {
				bootstrapReady: true,
				businessStateAbsent: true,
			}),
		).toBe(false);
		expect(await create()).toMatchObject({
			outcome: "accepted",
			result: { conversationId: first.sessionId },
		});
		await sql`update platform.session_sandbox_reserves set ready_at = null where sandbox_id = ${second.sandboxId}`;
		expect(
			(
				await sql`select created_at, ready_at from platform.session_sandbox_reserves where sandbox_id = ${first.sandboxId}`
			)[0],
		).toEqual(before);
		const statistics = await reserves().statistics({ windowMs: 60_000 });
		expect(statistics.profiles).toEqual([
			expect.objectContaining({
				newSessionCount: 1,
				claimedCount: 1,
				replenishmentCount: 1,
				replenishmentUpperBoundMs: expect.any(Number),
			}),
		]);
	});
	it("starts a first sample from zero minimum and clamps demand to the remaining deployment budget", async () => {
		const bounded = {
			...config,
			totalBudget: { cpuMillis: 2000, memoryBytes: 2048, storageBytes: 4096 },
			profiles: config.profiles.map((p) => ({ ...p, minimum: 0 })),
		};
		expect(await create(execution(bounded))).toMatchObject({
			outcome: "accepted",
		});
		const store = reserves(bounded);
		expect(await store.reconcileCapacity("agent")).toMatchObject({
			target: 1,
			prepared: 1,
		});
		expect(await store.reconcileCapacity("agent")).toMatchObject({
			target: 1,
			prepared: 0,
		});
		expect(await store.list()).toHaveLength(1);
		expect(
			await sql`select count(*)::int as count from platform.session_sandbox_resource_charges where not released`,
		).toEqual([{ count: 1 }]);
	});
	it("includes high-hit demand and the measured upper bound, then avoids concurrent overfill", async () => {
		const store = reserves();
		for (let i = 0; i < 3; i++) {
			await ready(store);
			expect(
				await create(execution(), "user-a", "web", `hit-${i}`),
			).toMatchObject({ outcome: "accepted" });
		}
		await sql`update platform.session_sandbox_reserves set created_at = ready_at - interval '30 seconds'`;
		expect((await store.statistics({ windowMs: 60_000 })).profiles).toEqual([
			expect.objectContaining({
				newSessionCount: 3,
				claimedCount: 3,
				replenishmentCount: 3,
				replenishmentUpperBoundMs: 30_000,
			}),
		]);
		const decisions = await Promise.all(
			Array.from({ length: 8 }, () => reserves().reconcileCapacity("agent")),
		);
		expect(decisions.every((decision) => decision.target === 3)).toBe(true);
		expect(decisions.reduce((n, decision) => n + decision.prepared, 0)).toBe(2);
		expect(await store.list()).toHaveLength(2);
	});
	it("does not over-shrink with concurrent Workers and a competing real claim", async () => {
		const store = reserves();
		await ready(store);
		await ready(store);
		await ready(store);
		await store.reconcileCapacity("agent");
		await sql`update platform.session_sandbox_budgets set reserve_sizing = jsonb_set(reserve_sizing, '{agent,lowSince}', to_jsonb((extract(epoch from clock_timestamp()) * 1000 - 2000)::bigint))`;
		const decisions = await Promise.all(
			Array.from({ length: 8 }, () => reserves().reconcileCapacity("agent")),
		);
		expect(decisions.reduce((n, decision) => n + decision.retired, 0)).toBe(2);
		expect(
			(await store.list()).filter((row) => row.status === "ready"),
		).toHaveLength(1);
		const [claim] = await Promise.all([
			create(),
			reserves().reconcileCapacity("agent"),
		]);
		expect(claim).toMatchObject({ outcome: "accepted" });
		expect(
			await sql`select count(*)::int as count from platform.session_sandbox_reserves r join platform.session_sandbox_allocations a on a.sandbox_id = r.sandbox_id where r.status <> 'claimed'`,
		).toEqual([{ count: 0 }]);
	});
	it("restarts cooldown after demand rises and falls again", async () => {
		const store = reserves();
		await ready(store);
		await ready(store);
		await ready(store);
		await store.reconcileCapacity("agent");
		await sql`update platform.session_sandbox_budgets set reserve_sizing = jsonb_set(reserve_sizing, '{agent,lowSince}', to_jsonb((extract(epoch from clock_timestamp()) * 1000 - 2000)::bigint))`;
		await create();
		expect(await store.reconcileCapacity("agent")).toMatchObject({
			target: 2,
			retired: 0,
		});
		await sql`update platform.session_sandbox_allocations set created_at = clock_timestamp() - interval '2 minutes'`;
		expect(await reserves().reconcileCapacity("agent")).toMatchObject({
			target: 1,
			retired: 0,
		});
		expect(
			(await store.list()).filter((row) => row.status === "ready"),
		).toHaveLength(2);
	});
	it("retains unresolved retiring creates in concurrency and resource budgets", async () => {
		const bounded = {
			...config,
			maximumConcurrentCreates: 1,
			profiles: config.profiles.map((p) => ({ ...p, minimum: 0 })),
		};
		const store = reserves(bounded);
		const sandboxId = await store.prepare("agent");
		if (!sandboxId) throw new Error("Expected reserve");
		const lease = await store.claimLease({
			sandboxId,
			workerId: "worker",
			leaseDurationMs: 30_000,
		});
		if (!lease) throw new Error("Expected lease");
		expect(
			await store.recordIntent(lease, {
				attemptId: "pending-pvc",
				operation: "create",
				kind: "PersistentVolumeClaim",
				name: `sandbox-${sandboxId}`,
				status: "pending",
				resource: null,
				absent: false,
			}),
		).toBe(true);
		await store.reconcileCapacity("agent");
		await sql`update platform.session_sandbox_budgets set reserve_sizing = jsonb_set(reserve_sizing, '{agent,lowSince}', to_jsonb((extract(epoch from clock_timestamp()) * 1000 - 2000)::bigint))`;
		expect(await store.reconcileCapacity("agent")).toMatchObject({
			target: 0,
			retired: 1,
		});
		expect(await store.prepare("agent")).toBeNull();
		expect(
			await sql`select released from platform.session_sandbox_resource_charges where sandbox_id = ${sandboxId}`,
		).toEqual([{ released: false }]);
		const retiring = await store.claimLease({
			sandboxId,
			workerId: "next-worker",
			leaseDurationMs: 30_000,
		});
		if (!retiring) throw new Error("Expected retiring lease");
		expect(await store.finishRetirement(retiring)).toBe(false);
		expect(
			await store.recordCreateResponse(lease, {
				attemptId: "pending-pvc",
				response: "rejected",
				resource: null,
			}),
		).toBe(true);
		expect(await store.finishRetirement(retiring)).toBe(true);
		expect(await store.prepare("agent")).toBeTypeOf("string");
	});
	it("isolates sizing and timing across profile changes and fences a restarted old configuration", async () => {
		const old = await ready();
		await ready(old.store);
		await ready(old.store);
		await old.store.reconcileCapacity("agent");
		const next = reserves({ ...config, revision: 2 });
		await next.applyConfiguration();
		expect(await next.reconcileCapacity("agent")).toMatchObject({
			target: 1,
			prepared: 1,
			retired: 0,
		});
		await expect(old.store.reconcileCapacity("agent")).rejects.toThrow();
		const rows = (await next.statistics({ windowMs: 60_000 })).profiles;
		expect(rows).toContainEqual(
			expect.objectContaining({
				profileDigest: old.lease.profile.digest,
				replenishmentCount: 3,
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				replenishmentCount: 0,
				replenishmentUpperBoundMs: null,
			}),
		);
		const [budget] =
			await sql`select reserve_sizing from platform.session_sandbox_budgets`;
		expect(budget?.reserve_sizing.agent.lowSince).toBeNull();
		expect(budget?.reserve_sizing.agent.profileDigest).not.toBe(
			old.lease.profile.digest,
		);
	});
	it("attributes cold and claimed demand to their immutable admission profile across revisions", async () => {
		expect(
			await create(execution(null), "user-a", "web", "legacy-demand"),
		).toMatchObject({ outcome: "accepted" });
		const first = await ready();
		expect(
			await create(execution(), "user-a", "web", "claim-v1"),
		).toMatchObject({
			outcome: "accepted",
			result: { conversationId: first.sessionId },
		});
		expect(await create(execution(), "user-a", "web", "cold-v1")).toMatchObject(
			{ outcome: "accepted" },
		);
		const configuration = { ...config, revision: 2 };
		const second = await ready(reserves(configuration));
		expect(second.lease.profile.digest).not.toBe(first.lease.profile.digest);
		expect(
			await create(execution(configuration), "user-a", "web", "claim-v2"),
		).toMatchObject({
			outcome: "accepted",
			result: { conversationId: second.sessionId },
		});
		expect(
			await create(execution(configuration), "user-a", "web", "cold-v2"),
		).toMatchObject({ outcome: "accepted" });
		expect(
			await create(execution(configuration), "user-a", "web", "cold-v2"),
		).toMatchObject({ outcome: "replayed" });
		const statistics = await second.store.statistics({ windowMs: 60000 });
		expect(statistics.observedAt).toBeInstanceOf(Date);
		expect(statistics.profiles).toHaveLength(3);
		expect(statistics.profiles).toEqual(
			expect.arrayContaining([
				{
					agentId: "agent",
					profileDigest: first.lease.profile.digest,
					currentProfileDigest: second.lease.profile.digest,
					newSessionCount: 2,
					claimedCount: 1,
					replenishmentCount: 1,
					replenishmentUpperBoundMs: expect.any(Number),
				},
				{
					agentId: "agent",
					profileDigest: second.lease.profile.digest,
					currentProfileDigest: second.lease.profile.digest,
					newSessionCount: 2,
					claimedCount: 1,
					replenishmentCount: 1,
					replenishmentUpperBoundMs: expect.any(Number),
				},
				{
					agentId: "agent",
					profileDigest: null,
					currentProfileDigest: second.lease.profile.digest,
					newSessionCount: 1,
					claimedCount: 0,
					replenishmentCount: 0,
					replenishmentUpperBoundMs: null,
				},
			]),
		);
		expect(
			statistics.profiles.reduce(
				(count, profile) => count + profile.newSessionCount,
				0,
			),
		).toBe(5);
		expect(
			await sql`select admission_profile_digest, count(*)::int as count from platform.session_sandbox_allocations group by admission_profile_digest`,
		).toEqual(
			expect.arrayContaining([
				{ admission_profile_digest: first.lease.profile.digest, count: 2 },
				{ admission_profile_digest: second.lease.profile.digest, count: 2 },
				{ admission_profile_digest: null, count: 1 },
			]),
		);
	});
	it("uses the real API task admission branch, replay and continuation without re-claim", async () => {
		const reserve = await ready();
		const material = `papi_${"A".repeat(43)}`;
		await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('api-app','Synthetic','user-a','app-1')`;
		await sql`insert into platform.agent_availability(agent_id,target_type,target_id) values('agent','application','api-app')`;
		await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision) values('agent','application','api-app','use','use-1')`;
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values('api-credential','application','api-app',${createHash("sha256").update(material).digest("hex")},${sql.json(["agent:use"])})`;
		await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values('agent-default','agent',1,1)`;
		await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values('agent-default','agent',1,'synthetic-key',${sql.json({ schemaVersion: 1, purpose: "agent-default", subjectId: "agent", keyId: "synthetic-key", keyVersion: 1 })})`;
		const store = execution();
		const useCase = createConversationTaskAdmissionUseCaseV1(
			{
				transaction: store,
				authorization: {
					async authorize() {
						const a = await store.authorizeTaskApi({
							material,
							operation: "agent:use",
							agentId: "agent",
						});
						return a
							? { outcome: "allowed", authority: a }
							: { outcome: "denied" };
					},
				},
			},
			{ maximumWaitingTasksPerAgent: 8, waitingTimeoutMs: 30000 },
		);
		const command = {
			schemaVersion: 1 as const,
			agentId: "agent",
			text: "synthetic",
			idempotencyKey: "task",
			requestId: "request",
			traceId: "trace",
		};
		const first = await useCase.submitTask(command);
		expect(first).toMatchObject({
			outcome: "accepted",
			result: { conversationId: reserve.sessionId },
		});
		expect(await useCase.submitTask(command)).toMatchObject({
			outcome: "replayed",
			result: { conversationId: reserve.sessionId },
		});
		const nextReserve = await ready();
		expect(
			await useCase.submitTask({
				...command,
				conversationId: reserve.sessionId,
				idempotencyKey: "continue",
			}),
		).toMatchObject({
			outcome: "accepted",
			result: { conversationId: reserve.sessionId },
		});
		expect(
			await sql`select status from platform.session_sandbox_reserves where sandbox_id = ${nextReserve.sandboxId}`,
		).toEqual([{ status: "ready" }]);
		const rows =
			await sql`select e.sandbox_id,e.conversation_id,o.payload->>'conversationId' as outbox_id from platform.conversation_executions e join platform.outbox_items o on o.id = 'conversation:turn:' || e.execution_id`;
		expect(rows).toHaveLength(2);
		for (const row of rows)
			expect(row).toEqual({
				sandbox_id: reserve.sandboxId,
				conversation_id: reserve.sessionId,
				outbox_id: reserve.sessionId,
			});
	});
});

describe("reserve eligibility stays standard-only (ADR-0038, #3937)", () => {
	/**
	 * Keep the approved deployment, digest, resource hash and verified V4
	 * template projection; only the configuration source becomes custom
	 * platform-adapter. #3929 accepted the variants without Owner Secret.
	 */
	async function useCustomSource(input: {
		readonly ownerSecret: boolean;
		readonly snapshot: boolean;
	}) {
		const configuration = {
			schemaVersion: 2,
			agentId: "agent",
			revision: 1,
			source: {
				kind: "custom",
				imageDigest,
				admissionRevision: "admitted",
				interactionMode: "platform-adapter",
				connectionEnabled: false,
				...(input.snapshot
					? { workspaceSnapshots: [{ snapshotId: "snapshot-a", name: "repo" }] }
					: {}),
			},
			modelConfiguration: null,
			environment: [],
			secrets: input.ownerSecret
				? [
						{
							name: "MODEL_API_KEY",
							secretId: "owner-secret",
							version: 1,
							isSet: true,
						},
					]
				: [],
			channels: [],
			channelRevision: "channels-a",
		};
		const [row] = await sql<
			{
				state: { verified: Record<string, unknown> } & Record<string, unknown>;
			}[]
		>`select state from platform.workload_reconciliations where agent_id = 'agent'`;
		if (!row) throw new Error("Expected the verified Workload");
		const version = { ...row.state.verified, configuration };
		await sql`update platform.agent_configuration_revisions set configuration = ${sql.json(configuration as unknown as postgres.JSONValue)} where agent_id = 'agent' and revision = 1`;
		await sql`update platform.workload_reconciliations set state = ${sql.json({ ...row.state, candidate: version, verified: version } as unknown as postgres.JSONValue)} where agent_id = 'agent'`;
	}

	it.each([
		{ ownerSecret: false, snapshot: false },
		{ ownerSecret: false, snapshot: true },
		{ ownerSecret: true, snapshot: false },
		{ ownerSecret: true, snapshot: true },
	])(
		"prepares and claims no reserve for a custom platform-adapter Agent (Owner Secret: $ownerSecret, snapshot: $snapshot)",
		async (input) => {
			const standard = await ready();
			await useCustomSource(input);
			expect(await reserves().prepare("agent")).toBeNull();
			const created = await create(execution());
			expect(created.outcome).toBe("accepted");
			const allocations = await sql<
				{ sandbox_id: string; admission_profile_digest: string | null }[]
			>`select sandbox_id, admission_profile_digest from platform.session_sandbox_allocations`;
			expect(allocations).toHaveLength(1);
			expect(allocations[0]?.sandbox_id).not.toBe(standard.sandboxId);
			expect(allocations[0]?.admission_profile_digest).toBeNull();
			expect(
				await sql`select sandbox_id, status from platform.session_sandbox_reserves`,
			).toEqual([{ sandbox_id: standard.sandboxId, status: "ready" }]);
		},
	);
});

describe("independent executor reserve startup and projection (#4248 B 3a)", () => {
	const bindingDigest = "c".repeat(64);
	const policy = {
		namespace: config.namespace,
		resourceConfigurationHash: resourceHash,
	};
	type Store = PostgresSessionSandboxReserveStoreV1;
	type Lease = NonNullable<Awaited<ReturnType<Store["claimLease"]>>>;
	async function executorPrepared(store = reserves()) {
		const sandboxId = await store.prepare("agent");
		if (typeof sandboxId !== "string") throw new Error("Expected reserve");
		const lease = await store.claimLease({
			sandboxId,
			workerId: "worker-a",
			leaseDurationMs: 30000,
		});
		if (!lease) throw new Error("Expected reserve lease");
		const deadline = await store.recordExecutorStartup(lease, {
			timeoutMs: 60000,
		});
		expect(deadline).toBeTypeOf("number");
		for (const kind of sessionSandboxReserveResourceKindsV1) {
			const name = `sandbox-${sandboxId}`;
			expect(
				await store.recordIntent(lease, {
					attemptId: `create-${kind}`,
					operation: "create",
					kind,
					name,
					status: "pending",
					resource: null,
					absent: false,
				}),
			).toBe(true);
			expect(
				await store.recordCreateResponse(lease, {
					attemptId: `create-${kind}`,
					response: "created",
					resource: {
						kind,
						name,
						namespace: config.namespace,
						uid: `${kind}-uid-${sandboxId}`,
						resourceVersion: "1",
					},
				}),
			).toBe(true);
		}
		const startupRef = `sandbox-${sandboxId}-executor-1`;
		const podUid = `Pod-uid-${sandboxId}`;
		const intent = {
			attemptId: "projection-1",
			podUid,
			hostKeyId: "host-key-1",
			hostPublicKey: "host-public-key-1",
			bindingDigest,
		};
		const projection = {
			kind: "Secret" as const,
			name: startupRef,
			namespace: config.namespace,
			uid: `projection-uid-${sandboxId}`,
			resourceVersion: "7",
		};
		return {
			store,
			lease,
			sandboxId,
			sessionId: lease.sessionId,
			deadline: deadline as number,
			startupRef,
			podUid,
			intent,
			projection,
		};
	}
	type Prepared = Awaited<ReturnType<typeof executorPrepared>>;
	async function dbNow(): Promise<number> {
		const [row] = await sql<{ now: number }[]>`
			select floor(extract(epoch from clock_timestamp()) * 1000)::float8 as now`;
		if (typeof row?.now !== "number") throw new Error("Expected clock");
		return row.now;
	}
	async function reserveEvidence(
		reserve: Prepared,
		lease: Lease = reserve.lease,
		overrides: Record<string, unknown> = {},
	) {
		const now = await dbNow();
		return {
			scope: {
				phase: "reserve" as const,
				reserveRef: `reserve:${reserve.sandboxId}`,
				reserveDeliveryFence: lease.deliveryFence,
			},
			podUid: reserve.podUid,
			hostKeyId: "host-key-1",
			runnerEpoch: "runner-epoch-1",
			generation: 1,
			resourceFence: 1,
			issuedAtMs: now,
			observedAtMs: now,
			expiresAtMs: now + 20000,
			...overrides,
		};
	}
	const notReady = async (reserve: Prepared, lease: Lease = reserve.lease) =>
		reserve.store.markReady(lease, {
			bootstrapReady: true,
			businessStateAbsent: true,
			instanceEvidence: await reserveEvidence(reserve, lease),
		});
	async function consumeAndRemove(reserve: Prepared) {
		const { store, lease, intent, projection, podUid } = reserve;
		expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(
			true,
		);
		expect(
			await store.recordExecutorProjectionCreateResponse(lease, {
				attemptId: intent.attemptId,
				response: "created",
				resource: projection,
			}),
		).toBe(true);
		expect(
			await store.recordExecutorConsumption(lease, {
				attemptId: intent.attemptId,
				podUid,
				projectionUid: projection.uid,
				hostKeyId: intent.hostKeyId,
				runnerEpoch: "runner-epoch-1",
				evidence: await reserveEvidence(reserve),
			}),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionDeleteIntent(lease, {
				attemptId: "projection-delete-1",
				resource: projection,
			}),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionDeleteResponse(lease, {
				attemptId: "projection-delete-1",
				response: "acknowledged",
			}),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionDeleteObservation(lease, {
				attemptId: "projection-delete-1",
			}),
		).toBe(true);
	}
	async function cleanSix(store: Store, lease: Lease, sandboxId: string) {
		for (const kind of sessionSandboxReserveResourceKindsV1) {
			const resource = {
				kind,
				name: `sandbox-${sandboxId}`,
				namespace: config.namespace,
				uid: `${kind}-uid-${sandboxId}`,
				resourceVersion: "1",
			};
			expect(
				await store.recordIntent(lease, {
					attemptId: `delete-${kind}`,
					operation: "delete",
					kind,
					name: resource.name,
					status: "pending",
					resource,
					absent: false,
				}),
			).toBe(true);
			expect(
				await store.recordDeleteResponse(lease, {
					attemptId: `delete-${kind}`,
					response: "absent",
					resource,
				}),
			).toBe(true);
		}
	}
	async function retiringLease(store: Store, sandboxId: string) {
		expect(await store.retire(sandboxId)).toBe(true);
		const lease = await store.claimLease({
			sandboxId,
			workerId: "worker-retire",
			leaseDurationMs: 30000,
		});
		if (!lease) throw new Error("Expected retiring lease");
		return lease;
	}

	it("keeps all six resources intact while the original identity projection create is unresolved (#4248 B3b)", async () => {
		const reserve = await executorPrepared();
		const { store, lease, intent, projection, sandboxId } = reserve;
		expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(
			true,
		);
		expect(
			await store.recordExecutorProjectionResult(lease, {
				attemptId: intent.attemptId,
			}),
		).toBe(true);
		expect(await store.retire(sandboxId)).toBe(true);
		const removed: string[] = [];
		const objects = new Map(
			lease.operations.map((o) => [
				o.kind,
				{ apiVersion: "v1", kind: o.kind, metadata: o.resource! },
			]),
		);
		const inspection = await store.inspect(sandboxId);
		for (const operation of inspection!.operations)
			objects.set(operation.kind, {
				apiVersion: "v1",
				kind: operation.kind,
				metadata: operation.resource!,
			});
		const unused = async (): Promise<never> => {
			throw new Error("unused preparation during cleanup");
		};
		const adapter = {
			render: unused,
			create: unused,
			read: async (_claim: unknown, kind: string) =>
				objects.get(
					kind as (typeof sessionSandboxReserveResourceKindsV1)[number],
				) ?? null,
			remove: async (_claim: unknown, identity: { kind: string }) => {
				removed.push(identity.kind);
				return "acknowledged" as const;
			},
			bootstrap: async () => ({
				bootstrapReady: false,
				businessStateAbsent: false,
			}),
			executor: {
				startup: unused,
				projection: unused,
				createProjection: unused,
				readInstance: unused,
				readProjection: async () => ({
					apiVersion: "v1",
					kind: "Secret",
					metadata: projection,
				}),
				removeProjection: unused,
			},
		};
		const worker = createPlatformSessionReserveWorkerV1({
			databaseUrl: database.databaseUrl,
			configuration: config,
			store,
			adapter,
			workerId: "cleanup-v2",
			pollIntervalMs: 100,
			leaseDurationMs: 30000,
		});
		try {
			await worker.reconcile();
			expect(removed).toEqual([]);
			expect((await store.inspect(sandboxId))?.status).toBe("retiring");
			expect(
				await sql`select released from platform.session_sandbox_resource_charges where sandbox_id=${sandboxId}`,
			).toEqual([{ released: false }]);
		} finally {
			await worker.stop();
		}
	});

	it.each(["lost", "consumed", "unconsumed"] as const)(
		"persists executor preparation and settles only confirmed projection/consumption/absence (%s, #4248 B3b)",
		async (outcome) => {
			const configuration = {
				...config,
				maximumReserves: 1,
				maximumConcurrentCreates: 1,
				profiles: config.profiles.map((p) => ({ ...p, maximum: 1 })),
			};
			const store = reserves(configuration);
			const sandboxId = await store.prepare("agent");
			if (!sandboxId) throw new Error("Missing reserve");
			const objects = new Map<
				string,
				{
					apiVersion: string;
					kind: string;
					metadata: {
						name: string;
						namespace: string;
						uid?: string;
						resourceVersion?: string;
					};
				}
			>();
			let issued = 0;
			let published = 0;
			const image = `registry.test/codex@${imageDigest}`;
			const startup = async () => ({
				kind: "prepare" as const,
				bindingDigest,
				configurationVersion: "fixture-v4",
				timeoutMs: outcome === "unconsumed" ? 1000 : 60000,
				approval: {
					schemaVersion: 2 as const,
					imageDigest: image,
					verificationRef: "approved-consumers",
				},
			});
			const read = async (claim: { sandboxId: string }, kind: string) =>
				objects.get(`${kind}/sandbox-${claim.sandboxId}`) ?? null;
			const proof = (claim: {
				sandboxId: string;
				deliveryFence?: number;
				readFence?: number;
				executorStartup?: {
					projection: { podUid: string; hostKeyId: string } | null;
				} | null;
			}) => ({
				scope: {
					phase: "reserve" as const,
					reserveRef: `reserve:${claim.sandboxId}`,
					reserveDeliveryFence: claim.deliveryFence ?? claim.readFence!,
				},
				podUid: claim.executorStartup!.projection!.podUid,
				hostKeyId: claim.executorStartup!.projection!.hostKeyId,
				runnerEpoch: "original-runner-epoch",
				generation: 1,
				resourceFence: 1,
				issuedAtMs: Date.now(),
				observedAtMs: Date.now(),
				expiresAtMs: Date.now() + 20000,
			});
			const adapter = {
				deliverable: async (claim: { sandboxId: string }) =>
					claim.sandboxId === sandboxId,
				render: async (claim: Awaited<ReturnType<typeof store.claimLease>>) => {
					expect(["prepared", "published"]).toContain(
						claim?.executorStartup?.instance?.phase,
					);
					return sessionSandboxReserveResourceKindsV1.map((kind) => ({
						apiVersion: "v1",
						kind,
						metadata: {
							name: `sandbox-${sandboxId}`,
							namespace: config.namespace,
						},
					}));
				},
				read,
				create: async (
					_claim: unknown,
					object: {
						kind?: string;
						metadata?: { name?: string; namespace?: string };
					},
				) => {
					const created = {
						...object,
						apiVersion: "v1",
						kind: object.kind!,
						metadata: {
							name: object.metadata!.name!,
							namespace: config.namespace,
							uid: `uid-${object.kind}`,
							resourceVersion: "1",
						},
					};
					objects.set(`${created.kind}/${created.metadata.name}`, created);
					return created;
				},
				remove: async (
					claim: { executorStartup?: { startupRef: string } | null },
					resource: { kind: string; name: string },
				) => {
					expect(
						objects.has(`Secret/${claim.executorStartup!.startupRef}`),
					).toBe(false);
					objects.delete(`${resource.kind}/${resource.name}`);
					return "acknowledged" as const;
				},
				bootstrap: async (claim: Parameters<typeof proof>[0]) => ({
					bootstrapReady: true,
					businessStateAbsent: true,
					instanceEvidence: proof(claim),
				}),
				executor: {
					startup,
					readInstance: async (claim: Parameters<typeof proof>[0]) =>
						outcome === "unconsumed" ? null : proof(claim),
					removeProjection: async (
						_claim: unknown,
						resource: { name: string },
					) => {
						objects.delete(`Secret/${resource.name}`);
						return "acknowledged" as const;
					},
					readProjection: async (claim: {
						executorStartup?: { startupRef: string } | null;
					}) =>
						objects.get(`Secret/${claim.executorStartup?.startupRef}`) ?? null,
					projection: async (
						claim: NonNullable<Awaited<ReturnType<typeof store.claimLease>>>,
					) => {
						issued++;
						const publicKey = Buffer.from("synthetic-public-key").toString(
							"base64url",
						);
						return {
							intent: {
								attemptId: claim.executorStartup!.instance!.attemptId,
								podUid: "uid-Pod",
								hostKeyId: createHash("sha256").update(publicKey).digest("hex"),
								hostPublicKey: publicKey,
								bindingDigest,
								instanceDelivery: {
									runnerPublicKey: Buffer.from("synthetic-runner-key").toString(
										"base64url",
									),
									identityDigest: "d".repeat(64),
								},
							},
							resource: {
								apiVersion: "v1",
								kind: "Secret",
								metadata: {
									name: claim.executorStartup!.startupRef,
									namespace: config.namespace,
								},
								data: { host: "PRIVATE_TEST_MATERIAL" },
							},
						};
					},
					createProjection: async (
						claim: NonNullable<Awaited<ReturnType<typeof store.claimLease>>>,
						object: { metadata?: { name?: string } },
					) => {
						published++;
						expect(
							(await store.inspect(sandboxId))?.executorStartup?.projection
								?.create.writeCompletion,
						).toBe("pending");
						expect(
							(await store.inspect(sandboxId))?.executorStartup?.instance
								?.delivery?.identityDigest,
						).toBe("d".repeat(64));
						objects.set(`Secret/${object.metadata?.name}`, {
							apiVersion: "v1",
							kind: "Secret",
							metadata: {
								name: claim.executorStartup!.startupRef,
								namespace: config.namespace,
								uid: "projection-uid",
								resourceVersion: "1",
							},
						});
						if (outcome === "lost") throw new Error("lost create response");
						return objects.get(`Secret/${object.metadata?.name}`)!;
					},
				},
			};
			let timeOffset = 0;
			const make = (workerStore: typeof store) =>
				createPlatformSessionReserveWorkerV1({
					databaseUrl: database.databaseUrl,
					configuration,
					now: () => Date.now() + timeOffset,
					adapter,
					store: workerStore,
					workerId: "executor-prepare",
					pollIntervalMs: 100,
					leaseDurationMs: 30000,
				});
			const first = make(store);
			await first.reconcile();
			const before = await store.inspect(sandboxId);
			if (outcome !== "lost") {
				expect(before?.status).toBe(
					outcome === "consumed" ? "ready" : "preparing",
				);
				expect(
					before?.executorStartup?.projection?.create.writeCompletion,
				).toBe("response");
				expect(
					objects.has(`Secret/${before!.executorStartup!.startupRef}`),
				).toBe(outcome !== "consumed");
				expect(
					await sql`select released from platform.session_sandbox_resource_charges where sandbox_id=${sandboxId}`,
				).toEqual([{ released: false }]);
				if (outcome === "unconsumed")
					timeOffset = before!.executorStartup!.deadlineMs - Date.now() + 1;
				else expect(await store.retire(sandboxId)).toBe(true);
				await sql`update platform.session_sandbox_reserves set lease_expires_at=clock_timestamp()-interval '1 second' where sandbox_id=${sandboxId}`;
				expect(await first.reconcile()).toMatchObject({ unavailable: 0 });
				expect(["retiring", "retired"]).toContain(
					(await store.inspect(sandboxId))?.status ?? "retired",
				);
				// A timeout can only enter retiring on this pass; the following pass performs original cleanup.
				await sql`update platform.session_sandbox_reserves set lease_expires_at=clock_timestamp()-interval '1 second' where sandbox_id=${sandboxId}`;
				expect(await first.reconcile()).toMatchObject({ unavailable: 0 });
				expect(objects.size).toBe(0);
				expect(
					await sql`select released from platform.session_sandbox_resource_charges where sandbox_id=${sandboxId}`,
				).toEqual([{ released: true }]);
				expect(issued).toBe(1);
				expect(published).toBe(1);
				await first.stop();
				return;
			}
			expect(before?.status).toBe("unknown");
			expect(before?.executorStartup?.projection?.create).toMatchObject({
				status: "unknown",
				writeCompletion: "pending",
			});
			expect(issued).toBe(1);
			expect(published).toBe(1);
			expect(JSON.stringify(before?.executorStartup)).not.toContain(
				"PRIVATE_TEST_MATERIAL",
			);
			await first.stop();
			await sql`update platform.session_sandbox_reserves set lease_expires_at=clock_timestamp()-interval '1 second' where sandbox_id=${sandboxId}`;
			const restartedStore = reserves(configuration);
			const second = make(restartedStore);
			try {
				await second.reconcile();
				expect(issued).toBe(1);
				expect(published).toBe(1);
				expect(
					(await restartedStore.inspect(sandboxId))?.executorStartup,
				).toEqual(before?.executorStartup);
				expect(
					await sql`select released from platform.session_sandbox_resource_charges where sandbox_id=${sandboxId}`,
				).toEqual([{ released: false }]);
			} finally {
				await second.stop();
			}
		},
	);

	it("renews executor readiness only with fresh original-instance proof at the observed reserve fence (#4248 B3b)", async () => {
		const reserve = await executorPrepared();
		await consumeAndRemove(reserve);
		expect(await notReady(reserve)).toBe(true);
		const snapshot = await reserve.store.inspect(reserve.sandboxId);
		expect(snapshot?.readFence).toBeTypeOf("number");
		const evidence = {
			...(await reserveEvidence(reserve)),
			scope: {
				phase: "reserve" as const,
				reserveRef: `reserve:${reserve.sandboxId}`,
				reserveDeliveryFence: snapshot!.readFence!,
			},
		};
		expect(await reserve.store.refreshReady(reserve.sandboxId, 60000)).toBe(
			false,
		);
		expect(
			await reserve.store.refreshReady(reserve.sandboxId, 60000, {
				readFence: snapshot!.readFence!,
				instanceEvidence: evidence,
			}),
		).toBe(true);
		for (const patch of [
			{ runnerEpoch: "another-epoch" },
			{ expiresAtMs: (await dbNow()) - 1 },
			{
				scope: {
					...evidence.scope,
					reserveDeliveryFence: evidence.scope.reserveDeliveryFence - 1,
				},
			},
		])
			expect(
				await reserve.store.refreshReady(reserve.sandboxId, 60000, {
					readFence: snapshot!.readFence!,
					instanceEvidence: { ...evidence, ...patch },
				}),
			).toBe(false);
	});

	it("stays unready until both-role consumption and confirmed projection removal", async () => {
		const reserve = await executorPrepared();
		const { store, lease, intent, projection, podUid } = reserve;
		expect(await notReady(reserve)).toBe(false);
		expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(
			true,
		);
		expect(await notReady(reserve)).toBe(false);
		expect(
			await store.recordExecutorProjectionCreateResponse(lease, {
				attemptId: intent.attemptId,
				response: "created",
				resource: projection,
			}),
		).toBe(true);
		expect(await notReady(reserve)).toBe(false);
		expect(
			await store.recordExecutorConsumption(lease, {
				attemptId: intent.attemptId,
				podUid,
				projectionUid: projection.uid,
				hostKeyId: intent.hostKeyId,
				runnerEpoch: "runner-epoch-1",
				evidence: await reserveEvidence(reserve),
			}),
		).toBe(true);
		expect(await notReady(reserve)).toBe(false);
		expect(
			await store.recordExecutorProjectionDeleteIntent(lease, {
				attemptId: "projection-delete-1",
				resource: projection,
			}),
		).toBe(true);
		expect(await notReady(reserve)).toBe(false);
		expect(
			await store.recordExecutorProjectionDeleteResponse(lease, {
				attemptId: "projection-delete-1",
				response: "acknowledged",
			}),
		).toBe(true);
		// A DELETE acknowledgement is not absence evidence.
		expect(await notReady(reserve)).toBe(false);
		expect(
			await store.recordExecutorProjectionDeleteObservation(lease, {
				attemptId: "projection-delete-1",
			}),
		).toBe(true);
		expect(await notReady(reserve)).toBe(true);
		const [row] =
			await sql`select status, executor_startup from platform.session_sandbox_reserves`;
		expect(row?.status).toBe("ready");
		expect(row?.executor_startup).toMatchObject({
			schemaVersion: 1,
			startupRef: reserve.startupRef,
			deadlineMs: reserve.deadline,
			projection: {
				podUid,
				hostKeyId: "host-key-1",
				create: { status: "confirmed", writeCompletion: "response" },
				deletes: [{ status: "confirmed", absent: true }],
			},
			consumption: { projectionUid: projection.uid },
		});
	});

	it("binds the projection to a confirmed Pod UID, the current lease, one key and an open deadline", async () => {
		// The deadline is frozen before the Pod create intent and never reset.
		const legacy = await prepared();
		expect(
			await legacy.store.recordExecutorStartup(legacy.lease, {
				timeoutMs: 60000,
			}),
		).toBeNull();
		const reserve = await executorPrepared();
		const { store, lease, intent } = reserve;
		expect(await store.recordExecutorStartup(lease, { timeoutMs: 5000 })).toBe(
			reserve.deadline,
		);
		expect(
			await store.recordExecutorProjectionIntent(lease, {
				...intent,
				podUid: "other-pod",
			}),
		).toBe(false);
		expect(
			await store.recordExecutorProjectionIntent(
				{ ...lease, deliveryFence: lease.deliveryFence - 1 },
				intent,
			),
		).toBe(false);
		expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(
			true,
		);
		expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(
			true,
		);
		// The same attempt never re-keys or changes its binding.
		for (const change of [
			{ hostPublicKey: "other-key" },
			{ hostKeyId: "host-key-2" },
			{ bindingDigest: "d".repeat(64) },
			{ attemptId: "projection-2" },
		])
			expect(
				await store.recordExecutorProjectionIntent(lease, {
					...intent,
					...change,
				}),
			).toBe(false);
		expect(
			await store.recordExecutorProjectionCreateResponse(lease, {
				attemptId: intent.attemptId,
				response: "created",
				resource: { ...reserve.projection, name: "other-secret" },
			}),
		).toBe(false);
		expect(
			await store.recordExecutorProjectionCreateResponse(lease, {
				attemptId: intent.attemptId,
				response: "created",
				resource: reserve.projection,
			}),
		).toBe(true);
		await sql`update platform.session_sandbox_reserves set executor_startup = jsonb_set(executor_startup, '{deadlineMs}', to_jsonb(floor(extract(epoch from clock_timestamp()) * 1000) - 1))`;
		expect(
			await store.recordExecutorConsumption(lease, {
				attemptId: intent.attemptId,
				podUid: reserve.podUid,
				projectionUid: reserve.projection.uid,
				hostKeyId: intent.hostKeyId,
				runnerEpoch: "runner-epoch-1",
				evidence: await reserveEvidence(reserve),
			}),
		).toBe(false);
		expect(await notReady(reserve)).toBe(false);
	});

	it("refuses a projection intent once the original deadline has passed", async () => {
		const late = await executorPrepared();
		await sql`update platform.session_sandbox_reserves set executor_startup = jsonb_set(executor_startup, '{deadlineMs}', to_jsonb(floor(extract(epoch from clock_timestamp()) * 1000) - 1)) where sandbox_id = ${late.sandboxId}`;
		expect(
			await late.store.recordExecutorProjectionIntent(late.lease, late.intent),
		).toBe(false);
		expect(
			await sql`select executor_startup->'projection' as projection from platform.session_sandbox_reserves`,
		).toEqual([{ projection: null }]);
	});

	it("keeps an unknown projection create unclaimable, retirement wins, and budget stays held until absence", async () => {
		const reserve = await executorPrepared();
		const { store, lease, intent, sandboxId } = reserve;
		expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(
			true,
		);
		expect(
			await store.recordExecutorProjectionResult(lease, {
				attemptId: intent.attemptId,
			}),
		).toBe(true);
		const [unknown] =
			await sql`select status from platform.session_sandbox_reserves`;
		expect(unknown?.status).toBe("unknown");
		expect(await notReady(reserve)).toBe(false);
		// A competing new Session cannot claim it and takes the cold path.
		const created = await create();
		expect(created).toMatchObject({ outcome: "accepted" });
		expect(created).not.toMatchObject({
			result: { conversationId: reserve.sessionId },
		});
		const retiring = await retiringLease(store, sandboxId);
		await cleanSix(store, retiring, sandboxId);
		expect(await store.finishRetirement(retiring)).toBe(false);
		// The original writer's late response is still accepted after takeover.
		expect(
			await store.recordExecutorProjectionCreateResponse(lease, {
				attemptId: intent.attemptId,
				response: "created",
				resource: reserve.projection,
			}),
		).toBe(true);
		expect(await store.finishRetirement(retiring)).toBe(false);
		expect(
			await store.recordExecutorProjectionDeleteIntent(retiring, {
				attemptId: "projection-delete-r",
				resource: reserve.projection,
			}),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionDeleteResponse(retiring, {
				attemptId: "projection-delete-r",
				response: "acknowledged",
			}),
		).toBe(true);
		expect(await store.finishRetirement(retiring)).toBe(false);
		expect(
			await sql`select released from platform.session_sandbox_resource_charges where sandbox_id = ${sandboxId}`,
		).toEqual([{ released: false }]);
		expect(
			await store.recordExecutorProjectionDeleteObservation(retiring, {
				attemptId: "projection-delete-r",
			}),
		).toBe(true);
		expect(await store.finishRetirement(retiring)).toBe(true);
		expect(
			await sql`select released from platform.session_sandbox_resource_charges where sandbox_id = ${sandboxId}`,
		).toEqual([{ released: true }]);
	});

	it("restores an unknown reserve to preparing only after the projection response settles too", async () => {
		const reserve = await executorPrepared();
		const { store, lease, intent } = reserve;
		expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(
			true,
		);
		expect(
			await store.recordExecutorProjectionResult(lease, {
				attemptId: intent.attemptId,
			}),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionCreateResponse(lease, {
				attemptId: intent.attemptId,
				response: "rejected",
				resource: null,
			}),
		).toBe(true);
		expect(
			await sql`select status from platform.session_sandbox_reserves`,
		).toEqual([{ status: "preparing" }]);
		// A definite rejection is never consumption evidence.
		expect(
			await store.recordExecutorConsumption(lease, {
				attemptId: intent.attemptId,
				podUid: reserve.podUid,
				projectionUid: reserve.projection.uid,
				hostKeyId: intent.hostKeyId,
				runnerEpoch: "runner-epoch-1",
				evidence: await reserveEvidence(reserve),
			}),
		).toBe(false);
		expect(await notReady(reserve)).toBe(false);
	});

	it("hands the original startup facts to the claimed allocation and never retires it as a startup timeout", async () => {
		const reserve = await executorPrepared();
		await consumeAndRemove(reserve);
		expect(await notReady(reserve)).toBe(true);
		const created = await create();
		expect(created).toMatchObject({
			result: { conversationId: reserve.sessionId },
		});
		const events = await sql<{ details: Record<string, unknown> }[]>`
			select details from platform.conversation_audit_events
			where conversation_id = ${reserve.sessionId} and details->>'checkpoint' = 'executor-startup'`;
		expect(events).toHaveLength(1);
		expect(events[0]?.details).toMatchObject({
			startupRef: reserve.startupRef,
			deadlineMs: reserve.deadline,
			sandboxId: reserve.sandboxId,
			sessionGeneration: 1,
			resourceFence: 1,
			source: "reserve",
			podUid: reserve.podUid,
			hostKeyId: "host-key-1",
			projectionUid: reserve.projection.uid,
		});
		const [outbox] =
			await sql`select id from platform.outbox_items where scope_id = ${reserve.sessionId} and operation = 'conversation.sandbox.reconcile.v1'`;
		if (!outbox) throw new Error("Expected original Sandbox intent");
		const claim = await sql.begin((tx) =>
			claimSandboxReconciliation(
				tx,
				{
					itemId: outbox.id,
					workerId: "business-worker",
					leaseDurationMs: 30000,
				},
				policy,
				directory,
			),
		);
		if (!claim) throw new Error("Expected business claim");
		expect(claim).toMatchObject({ purpose: "prepare", resourceFence: 1 });
		// The business path reads the original deadline instead of signing a new one.
		expect(
			await sql.begin((tx) =>
				recordSandboxExecutorStartup(
					tx,
					claim,
					reserve.startupRef,
					5000,
					policy,
					directory,
				),
			),
		).toBe(reserve.deadline);
		await sql`update platform.conversation_audit_events set details = jsonb_set(details, '{deadlineMs}', to_jsonb(floor(extract(epoch from clock_timestamp()) * 1000) - 1)) where conversation_id = ${reserve.sessionId} and details->>'checkpoint' = 'executor-startup'`;
		const pod = {
			kind: "Pod" as const,
			name: `sandbox-${reserve.sandboxId}`,
			namespace: config.namespace,
			uid: reserve.podUid,
			resourceVersion: "2",
		};
		expect(
			await sql.begin((tx) =>
				recordSandboxExecutorRetirement(tx, claim, [pod], policy, directory),
			),
		).toBeNull();
		expect(
			await sql`select count(*)::int as count from platform.conversation_audit_events where details->>'checkpoint' = 'executor-startup-retirement'`,
		).toEqual([{ count: 0 }]);
	});

	it("does not claim a ready row whose persisted executor evidence no longer satisfies readiness", async () => {
		const reserve = await executorPrepared();
		await consumeAndRemove(reserve);
		expect(await notReady(reserve)).toBe(true);
		await sql`update platform.session_sandbox_reserves set executor_startup = jsonb_set(executor_startup, '{consumption}', 'null'::jsonb)`;
		const created = await create();
		expect(created).toMatchObject({ outcome: "accepted" });
		expect(created).not.toMatchObject({
			result: { conversationId: reserve.sessionId },
		});
		expect(
			await sql`select status from platform.session_sandbox_reserves`,
		).toEqual([{ status: "ready" }]);
	});

	it("leaves single-container reserves unaffected by the new column", async () => {
		const reserve = await ready();
		const [row] =
			await sql`select executor_startup from platform.session_sandbox_reserves`;
		expect(row?.executor_startup).toBeNull();
		expect(await create()).toMatchObject({
			result: { conversationId: reserve.sessionId },
		});
		expect(
			await sql`select count(*)::int as count from platform.conversation_audit_events where details->>'checkpoint' = 'executor-startup'`,
		).toEqual([{ count: 0 }]);
	});

	async function claimedExecutorReserve() {
		const reserve = await executorPrepared();
		await consumeAndRemove(reserve);
		expect(await notReady(reserve)).toBe(true);
		expect(await create()).toMatchObject({
			result: { conversationId: reserve.sessionId },
		});
		const [row] =
			await sql`select profile_digest from platform.session_sandbox_reserves`;
		if (!row) throw new Error("Expected claimed reserve");
		const promotion = {
			sandboxId: reserve.sandboxId,
			sessionId: reserve.sessionId,
			agentId: "agent",
			principal: { kind: "user" as const, id: "user-a" },
			channelId: "web",
			generation: 1,
			resourceFence: 1,
			profileDigest: row.profile_digest as string,
			bindingDigest,
			layoutDigest: "e".repeat(64),
			podUid: reserve.podUid,
			podResourceVersion: "9",
			pvcUid: `PersistentVolumeClaim-uid-${reserve.sandboxId}`,
			hostKeyId: "host-key-1",
			runnerEpoch: "runner-epoch-1",
			evidence: await claimedEvidence(reserve),
		};
		return { reserve, promotion };
	}
	async function claimedEvidence(
		reserve: Prepared,
		overrides: Record<string, unknown> = {},
	) {
		const now = await dbNow();
		return {
			scope: {
				phase: "claimed" as const,
				claimRef: `claim:${reserve.sandboxId}:${reserve.sessionId}`,
				allocationRef: `allocation:${reserve.sandboxId}:${reserve.sessionId}:1:1`,
			},
			podUid: reserve.podUid,
			hostKeyId: "host-key-1",
			runnerEpoch: "runner-epoch-1",
			generation: 1,
			resourceFence: 1,
			issuedAtMs: now,
			observedAtMs: now,
			expiresAtMs: now + 20000,
			...overrides,
		};
	}

	it("rejects a promotion without valid, current claimed instance evidence", async () => {
		const { reserve, promotion } = await claimedExecutorReserve();
		const { evidence: _evidence, ...withoutEvidence } = promotion;
		expect(
			await reserve.store.recordExecutorPromotion(
				withoutEvidence as unknown as typeof promotion,
			),
		).toBeNull();
		const [claimed] = await sql<{ claimed_ms: number }[]>`
			select floor(extract(epoch from claimed_at) * 1000)::float8 as claimed_ms
			from platform.session_sandbox_reserves`;
		const now = await dbNow();
		for (const evidence of [
			await claimedEvidence(reserve, { expiresAtMs: now - 1 }),
			await claimedEvidence(reserve, {
				issuedAtMs: (claimed?.claimed_ms ?? now) - 1000,
				observedAtMs: (claimed?.claimed_ms ?? now) - 1000,
			}),
			await claimedEvidence(reserve, { expiresAtMs: now + 31000 }),
			await claimedEvidence(reserve, { observedAtMs: now + 60000 }),
			await claimedEvidence(reserve, {
				scope: { ...promotion.evidence.scope, claimRef: "claim:other" },
			}),
			await claimedEvidence(reserve, {
				scope: {
					...promotion.evidence.scope,
					allocationRef: `allocation:${reserve.sandboxId}:${reserve.sessionId}:1:2`,
				},
			}),
			await reserveEvidence(reserve),
			await claimedEvidence(reserve, { podUid: "other-pod" }),
			await claimedEvidence(reserve, { runnerEpoch: "runner-epoch-2" }),
			await claimedEvidence(reserve, { resourceFence: 2 }),
		])
			expect(
				await reserve.store.recordExecutorPromotion({
					...promotion,
					evidence: evidence as typeof promotion.evidence,
				}),
			).toBeNull();
		expect(
			await sql`select count(*)::int as count from platform.session_sandbox_executor_promotions`,
		).toEqual([{ count: 0 }]);
		expect(
			await reserve.store.recordExecutorPromotion(promotion),
		).not.toBeNull();
	});

	it("checks the evidence lifetime with the database clock after the allocation lock", async () => {
		const { reserve, promotion } = await claimedExecutorReserve();
		const now = await dbNow();
		const evidence = await claimedEvidence(reserve, {
			expiresAtMs: now + 1500,
		});
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let locked: () => void = () => {};
		const lockTaken = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const holder = sql.begin(async (tx) => {
			await tx`select sandbox_id from platform.session_sandbox_allocations where sandbox_id = ${reserve.sandboxId} for update`;
			locked();
			await held;
		});
		await lockTaken;
		const pending = reserve.store.recordExecutorPromotion({
			...promotion,
			evidence,
		});
		await new Promise((resolve) => setTimeout(resolve, 2500));
		release();
		await holder;
		expect(await pending).toBeNull();
	});

	it("never promotes the original reserve instance under an advanced fence", async () => {
		const { reserve, promotion } = await claimedExecutorReserve();
		await sql`update platform.session_sandbox_allocations set resource_fence = 2 where sandbox_id = ${reserve.sandboxId}`;
		expect(
			await reserve.store.recordExecutorPromotion({
				...promotion,
				resourceFence: 2,
				evidence: await claimedEvidence(reserve, {
					resourceFence: 2,
					scope: {
						...promotion.evidence.scope,
						allocationRef: `allocation:${reserve.sandboxId}:${reserve.sessionId}:1:2`,
					},
				}),
			}),
		).toBeNull();
		expect(
			await sql`select count(*)::int as count from platform.session_sandbox_executor_promotions`,
		).toEqual([{ count: 0 }]);
	});

	it("refuses same-fence replacement Pod or runner epoch evidence for promotion", async () => {
		const { reserve, promotion } = await claimedExecutorReserve();
		for (const change of [
			{ podUid: "replacement-pod" },
			{ runnerEpoch: "runner-epoch-2" },
			{ hostKeyId: "host-key-2" },
		])
			expect(
				await reserve.store.recordExecutorPromotion({
					...promotion,
					...change,
					evidence: await claimedEvidence(reserve, change),
				}),
			).toBeNull();
	});

	it("checks reserve-scope evidence for consumption and ready", async () => {
		const reserve = await executorPrepared();
		const { store, lease, intent, projection, podUid } = reserve;
		expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(
			true,
		);
		expect(
			await store.recordExecutorProjectionCreateResponse(lease, {
				attemptId: intent.attemptId,
				response: "created",
				resource: projection,
			}),
		).toBe(true);
		const consumption = {
			attemptId: intent.attemptId,
			podUid,
			projectionUid: projection.uid,
			hostKeyId: intent.hostKeyId,
			runnerEpoch: "runner-epoch-1",
		};
		const now = await dbNow();
		for (const evidence of [
			await reserveEvidence(reserve, lease, { expiresAtMs: now - 1 }),
			await reserveEvidence(reserve, lease, {
				scope: {
					phase: "reserve",
					reserveRef: `reserve:${reserve.sandboxId}`,
					reserveDeliveryFence: lease.deliveryFence - 1,
				},
			}),
			await reserveEvidence(reserve, lease, {
				scope: {
					phase: "reserve",
					reserveRef: "reserve:other",
					reserveDeliveryFence: lease.deliveryFence,
				},
			}),
			await reserveEvidence(reserve, lease, { runnerEpoch: "runner-epoch-2" }),
			await reserveEvidence(reserve, lease, { podUid: "other-pod" }),
		])
			expect(
				await store.recordExecutorConsumption(lease, {
					...consumption,
					evidence: evidence as Awaited<ReturnType<typeof reserveEvidence>>,
				}),
			).toBe(false);
		expect(
			await store.recordExecutorConsumption(lease, {
				...consumption,
				evidence: await reserveEvidence(reserve),
			}),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionDeleteIntent(lease, {
				attemptId: "projection-delete-1",
				resource: projection,
			}),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionDeleteResponse(lease, {
				attemptId: "projection-delete-1",
				response: "absent",
			}),
		).toBe(true);
		const ready = (instanceEvidence?: unknown) =>
			store.markReady(lease, {
				bootstrapReady: true,
				businessStateAbsent: true,
				...(instanceEvidence
					? {
							instanceEvidence: instanceEvidence as Awaited<
								ReturnType<typeof reserveEvidence>
							>,
						}
					: {}),
			});
		expect(await ready()).toBe(false);
		expect(
			await ready(
				await reserveEvidence(reserve, lease, {
					expiresAtMs: (await dbNow()) - 1,
				}),
			),
		).toBe(false);
		expect(
			await ready(
				await reserveEvidence(reserve, lease, { hostKeyId: "host-key-2" }),
			),
		).toBe(false);
		expect(await ready(await reserveEvidence(reserve))).toBe(true);
	});

	/** Holds a SHARE lock on `table` until `statement` is observed waiting on it, then past `untilMs`. */
	async function blockFinalWrite<T>(
		table: string,
		statement: string,
		untilMs: number,
		write: () => Promise<T>,
	): Promise<T> {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let locked: () => void = () => {};
		const lockTaken = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const holder = sql.begin(async (tx) => {
			await tx.unsafe(`lock table ${table} in share mode`);
			locked();
			await held;
		});
		await lockTaken;
		const pending = write();
		try {
			let waiting = false;
			for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
				const rows = await sql`
					select pid from pg_stat_activity
					where datname = current_database()
						and cardinality(pg_blocking_pids(pid)) > 0
						and query ilike ${`%${statement}%`}`;
				waiting = rows.length === 1;
				if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(waiting).toBe(true);
			while ((await dbNow()) <= untilMs)
				await new Promise((resolve) => setTimeout(resolve, 100));
		} finally {
			release();
		}
		await holder;
		return pending;
	}

	it("commits neither a Pod intent nor a V2 permit when the final grant waits past its database deadline (#4248 B3b)", async () => {
		const store = reserves();
		const sandboxId = await store.prepare("agent");
		const lease = await store.claimLease({
			sandboxId: sandboxId!,
			workerId: "expired-pod-grant",
			leaseDurationMs: 30000,
		});
		if (!lease) throw new Error("Missing lease");
		const started = await store.transitionExecutorReserveInstanceV2(lease, {
			kind: "prepare",
			bindingDigest,
			configurationVersion: "v4",
			timeoutMs: 1500,
			approval: {
				schemaVersion: 2,
				imageDigest: `registry.test/codex@${imageDigest}`,
				verificationRef: "approved-v2",
			},
		});
		if (!started) throw new Error("Missing startup");
		const pending = await blockFinalWrite(
			"platform.session_sandbox_reserves",
			"set executor_startup=",
			started.state.expiresAt,
			() =>
				store.transitionExecutorReserveInstanceV2(
					lease,
					{
						kind: "pod-create",
						attemptId: started.state.attemptId,
						revision: started.state.revision,
					},
					{
						attemptId: "pod-intent",
						operation: "create",
						kind: "Pod",
						name: `sandbox-${sandboxId}`,
						status: "pending",
						resource: null,
						absent: false,
					},
				),
		);
		expect(pending).toBeNull();
		expect((await store.inspect(sandboxId!))?.operations).toEqual([]);
		expect(
			(await store.inspect(sandboxId!))?.executorStartup?.instance,
		).toEqual(started.state);
	});

	it("refuses a promotion whose evidence expires while the final INSERT waits", async () => {
		const { reserve, promotion } = await claimedExecutorReserve();
		const evidence = await claimedEvidence(reserve, {
			expiresAtMs: (await dbNow()) + 1500,
		});
		expect(
			await blockFinalWrite(
				"platform.session_sandbox_executor_promotions",
				"insert into platform.session_sandbox_executor_promotions",
				evidence.expiresAtMs,
				() => reserve.store.recordExecutorPromotion({ ...promotion, evidence }),
			),
		).toBeNull();
		expect(
			await sql`select count(*)::int as count from platform.session_sandbox_executor_promotions`,
		).toEqual([{ count: 0 }]);
	});

	it("refuses consumption and ready whose evidence expires while the final UPDATE waits", async () => {
		const reserve = await executorPrepared();
		const { store, lease, intent, projection, podUid } = reserve;
		expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(
			true,
		);
		expect(
			await store.recordExecutorProjectionCreateResponse(lease, {
				attemptId: intent.attemptId,
				response: "created",
				resource: projection,
			}),
		).toBe(true);
		const consumption = {
			attemptId: intent.attemptId,
			podUid,
			projectionUid: projection.uid,
			hostKeyId: intent.hostKeyId,
			runnerEpoch: "runner-epoch-1",
		};
		const late = await reserveEvidence(reserve, lease, {
			expiresAtMs: (await dbNow()) + 1500,
		});
		expect(
			await blockFinalWrite(
				"platform.session_sandbox_reserves",
				"update platform.session_sandbox_reserves set executor_startup",
				late.expiresAtMs,
				() =>
					store.recordExecutorConsumption(lease, {
						...consumption,
						evidence: late,
					}),
			),
		).toBe(false);
		expect(
			await sql`select executor_startup->'consumption' as consumption from platform.session_sandbox_reserves`,
		).toEqual([{ consumption: null }]);
		expect(
			await store.recordExecutorConsumption(lease, {
				...consumption,
				evidence: await reserveEvidence(reserve),
			}),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionDeleteIntent(lease, {
				attemptId: "projection-delete-1",
				resource: projection,
			}),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionDeleteResponse(lease, {
				attemptId: "projection-delete-1",
				response: "absent",
			}),
		).toBe(true);
		const readyEvidence = await reserveEvidence(reserve, lease, {
			expiresAtMs: (await dbNow()) + 1500,
		});
		expect(
			await blockFinalWrite(
				"platform.session_sandbox_reserves",
				"set status = 'ready'",
				readyEvidence.expiresAtMs,
				() =>
					store.markReady(lease, {
						bootstrapReady: true,
						businessStateAbsent: true,
						instanceEvidence: readyEvidence,
					}),
			),
		).toBe(false);
		expect(
			await sql`select status from platform.session_sandbox_reserves`,
		).toEqual([{ status: "preparing" }]);
		expect(await notReady(reserve)).toBe(true);
	});

	it("keeps an unresolved projection create counted against concurrent creates after retirement", async () => {
		const store = reserves({ ...config, maximumConcurrentCreates: 1 });
		const reserve = await executorPrepared(store);
		expect(
			await store.recordExecutorProjectionIntent(reserve.lease, reserve.intent),
		).toBe(true);
		expect(
			await store.recordExecutorProjectionResult(reserve.lease, {
				attemptId: reserve.intent.attemptId,
			}),
		).toBe(true);
		expect(await store.retire(reserve.sandboxId)).toBe(true);
		expect(await store.prepare("agent")).toBeNull();
		const retiring = await store.claimLease({
			sandboxId: reserve.sandboxId,
			workerId: "worker-retire",
			leaseDurationMs: 30000,
		});
		if (!retiring) throw new Error("Expected retiring lease");
		// The original writer's late response settles the projection write and frees the slot.
		expect(
			await store.recordExecutorProjectionCreateResponse(reserve.lease, {
				attemptId: reserve.intent.attemptId,
				response: "rejected",
				resource: null,
			}),
		).toBe(true);
		expect(await store.prepare("agent")).toBeTypeOf("string");
	});

	it("binds one promotion receipt to the claimed allocation and its original instance", async () => {
		const { reserve, promotion } = await claimedExecutorReserve();
		for (const change of [
			{ sessionId: "other-conversation" },
			{ principal: { kind: "user" as const, id: "user-b" } },
			{ principal: { kind: "application" as const, id: "user-a" } },
			{ agentId: "other-agent" },
			{ channelId: "api" },
			{ generation: 2 },
			{ resourceFence: 2 },
			{ podUid: "replacement-pod" },
			{ hostKeyId: "host-key-2" },
			{ runnerEpoch: "runner-epoch-2" },
			{ pvcUid: "other-pvc" },
			{ profileDigest: "f".repeat(64) },
			{ bindingDigest: "d".repeat(64) },
		])
			expect(
				await reserve.store.recordExecutorPromotion({
					...promotion,
					...change,
				}),
			).toBeNull();
		const receipt = await reserve.store.recordExecutorPromotion(promotion);
		expect(receipt).toMatchObject({
			receiptId: expect.any(String),
			receiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(await reserve.store.recordExecutorPromotion(promotion)).toEqual(
			receipt,
		);
		// The same generation/fence never accepts a second, different receipt.
		expect(
			await reserve.store.recordExecutorPromotion({
				...promotion,
				podResourceVersion: "10",
			}),
		).toBeNull();
		await sql`update platform.session_sandbox_allocations set resource_fence = 2 where sandbox_id = ${reserve.sandboxId}`;
		expect(await reserve.store.recordExecutorPromotion(promotion)).toBeNull();
		expect(
			await sql`select count(*)::int as count from platform.session_sandbox_executor_promotions`,
		).toEqual([{ count: 1 }]);
	});

	it("refuses a promotion receipt for a cold allocation of another user", async () => {
		const { reserve, promotion } = await claimedExecutorReserve();
		const other = await create(execution(), "user-b", "web", "other-user");
		if (other.outcome !== "accepted") throw new Error("Expected cold Session");
		const [allocation] =
			await sql`select sandbox_id from platform.session_sandbox_allocations where conversation_id = ${other.result.conversationId}`;
		expect(
			await reserve.store.recordExecutorPromotion({
				...promotion,
				sandboxId: allocation?.sandbox_id,
				sessionId: other.result.conversationId,
				principal: { kind: "user", id: "user-b" },
			}),
		).toBeNull();
	});

	it("keeps a claimed executor reserve out of business ready until its promotion receipt commits", async () => {
		const { reserve, promotion } = await claimedExecutorReserve();
		const [outbox] =
			await sql`select id from platform.outbox_items where scope_id = ${reserve.sessionId} and operation = 'conversation.sandbox.reconcile.v1'`;
		if (!outbox) throw new Error("Expected original Sandbox intent");
		const claim = await sql.begin((tx) =>
			claimSandboxReconciliation(
				tx,
				{
					itemId: outbox.id,
					workerId: "business-worker",
					leaseDurationMs: 30000,
				},
				policy,
				directory,
			),
		);
		if (!claim?.previousObservation)
			throw new Error("Expected adopted resources");
		const resources = claim.previousObservation.resources;
		const record = (
			observation: Parameters<typeof recordSandboxObservation>[2],
		) =>
			sql.begin((tx) =>
				recordSandboxObservation(tx, claim, observation, policy, directory),
			);
		expect(
			await record({ status: "ready", executorDrainRequired: true, resources }),
		).toBe("stale");
		expect(await record({ status: "ready", resources })).toBe("stale");
		expect(
			await reserve.store.recordExecutorPromotion(promotion),
		).not.toBeNull();
		expect(
			await record({ status: "ready", executorDrainRequired: true, resources }),
		).toBe("committed");
	});
});

it("persists reserve V2 startup before Pod writes and reads the same immutable facts after Worker restart (#4248 B3b)", async () => {
	const store = reserves();
	const sandboxId = await store.prepare("agent");
	if (!sandboxId) throw new Error("Missing reserve");
	const lease = await store.claimLease({
		sandboxId,
		workerId: "worker-v2",
		leaseDurationMs: 30000,
	});
	if (!lease) throw new Error("Missing lease");
	const mutation = {
		kind: "prepare" as const,
		bindingDigest: "c".repeat(64),
		configurationVersion: "config-v4",
		timeoutMs: 60000,
		approval: {
			schemaVersion: 2 as const,
			imageDigest: `registry.test/codex@${imageDigest}`,
			verificationRef: "verified-consumer-v2",
		},
	};
	const first = await store.transitionExecutorReserveInstanceV2(
		lease,
		mutation,
	);
	expect(first?.state.phase).toBe("prepared");
	expect(first?.state.startupRef).toMatch(/^executor-v2-/);
	const replay = await store.transitionExecutorReserveInstanceV2(lease, {
		...mutation,
		timeoutMs: 1000,
	});
	expect(replay?.state).toEqual(first?.state);
	expect(replay?.permit).toBe(false);
	const restarted = await store.inspect(sandboxId);
	expect(restarted?.executorStartup).toMatchObject({
		startupRef: first!.state.startupRef,
		deadlineMs: first!.state.expiresAt,
		instance: first!.state,
	});
	expect(
		await store.transitionExecutorReserveInstanceV2(
			{ ...lease, deliveryFence: lease.deliveryFence + 1 },
			mutation,
		),
	).toBeNull();
	expect(
		await store.transitionExecutorReserveInstanceV2(lease, {
			...mutation,
			bindingDigest: "d".repeat(64),
		}),
	).toBeNull();
	expect((await store.inspect(sandboxId))?.operations).toEqual([]);
});

it("binds the V2 projection response to the original Pod attempt, and includes it in rollback inventory (#4248 B3b)", async () => {
	const store = reserves();
	const sandboxId = await store.prepare("agent");
	const lease = await store.claimLease({
		sandboxId: sandboxId!,
		workerId: "v2-publication",
		leaseDurationMs: 30000,
	});
	if (!lease) throw new Error("Missing lease");
	const first = await store.transitionExecutorReserveInstanceV2(lease, {
		kind: "prepare",
		bindingDigest: "c".repeat(64),
		configurationVersion: "v4",
		timeoutMs: 60000,
		approval: {
			schemaVersion: 2,
			imageDigest: `registry.test/codex@${imageDigest}`,
			verificationRef: "approved-v2",
		},
	});
	if (!first) throw new Error("Missing startup");
	expect(
		await store.transitionExecutorReserveInstanceV2(lease, {
			kind: "pod-create",
			attemptId: first.state.attemptId,
			revision: first.state.revision,
		}),
	).toBeNull();
	const identities = [];
	let state = first.state;
	for (const kind of ["Service", "Pod"] as const) {
		const resource = {
			kind,
			name: `sandbox-${sandboxId}`,
			namespace: config.namespace,
			uid: `${kind}-original`,
			resourceVersion: "1",
		};
		const operation = {
			attemptId: `create-${kind}`,
			operation: "create" as const,
			kind,
			name: resource.name,
			status: "pending" as const,
			resource: null,
			absent: false,
		};
		if (kind === "Pod") {
			const pending = await store.transitionExecutorReserveInstanceV2(
				lease,
				{
					kind: "pod-create",
					attemptId: state.attemptId,
					revision: state.revision,
				},
				operation,
			);
			expect(pending?.permit).toBe(true);
			state = pending!.state;
		} else expect(await store.recordIntent(lease, operation)).toBe(true);
		expect(
			await store.recordCreateResponse(lease, {
				attemptId: `create-${kind}`,
				response: "created",
				resource,
			}),
		).toBe(true);
		identities.push(resource);
	}
	const bound = await store.transitionExecutorReserveInstanceV2(lease, {
		kind: "bind",
		attemptId: state.attemptId,
		revision: state.revision,
		podUid: "Pod-original",
		resources: identities,
	});
	if (!bound) throw new Error("Missing bind");
	state = bound.state;
	const hostPublicKey = Buffer.from("public-host").toString("base64url");
	const intent = {
		attemptId: state.attemptId,
		podUid: "Pod-original",
		hostKeyId: createHash("sha256").update(hostPublicKey).digest("hex"),
		hostPublicKey,
		bindingDigest: state.bindingDigest,
		instanceDelivery: {
			runnerPublicKey: Buffer.from("public-runner").toString("base64url"),
			identityDigest: "d".repeat(64),
		},
	};
	expect(
		await store.recordExecutorProjectionIntent(lease, {
			...intent,
			attemptId: "different-attempt",
		}),
	).toBe(false);
	expect(await store.recordExecutorProjectionIntent(lease, intent)).toBe(true);
	const projection = {
		kind: "Secret" as const,
		name: state.startupRef,
		namespace: config.namespace,
		uid: "original-projection",
		resourceVersion: "1",
	};
	expect(
		await store.recordExecutorProjectionCreateResponse(lease, {
			attemptId: intent.attemptId,
			response: "created",
			resource: projection,
		}),
	).toBe(true);
	expect(
		(await store.inspect(sandboxId!))?.executorStartup?.instance,
	).toMatchObject({ phase: "published", projection });
	const rollbackModule: string = "./executor-instance-rollback-preflight.mjs";
	const { readExecutorInstanceRollbackV2 } = await import(rollbackModule);
	expect(
		await readExecutorInstanceRollbackV2(sql, config.namespace, 1),
	).toMatchObject({ compatible: false, instances: 1, active: 1 });
});
