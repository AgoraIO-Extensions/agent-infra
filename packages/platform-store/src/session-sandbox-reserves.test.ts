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
import { catalogFixture } from "../../model-catalog/src/catalog.fixture.js";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { PostgresSessionSandboxReserveStoreV1 } from "./session-sandbox-reserves.js";

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
async function ready(store = reserves()) {
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
	expect(
		await store.markReady(lease, {
			bootstrapReady: true,
			businessStateAbsent: true,
		}),
	).toBe(true);
	return {
		store,
		lease,
		sandboxId: sandboxId as string,
		sessionId: lease.sessionId,
	};
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
beforeEach(async () => {
	await sql`truncate platform.agents, platform.conversations, platform.platform_applications, platform.platform_api_credentials, platform.relay_key_subjects cascade`;
	await sql`truncate platform.outbox_items, platform.idempotency_records, platform.audit_events, platform.session_sandbox_reserves, platform.session_sandbox_budgets, platform.session_sandbox_resource_charges, platform.platform_user_disables`;
	const configuration = decodeAgentConfigurationRecordV3({
		schemaVersion: 3,
		agentId: "agent",
		revision: 1,
		source: {
			kind: "standard",
			templateId: "codex",
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
		catalog: createFakeModelCatalogAdapterV1(catalogFixture()),
		standardTemplateBinding: {
			templateId: "codex",
			imageDigest,
			driver: "codex",
			protocol: "openai-responses-v1",
		},
		signal: AbortSignal.timeout(1000),
	});
	const manifest = {
		schemaVersion: 1,
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 8080 },
		health: { path: "/healthz" },
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
	await sql`insert into platform.agent_configuration_revisions(agent_id,revision,runtime_revision,source_reference,created_at,configuration) values('agent',1,1,'codex',now(),${sql.json(configuration as unknown as postgres.JSONValue)})`;
	await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,service_availability,workload_revision,fence) values('application','agent','user-a','Agent','Synthetic','available','trace','request',now(),1,1,'running','ready',1,1)`;
	for (const user of ["user-a", "user-b"])
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values('agent',${user},now())`;
	await sql`insert into platform.workload_reconciliations(agent_id,revision,state,next_attempt_at) values('agent',1,${sql.json(state as unknown as postgres.JSONValue)},now())`;
});

describe("real PostgreSQL reserve/Conversation transactions", () => {
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
	it("transfers claimed charges without freeing any CPU/memory/PVC and caps cold paths", async () => {
		const bounded = { ...config, totalBudget: resources };
		const reserve = await ready(reserves(bounded));
		expect(await create(execution(bounded))).toMatchObject({
			result: { conversationId: reserve.sessionId },
		});
		await expect(
			create(execution(bounded), "user-a", "web", "second"),
		).rejects.toThrow();
		await expect(reserves(bounded).prepare("agent")).rejects.toThrow();
		expect(
			await sql`select released,compute_released from platform.session_sandbox_resource_charges`,
		).toEqual([{ released: false, compute_released: false }]);
	});
	it("does not guess unknown legacy allocation costs on enable", async () => {
		const legacy = execution(null);
		await create(legacy);
		await expect(reserves().prepare("agent")).rejects.toThrow();
		expect(
			await sql`select 1 from platform.session_sandbox_reserves`,
		).toHaveLength(0);
	});
	it("never-enabled default-off preserves the cold path without a budget gate or ledger", async () => {
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
		).toHaveLength(0);
		expect(
			await sql`select 1 from platform.session_sandbox_resource_charges`,
		).toHaveLength(0);
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
	it("uses the real API task admission branch, replay and continuation without re-claim", async () => {
		const reserve = await ready();
		const material = `papi_${"A".repeat(43)}`;
		await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('api-app','Synthetic','user-a','app-1')`;
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
