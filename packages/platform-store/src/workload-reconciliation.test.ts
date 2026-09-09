import { createHash, generateKeyPairSync } from "node:crypto";
import {
	type ImageRegistryAdmissionResultV1,
	type PlatformSecretRecordV1,
	validateAgentWorkloadDesiredV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import {
	createAgentManagementV1,
	createWorkloadReconciliationV1,
	immutableSecretNameV1,
	type WorkloadRuntimePortV1,
} from "@agent-infra/platform-core";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import { createSecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
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
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "../../../apps/platform-worker/src/kubernetes.fixture.js";
import { WorkloadKubernetesError } from "../../../apps/platform-worker/src/kubernetes-client.js";
import { createKubernetesRuntimeAdapterV1 } from "../../../apps/platform-worker/src/kubernetes-runtime-adapter.js";
import { createWorkloadRuntimeV1 } from "../../../apps/platform-worker/src/workload-runtime.js";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentManagementTransactionV1 } from "./agent-management.ts";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { openPostgresWorkloadReconciliationStoreV1 } from "./workload-reconciliation.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 90_000 });
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let first: ReturnType<typeof openPostgresWorkloadReconciliationStoreV1>;
let second: ReturnType<typeof openPostgresWorkloadReconciliationStoreV1>;

beforeAll(async () => {
	database = await startPostgresTestDatabase("workload");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { onnotice: () => undefined });
	first = openPostgresWorkloadReconciliationStoreV1({
		...database,
		retryDelayMs: 0,
		monitorDelayMs: 0,
	});
	second = openPostgresWorkloadReconciliationStoreV1({
		...database,
		retryDelayMs: 0,
		monitorDelayMs: 0,
	});
});
afterAll(async () => {
	await first?.close();
	await second?.close();
	await sql?.end();
	await database?.stop();
});
beforeEach(async () => {
	await sql`truncate platform.agents, platform.outbox_items, platform.audit_events, platform.persisted_events, platform.idempotency_records cascade`;
	const configuration = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId: "agent-a",
		revision: 1,
		modelConfiguration: null,
		secrets: [],
		source: {
			kind: "custom",
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admission-a",
			interactionMode: "self-managed",
			identityResponsibility: "self-managed",
			connectionEnabled: false,
		},
	};
	await sql`insert into platform.agents(id, current_configuration_revision, authorization_revision) values ('agent-a', 1, 'authorization-a')`;
	await sql`insert into platform.agent_applications(id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at, management_revision, approval_revision, desired_state, workload_revision, fence) values ('application-a', 'agent-a', 'owner-a', 'Agent', 'Fixture', 'creating', 'trace-a', 'request-a', now(), 1, 1, 'running', 1, 1)`;
	await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values ('agent-a', 1, ${configuration.source.imageDigest}, ${sql.json(configuration as unknown as postgres.JSONValue)}, now())`;
	await sql`insert into platform.agent_owners(agent_id, owner_id, created_at) values ('agent-a', 'owner-a', now())`;
	await sql`insert into platform.outbox_items(id, scope_type, scope_id, operation, payload, trace_id, request_id) values ('task-a', 'agent', 'agent-a', 'agent.workload.reconcile.v1', ${sql.json({ schemaVersion: 1, agentId: "agent-a", revision: 1, workloadRevision: 1, fence: 1, desiredState: "running" })}, 'trace-a', 'request-a')`;
});

async function rejectRegistryAdmission(request: {
	readonly requestId: string;
	readonly traceId: string;
}): Promise<ImageRegistryAdmissionResultV1> {
	return {
		schemaVersion: 1,
		status: "rejected",
		requestId: request.requestId,
		traceId: request.traceId,
		error: {
			schemaVersion: 1,
			code: "IMAGE_NOT_ADMITTED",
			message: "The image is not admitted by deployment policy",
			retryable: false,
			traceId: request.traceId,
		},
	};
}

function runtime(): WorkloadRuntimePortV1 {
	return {
		capabilities: async () => ({}),
		preflight: async (_input, state) => ({
			...state.candidate,
			deployment: { admitted: true },
		}),
		closeRoute: async () => undefined,
		apply: async () => ({ uid: "uid-a", generation: 1 }),
		observe: async () => "healthy",
		activateSecrets: async () => "active",
		promote: async () => undefined,
		discardUnactivatedSecrets: async () => true,
		cleanup: async () => true,
	};
}

function secretCryptoFixture() {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 3072,
	});
	const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
	const privateKeyPkcs8Der = privateKey.export({
		format: "der",
		type: "pkcs8",
	});
	const encryptionKeys = {
		schemaVersion: 1 as const,
		activeWrappingKeyVersion: "key-a",
		keys: [
			{
				schemaVersion: 1 as const,
				keyVersion: "key-a",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
				publicKeySpkiDerBase64: publicKeySpkiDer.toString("base64"),
				publicKeyFingerprint: createHash("sha256")
					.update(publicKeySpkiDer)
					.digest("hex"),
				rsaModulusBits: 3072,
				status: "active" as const,
			},
		],
	};
	const keys = [
		{
			keyVersion: "key-a",
			privateKeyPkcs8DerBase64: privateKeyPkcs8Der.toString("base64"),
		},
	];
	return {
		encryptor: createSecretEncryptorV1({ encryptionKeys }),
		decryptor: createSecretKeyringDecryptorV1({ keys }),
	};
}

async function configureSecretReference(
	revision: number,
	reference: {
		readonly secretId: string;
		readonly name: string;
		readonly version: number;
	},
) {
	const [row] = await sql<
		{ configuration: Record<string, unknown> }[]
	>`select configuration from platform.agent_configuration_revisions where agent_id = 'agent-a' and revision = 1`;
	const configuration = {
		...row?.configuration,
		revision,
		secrets: [{ ...reference, isSet: true }],
	};
	if (revision === 1) {
		await sql`update platform.agent_configuration_revisions set configuration = ${sql.json(configuration)} where agent_id = 'agent-a' and revision = 1`;
		return;
	}
	await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) select 'agent-a', ${revision}, source_reference, ${sql.json(configuration)}, now() from platform.agent_configuration_revisions where agent_id = 'agent-a' and revision = 1`;
	await sql`update platform.agents set current_configuration_revision = ${revision} where id = 'agent-a'`;
}

async function insertSecretRecord(record: PlatformSecretRecordV1) {
	await sql`insert into platform.secret_records(agent_id, secret_id, secret_version, configuration_revision, owner_type, owner_id, name, lifecycle_state, dek_fingerprint, wrapping_key_version, record, created_at, updated_at) values (${record.agentId}, ${record.secretId}, ${record.secretVersion}, ${record.configRevision}, ${record.ownerType}, ${record.ownerId}, ${record.name}, ${record.lifecycleState}, ${record.crypto.dekFingerprint}, ${record.crypto.wrappingKeyVersion}, ${sql.json(record)}, now(), now())`;
}

function materializedRecord(
	record: PlatformSecretRecordV1,
	lifecycleState: "applying" | "observed" | "failed",
) {
	const name = immutableSecretNameV1({
		schemaVersion: 1,
		agentId: record.agentId,
		secretId: record.secretId,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		ownerType: record.ownerType,
		ownerId: record.ownerId,
		name: record.name,
		wrappingKeyVersion: record.crypto.wrappingKeyVersion,
		lifecycleState,
		failureRetryable: lifecycleState === "failed" ? false : null,
		encryptedRecord: record,
	});
	const kubernetesSecretRef = {
		schemaVersion: 1 as const,
		ownerType: record.ownerType,
		ownerId: record.ownerId,
		agentId: record.agentId,
		secretId: record.secretId,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		algorithmVersion: record.crypto.algorithmVersion,
		wrappingAlgorithmVersion: record.crypto.wrappingAlgorithmVersion,
		wrappingKeyVersion: record.crypto.wrappingKeyVersion,
		name,
	};
	const activationFence = {
		schemaVersion: 1 as const,
		agentId: record.agentId,
		secretId: record.secretId,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		kubernetesSecretName: name,
		workloadUid: "workload-a",
		workloadGeneration: 1,
		fence: 1,
	};
	return validatePlatformSecretRecordV1({
		...record,
		lifecycleState,
		...(lifecycleState === "failed"
			? {
					error: {
						schemaVersion: 1,
						code: "SECRET_METADATA_INVALID",
						message: "Secret metadata is invalid",
						retryable: false,
						traceId: "trace-a",
					},
				}
			: { kubernetesSecretRef, activationFence }),
	});
}

async function expectResolverRejection() {
	const step = vi.fn();
	await expect(
		first.runNext("worker-a", async () => {
			step();
			throw new Error("resolver accepted an invalid Secret binding");
		}),
	).rejects.toThrow("Workload reconciliation persistence failed");
	expect(step).not.toHaveBeenCalled();
}

describe("PostgreSQL Workload steps", () => {
	it("starts a new fenced generation after an accepted management command", async () => {
		const worker = createWorkloadReconciliationV1({
			store: first,
			runtime: runtime(),
		});
		for (let i = 0; i < 7; i++) await worker.tick("worker-a");
		const [before] = await sql<
			{
				management_revision: string;
				workload_revision: string;
				fence: string;
			}[]
		>`select management_revision::text, workload_revision::text, fence::text from platform.agent_applications where agent_id = 'agent-a'`;
		expect(before).toEqual({
			management_revision: "2",
			workload_revision: "1",
			fence: "1",
		});

		const transaction = new PostgresAgentManagementTransactionV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			const decision = await createAgentManagementV1(
				transaction,
			).executeManagementCommand(
				{
					schemaVersion: 1,
					command: "stop_agent",
					agentId: "agent-a",
					expectedRevision: 2,
					idempotencyKey: "stop-after-ready",
					requestId: "request-stop-after-ready",
					traceId: "trace-stop-after-ready",
				},
				{
					schemaVersion: 1,
					userId: "owner-a",
					accountStatus: "active",
					organizationIds: [],
					isAdministrator: false,
				},
			);
			expect(decision.outcome).toBe("accepted");
		} finally {
			await transaction.close();
		}

		await worker.tick("worker-a");
		const [after] = await sql<
			{
				workload_revision: string;
				fence: string;
				state: {
					sourceLifecycleRevision: number;
					revision: number;
					fence: number;
					phase: string;
				};
			}[]
		>`select workload_revision::text, fence::text, (select state from platform.workload_reconciliations where agent_id = 'agent-a') state from platform.agent_applications where agent_id = 'agent-a'`;
		expect(after).toEqual({
			workload_revision: "2",
			fence: "2",
			state: expect.objectContaining({
				sourceLifecycleRevision: 2,
				revision: 2,
				fence: 2,
				phase: "closing",
			}),
		});
	});

	it.each([
		{ managementFence: 3, legacyRevision: 7, expectedFence: 8 },
		{ managementFence: 11, legacyRevision: 7, expectedFence: 12 },
	])(
		"takes over a legacy Workload state with management fence $managementFence",
		async ({ managementFence, legacyRevision, expectedFence }) => {
			const [configurationRow] = await sql<
				{ configuration: Record<string, unknown> }[]
			>`select configuration from platform.agent_configuration_revisions where agent_id = 'agent-a' and revision = 1`;
			if (!configurationRow) throw new Error();
			await sql`update platform.agent_applications set fence = ${managementFence} where agent_id = 'agent-a'`;
			await sql`
				insert into platform.workload_reconciliations
					(agent_id, revision, state, next_attempt_at)
				values (
					'agent-a',
					${legacyRevision},
					${sql.json({
						schemaVersion: 1,
						agentId: "agent-a",
						sourceConfigurationRevision: 1,
						sourceLifecycleRevision: 1,
						revision: legacyRevision,
						phase: "preflight",
						candidate: {
							configuration: configurationRow.configuration,
							deployment: null,
						},
						verified: null,
						verifiedRevision: null,
						identity: null,
						rollback: false,
						failureCode: null,
						attempts: 0,
					} as unknown as postgres.JSONValue)},
					clock_timestamp()
				)
			`;

			const step = vi.fn(async (input) => {
				expect(input.management.fence).toBe(expectedFence);
				expect(input.state).toMatchObject({
					revision: legacyRevision,
					fence: expectedFence,
				});
				if (!input.state) throw new Error();
				return input.state;
			});
			expect(await first.runNext("worker-a", step)).toBe("advanced");
			expect(step).toHaveBeenCalledOnce();

			const [application] = await sql<
				{ fence: string }[]
			>`select fence::text from platform.agent_applications where agent_id = 'agent-a'`;
			const [persisted] = await sql<
				{ revision: string; state: { revision: number; fence: number } }[]
			>`select revision::text, state from platform.workload_reconciliations where agent_id = 'agent-a'`;
			expect(application?.fence).toBe(String(expectedFence));
			expect(persisted).toEqual({
				revision: String(legacyRevision),
				state: expect.objectContaining({
					revision: legacyRevision,
					fence: expectedFence,
				}),
			});

			await sql`update platform.agent_applications set fence = ${managementFence} where agent_id = 'agent-a'`;
			await sql`update platform.workload_reconciliations set state = state - 'fence', next_attempt_at = clock_timestamp() where agent_id = 'agent-a'`;
			await expect(
				first.runNext("worker-a", async (input) => {
					expect(input.management.fence).toBe(expectedFence);
					throw new Error("synthetic takeover failure");
				}),
			).rejects.toThrow("Workload reconciliation persistence failed");
			const [rolledBackApplication] = await sql<
				{ fence: string }[]
			>`select fence::text from platform.agent_applications where agent_id = 'agent-a'`;
			const [rolledBackState] = await sql<
				{ has_fence: boolean }[]
			>`select state ? 'fence' as has_fence from platform.workload_reconciliations where agent_id = 'agent-a'`;
			expect(rolledBackApplication?.fence).toBe(String(managementFence));
			expect(rolledBackState?.has_fence).toBe(false);
		},
	);

	it("advances a migrated legacy fence with a real stop command", async () => {
		const [configurationRow] = await sql<
			{ configuration: Record<string, unknown> }[]
		>`select configuration from platform.agent_configuration_revisions where agent_id = 'agent-a' and revision = 1`;
		if (!configurationRow) throw new Error();
		await sql`update platform.agent_applications set status = 'available', service_availability = 'ready', fence = 3 where agent_id = 'agent-a'`;
		await sql`
			insert into platform.workload_reconciliations
				(agent_id, revision, state, next_attempt_at)
			values (
				'agent-a',
				7,
				${sql.json({
					schemaVersion: 1,
					agentId: "agent-a",
					sourceConfigurationRevision: 1,
					sourceLifecycleRevision: 1,
					revision: 7,
					phase: "ready",
					candidate: {
						configuration: configurationRow.configuration,
						deployment: { admitted: true },
					},
					verified: {
						configuration: configurationRow.configuration,
						deployment: { admitted: true },
					},
					verifiedRevision: 7,
					identity: { uid: "uid-a", generation: 1 },
					rollback: false,
					failureCode: null,
					attempts: 0,
				} as unknown as postgres.JSONValue)},
				clock_timestamp()
			)
		`;
		await first.runNext("worker-migrate", async (input) => {
			expect(input.management.fence).toBe(8);
			if (!input.state) throw new Error();
			return input.state;
		});

		const transaction = new PostgresAgentManagementTransactionV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			const decision = await createAgentManagementV1(
				transaction,
			).executeManagementCommand(
				{
					schemaVersion: 1,
					command: "stop_agent",
					agentId: "agent-a",
					expectedRevision: 1,
					idempotencyKey: "stop-after-legacy-takeover",
					requestId: "request-stop-after-legacy-takeover",
					traceId: "trace-stop-after-legacy-takeover",
				},
				{
					schemaVersion: 1,
					userId: "owner-a",
					accountStatus: "active",
					organizationIds: [],
					isAdministrator: false,
				},
			);
			expect(decision.outcome).toBe("accepted");
		} finally {
			await transaction.close();
		}

		await createWorkloadReconciliationV1({
			store: first,
			runtime: runtime(),
		}).tick("worker-stop");
		const [result] = await sql<
			{
				fence: string;
				workload_revision: string;
				state: {
					fence: number;
					revision: number;
					sourceLifecycleRevision: number;
					phase: string;
				};
			}[]
		>`select fence::text, workload_revision::text, (select state from platform.workload_reconciliations where agent_id = 'agent-a') state from platform.agent_applications where agent_id = 'agent-a'`;
		expect(result).toEqual({
			fence: "9",
			workload_revision: "2",
			state: expect.objectContaining({
				fence: 9,
				revision: 8,
				sourceLifecycleRevision: 2,
				phase: "closing",
			}),
		});
	});

	it.each([false, true])(
		"resolves interrupted cleaning Secrets from historical candidate, initial=%s",
		async (initial) => {
			const crypto = secretCryptoFixture();
			const candidateSecret = crypto.encryptor.encrypt({
				schemaVersion: 1,
				secretId: "candidate-history-key",
				ownerType: "agent-owner",
				ownerId: "owner-a",
				agentId: "agent-a",
				name: "CANDIDATE_HISTORY_KEY",
				secretVersion: 1,
				configRevision: 2,
				plaintext: "synthetic-candidate-history-value",
				occurredAt: "2026-09-09T00:00:00Z",
			});
			const [base] = await sql<
				{ configuration: Record<string, unknown> }[]
			>`select configuration from platform.agent_configuration_revisions where agent_id = 'agent-a' and revision = 1`;
			if (!base) throw new Error();
			const candidateConfiguration = {
				...base.configuration,
				revision: 2,
				secrets: [
					{
						secretId: candidateSecret.secretId,
						name: candidateSecret.name,
						version: candidateSecret.secretVersion,
						isSet: true,
					},
				],
			};
			const currentConfiguration = {
				...base.configuration,
				revision: 3,
				source: {
					...(base.configuration.source as Record<string, unknown>),
					imageDigest: `sha256:${"c".repeat(64)}`,
				},
				secrets: [],
			};
			await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values ('agent-a', 2, 'candidate-history', ${sql.json(candidateConfiguration)}, now()), ('agent-a', 3, ${currentConfiguration.source.imageDigest}, ${sql.json(currentConfiguration)}, now())`;
			await sql`update platform.agents set current_configuration_revision = 3 where id = 'agent-a'`;
			await insertSecretRecord(candidateSecret);
			await sql`insert into platform.workload_reconciliations(agent_id, revision, state, next_attempt_at) values ('agent-a', 2, ${sql.json(
				{
					schemaVersion: 1,
					agentId: "agent-a",
					sourceConfigurationRevision: 3,
					sourceLifecycleRevision: 1,
					revision: 2,
					fence: 1,
					phase: "cleaning",
					candidate: {
						configuration: candidateConfiguration,
						deployment: null,
					},
					verified: initial
						? null
						: { configuration: base.configuration, deployment: null },
					verifiedRevision: initial ? null : 1,
					identity: { uid: "uid-candidate", generation: 2 },
					rollback: false,
					cleanupInterrupted: true,
					failureCode: "reconciliation_failed",
					attempts: 0,
				} as unknown as postgres.JSONValue,
			)}, clock_timestamp())`;

			const step = vi.fn(async (input) => {
				expect(input.configuration.revision).toBe(3);
				expect(input.secrets?.bindings).toHaveLength(1);
				expect(
					validatePlatformSecretRecordV1(input.secrets?.bindings[0]?.record)
						.configRevision,
				).toBe(2);
				if (!input.state) throw new Error();
				return input.state;
			});
			expect(await first.runNext("worker-history", step)).toBe("advanced");
			expect(step).toHaveBeenCalledOnce();
		},
	);

	it("binds unchanged Secrets to image and environment revisions without stale activation", async () => {
		const crypto = secretCryptoFixture();
		const record = crypto.encryptor.encrypt({
			schemaVersion: 1,
			secretId: "fixture-key",
			ownerType: "agent-owner",
			ownerId: "owner-a",
			agentId: "agent-a",
			name: "FIXTURE_KEY",
			secretVersion: 1,
			configRevision: 1,
			plaintext: "synthetic-fixture-value",
			occurredAt: "2026-09-07T00:00:00Z",
		});
		await sql`update platform.agent_configuration_revisions set configuration = jsonb_set(configuration, '{secrets}', ${sql.json([{ secretId: record.secretId, name: record.name, version: 1, isSet: true }])}) where agent_id = 'agent-a'`;
		await sql`insert into platform.secret_records(agent_id, secret_id, secret_version, configuration_revision, owner_type, owner_id, name, lifecycle_state, dek_fingerprint, wrapping_key_version, record, created_at, updated_at) values ('agent-a', ${record.secretId}, 1, 1, 'agent-owner', 'owner-a', ${record.name}, 'pending', ${record.crypto.dekFingerprint}, 'key-a', ${sql.json(record)}, now(), now())`;
		const api = fakeKubernetesApi();
		const buffers: Uint8Array[] = [];
		api.failAfter(2);
		async function advance(registry = workloadRegistryFixture()) {
			for (let i = 0; i < 12; i++) {
				const runtime = createWorkloadRuntimeV1({
					workerId: `worker-${i}`,
					client: api.client,
					policy: workloadTestPolicy,
					registry,
					admissionPolicyRef: "policy-a",
					registrySubjectRef: "subject-a",
					decryptor: {
						async decrypt(input) {
							const result = await crypto.decryptor.decrypt(input);
							if (result.outcome === "decrypted")
								buffers.push(result.plaintext);
							return result;
						},
					},
					fetch: async () => new Response("ok"),
					probeRuntime: async () => ({ core: "passed", capabilities: {} }),
				});
				await createWorkloadReconciliationV1({
					store: i % 2 ? first : second,
					runtime,
				}).tick(`worker-${i}`);
			}
		}
		await advance();
		const [secret] = await sql`select record from platform.secret_records`;
		expect(secret?.record.lifecycleState).toBe("active");
		expect(
			(await sql`select state from platform.workload_reconciliations`)[0]?.state
				.phase,
		).toBe("ready");
		expect(
			[...api.resources.values()].filter(
				(resource) => resource.kind === "Secret",
			),
		).toHaveLength(1);
		expect(buffers.length).toBeGreaterThan(1);
		expect(buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(
			true,
		);
		const audits = await sql`select action, details from platform.audit_events`;
		expect(audits.some((audit) => audit.action === "secret.decrypt")).toBe(
			true,
		);
		expect(JSON.stringify(audits)).not.toContain("synthetic-fixture-value");
		const [old] =
			await sql`select configuration from platform.agent_configuration_revisions where revision = 1`;
		const activationCount = (
			await sql`select * from platform.audit_events where action = 'secret.activate'`
		).length;
		const upgraded = {
			...old?.configuration,
			revision: 2,
			source: {
				...old?.configuration.source,
				imageDigest: `sha256:${"b".repeat(64)}`,
			},
		};
		await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values ('agent-a', 2, ${upgraded.source.imageDigest}, ${sql.json(upgraded)}, now())`;
		await sql`update platform.agents set current_configuration_revision = 2 where id = 'agent-a'`;
		const decryptCount = buffers.length;
		await advance();
		expect(
			(await sql`select state from platform.workload_reconciliations`)[0]
				?.state,
		).toMatchObject({
			phase: "ready",
			sourceConfigurationRevision: 2,
			candidate: { configuration: { revision: 2 } },
		});
		const revisionTwo = await sql<
			{
				configuration_revision: string;
				lifecycle_state: string;
				record: { crypto: { aadBinding: { configRevision: number } } };
			}[]
		>`
			select configuration_revision::text, lifecycle_state, record
			from platform.secret_records order by configuration_revision
		`;
		expect(revisionTwo).toHaveLength(1);
		expect(revisionTwo[0]).toMatchObject({
			configuration_revision: "1",
			lifecycle_state: "active",
			record: { crypto: { aadBinding: { configRevision: 1 } } },
		});
		expect(buffers).toHaveLength(decryptCount);
		expect(
			await sql`select * from platform.audit_events where action = 'secret.activate'`,
		).toHaveLength(activationCount);

		const envOnlyUpgrade = {
			...upgraded,
			revision: 3,
			environment: [{ name: "SYNTHETIC_FLAG", value: "enabled" }],
		};
		await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values ('agent-a', 3, ${envOnlyUpgrade.source.imageDigest}, ${sql.json(envOnlyUpgrade)}, now())`;
		await sql`update platform.agents set current_configuration_revision = 3 where id = 'agent-a'`;
		await Promise.all([
			createWorkloadReconciliationV1({
				store: first,
				runtime: createWorkloadRuntimeV1({
					workerId: "worker-r3-a",
					client: api.client,
					policy: workloadTestPolicy,
					registry: workloadRegistryFixture(),
					admissionPolicyRef: "policy-a",
					registrySubjectRef: "subject-a",
					decryptor: crypto.decryptor,
					fetch: async () => new Response("ok"),
					probeRuntime: async () => ({ core: "passed", capabilities: {} }),
				}),
			}).tick("worker-r3-a"),
			createWorkloadReconciliationV1({
				store: second,
				runtime: createWorkloadRuntimeV1({
					workerId: "worker-r3-b",
					client: api.client,
					policy: workloadTestPolicy,
					registry: workloadRegistryFixture(),
					admissionPolicyRef: "policy-a",
					registrySubjectRef: "subject-a",
					decryptor: crypto.decryptor,
					fetch: async () => new Response("ok"),
					probeRuntime: async () => ({ core: "passed", capabilities: {} }),
				}),
			}).tick("worker-r3-b"),
		]);
		await advance();
		await advance();
		const revisionThree = await sql<
			{
				configuration_revision: string;
				lifecycle_state: string;
				record: { crypto: { aadBinding: { configRevision: number } } };
			}[]
		>`
			select configuration_revision::text, lifecycle_state, record
			from platform.secret_records order by configuration_revision
		`;
		expect(revisionThree).toHaveLength(1);
		expect(revisionThree[0]).toMatchObject({
			configuration_revision: "1",
			lifecycle_state: "active",
			record: { crypto: { aadBinding: { configRevision: 1 } } },
		});
		expect(buffers).toHaveLength(decryptCount);

		const skippedRevision = {
			...envOnlyUpgrade,
			revision: 4,
			source: {
				...envOnlyUpgrade.source,
				imageDigest: `sha256:${"d".repeat(64)}`,
			},
		};
		const newestRevision = {
			...skippedRevision,
			revision: 5,
			source: {
				...skippedRevision.source,
				imageDigest: `sha256:${"e".repeat(64)}`,
			},
		};
		await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values ('agent-a', 4, ${skippedRevision.source.imageDigest}, ${sql.json(skippedRevision)}, now()), ('agent-a', 5, ${newestRevision.source.imageDigest}, ${sql.json(newestRevision)}, now())`;
		await sql`update platform.agents set current_configuration_revision = 5 where id = 'agent-a'`;
		await advance();
		const afterStaleRevision = await sql<
			{
				configuration_revision: string;
				lifecycle_state: string;
			}[]
		>`
			select configuration_revision::text, lifecycle_state
			from platform.secret_records order by configuration_revision
		`;
		expect(afterStaleRevision).toEqual([
			{ configuration_revision: "1", lifecycle_state: "active" },
		]);
		expect(
			(await sql`select state from platform.workload_reconciliations`)[0]
				?.state,
		).toMatchObject({ sourceConfigurationRevision: 5, phase: "ready" });

		const rejectedRevision = {
			...newestRevision,
			revision: 6,
			source: {
				...newestRevision.source,
				imageDigest: `sha256:${"f".repeat(64)}`,
			},
		};
		await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values ('agent-a', 6, ${rejectedRevision.source.imageDigest}, ${sql.json(rejectedRevision)}, now())`;
		await sql`update platform.agents set current_configuration_revision = 6 where id = 'agent-a'`;
		await advance({
			admit: rejectRegistryAdmission,
		});
		expect(
			(await sql`select state from platform.workload_reconciliations`)[0]
				?.state,
		).toMatchObject({
			phase: "rejected",
			verified: { configuration: { revision: 5 } },
		});
		expect(
			await sql`select * from platform.secret_records where configuration_revision = 6`,
		).toHaveLength(0);
		expect(
			(
				await sql`select record from platform.secret_records where configuration_revision = 1`
			)[0]?.record.lifecycleState,
		).toBe("active");

		const deniedRevision = {
			...rejectedRevision,
			revision: 7,
			source: {
				...rejectedRevision.source,
				imageDigest: `sha256:${"7".repeat(64)}`,
			},
		};
		await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values ('agent-a', 7, ${deniedRevision.source.imageDigest}, ${sql.json(deniedRevision)}, now())`;
		await sql`update platform.agents set current_configuration_revision = 7 where id = 'agent-a'`;
		await advance({
			admit: rejectRegistryAdmission,
		});
		expect(
			await sql`select * from platform.secret_records where configuration_revision = 7`,
		).toHaveLength(0);
	});
	it.each([
		["pending", false],
		["applying", false],
		["observed", false],
		["observed", true],
	] as const)(
		"reclaims a failed current %s Secret with verified rollback %s",
		async (lifecycleState, hasVerifiedWorkload) => {
			const crypto = secretCryptoFixture();
			const origin = crypto.encryptor.encrypt({
				schemaVersion: 1,
				secretId: "origin-key",
				ownerType: "agent-owner",
				ownerId: "owner-a",
				agentId: "agent-a",
				name: "ORIGIN_KEY",
				secretVersion: 1,
				configRevision: 1,
				plaintext: "synthetic-origin-value",
				occurredAt: "2026-09-08T00:00:00Z",
			});
			const activeOrigin = validatePlatformSecretRecordV1({
				...materializedRecord(origin, "observed"),
				lifecycleState: "active",
			});
			if (activeOrigin.lifecycleState !== "active") throw new Error();
			const pending = crypto.encryptor.encrypt({
				schemaVersion: 1,
				secretId: "candidate-key",
				ownerType: "agent-owner",
				ownerId: "owner-a",
				agentId: "agent-a",
				name: "CANDIDATE_KEY",
				secretVersion: 1,
				configRevision: 2,
				plaintext: "synthetic-candidate-value",
				occurredAt: "2026-09-08T00:00:00Z",
			});
			const [base] = await sql<
				{ configuration: Record<string, unknown>; source_reference: string }[]
			>`select configuration, source_reference from platform.agent_configuration_revisions where agent_id = 'agent-a' and revision = 1`;
			const originReference = {
				secretId: origin.secretId,
				name: origin.name,
				version: origin.secretVersion,
				isSet: true,
			};
			const candidateConfigurationReference = {
				secretId: pending.secretId,
				name: pending.name,
				version: pending.secretVersion,
				isSet: true,
			};
			const originConfiguration = {
				...base?.configuration,
				secrets: [originReference],
			};
			const originSource = base?.configuration.source;
			if (
				!originSource ||
				typeof originSource !== "object" ||
				Array.isArray(originSource)
			)
				throw new Error("Fixture configuration is unavailable");
			const originImageDigest = Reflect.get(originSource, "imageDigest");
			if (typeof originImageDigest !== "string")
				throw new Error("Fixture image is unavailable");
			const candidateConfiguration = {
				...originConfiguration,
				revision: 2,
				source: {
					...originSource,
					imageDigest: `sha256:${"b".repeat(64)}`,
				},
				secrets: [candidateConfigurationReference, originReference],
			};
			await sql`update platform.agent_configuration_revisions set configuration = ${sql.json(originConfiguration)} where agent_id = 'agent-a' and revision = 1`;
			await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values ('agent-a', 2, ${candidateConfiguration.source.imageDigest}, ${sql.json(candidateConfiguration)}, now())`;
			await sql`update platform.agents set current_configuration_revision = 2 where id = 'agent-a'`;
			await insertSecretRecord(activeOrigin);

			const api = fakeKubernetesApi();
			const originName = immutableSecretNameV1({
				schemaVersion: 1,
				agentId: activeOrigin.agentId,
				secretId: activeOrigin.secretId,
				secretVersion: activeOrigin.secretVersion,
				configRevision: activeOrigin.configRevision,
				ownerType: activeOrigin.ownerType,
				ownerId: activeOrigin.ownerId,
				name: activeOrigin.name,
				wrappingKeyVersion: activeOrigin.crypto.wrappingKeyVersion,
				lifecycleState: "active",
				failureRetryable: null,
				encryptedRecord: activeOrigin,
			});
			api.resources.set(`Secret/${originName}`, {
				apiVersion: "v1",
				kind: "Secret",
				metadata: { name: originName },
			});
			const candidateReference = {
				schemaVersion: 1 as const,
				ownerType: pending.ownerType,
				ownerId: pending.ownerId,
				agentId: pending.agentId,
				secretId: pending.secretId,
				secretVersion: pending.secretVersion,
				configRevision: pending.configRevision,
				algorithmVersion: pending.crypto.algorithmVersion,
				wrappingAlgorithmVersion: pending.crypto.wrappingAlgorithmVersion,
				wrappingKeyVersion: pending.crypto.wrappingKeyVersion,
				name: immutableSecretNameV1({
					schemaVersion: 1,
					agentId: pending.agentId,
					secretId: pending.secretId,
					secretVersion: pending.secretVersion,
					configRevision: pending.configRevision,
					ownerType: pending.ownerType,
					ownerId: pending.ownerId,
					name: pending.name,
					wrappingKeyVersion: pending.crypto.wrappingKeyVersion,
					lifecycleState,
					failureRetryable: null,
					encryptedRecord: pending,
				}),
			};
			const fixtureDesired = workloadDesiredFixture(2);
			const candidateDesired = validateAgentWorkloadDesiredV1({
				...fixtureDesired,
				fence: 1,
				imageDigest: candidateConfiguration.source.imageDigest,
				registryAdmission: {
					...fixtureDesired.registryAdmission,
					immutableDigest: candidateConfiguration.source.imageDigest,
					policyEvidence: {
						...fixtureDesired.registryAdmission.policyEvidence,
						imageDigest: candidateConfiguration.source.imageDigest,
					},
				},
				secretRefs: [candidateReference],
			});
			const rejectedClient = {
				...api.client,
				async create(object: Parameters<typeof api.client.create>[0]) {
					if (object.kind !== "Secret")
						throw new WorkloadKubernetesError("unavailable");
					return api.client.create(object);
				},
			} as typeof api.client;
			let client = rejectedClient;
			if (lifecycleState === "pending") {
				await insertSecretRecord(pending);
			} else {
				const adapter = createKubernetesRuntimeAdapterV1({
					client: api.client,
					policy: workloadTestPolicy,
					probe: async () => true,
				});
				const secretUid = await adapter.applyImmutableSecret(
					candidateDesired,
					candidateReference.name,
					pending.name,
					new Uint8Array([1, 2, 3]),
				);
				const identity = await adapter.apply(candidateDesired);
				if (!identity || identity === "pending") throw new Error();
				const originDesired = validateAgentWorkloadDesiredV1({
					...candidateDesired,
					requestId: "request-origin",
					configRevision: 1,
					workloadRevision: 1,
					fence: 1,
					expectedWorkload: {
						state: "present",
						workloadUid: identity.uid,
						workloadGeneration: identity.generation,
					},
					imageDigest: originImageDigest,
					registryAdmission: {
						...candidateDesired.registryAdmission,
						immutableDigest: originImageDigest,
						policyEvidence: {
							...candidateDesired.registryAdmission.policyEvidence,
							imageDigest: originImageDigest,
						},
					},
					secretRefs: [activeOrigin.kubernetesSecretRef],
				});
				const activationFence = {
					schemaVersion: 1 as const,
					agentId: pending.agentId,
					secretId: pending.secretId,
					secretVersion: pending.secretVersion,
					configRevision: pending.configRevision,
					kubernetesSecretName: candidateReference.name,
					workloadUid: identity.uid,
					workloadGeneration: identity.generation,
					fence: 7,
				};
				await adapter.bindSecretFence(
					candidateDesired,
					identity,
					candidateReference.name,
					activationFence.fence,
					secretUid,
				);
				await insertSecretRecord(
					validatePlatformSecretRecordV1({
						...pending,
						lifecycleState,
						kubernetesSecretRef: candidateReference,
						activationFence,
					}),
				);
				await sql`insert into platform.workload_reconciliations(agent_id, revision, state, next_attempt_at) values ('agent-a', 2, ${sql.json(
					{
						schemaVersion: 1,
						agentId: "agent-a",
						sourceConfigurationRevision: 2,
						sourceLifecycleRevision: 1,
						revision: 2,
						fence: 1,
						phase: "cleaning",
						candidate: {
							configuration: candidateConfiguration,
							deployment: candidateDesired,
						},
						verified: hasVerifiedWorkload
							? {
									configuration: originConfiguration,
									deployment: originDesired,
								}
							: null,
						verifiedRevision: hasVerifiedWorkload ? 1 : null,
						identity,
						rollback: false,
						failureCode: "reconciliation_failed",
						attempts: 0,
					},
				)}, clock_timestamp())`;
				client = api.client;
			}
			const runtime = createWorkloadRuntimeV1({
				workerId: "worker-cleanup",
				client,
				policy: workloadTestPolicy,
				registry: workloadRegistryFixture(),
				admissionPolicyRef: "policy-a",
				registrySubjectRef: "subject-a",
				decryptor: crypto.decryptor,
				fetch: async () => new Response("ok"),
				probeRuntime: async () => ({ core: "passed", capabilities: {} }),
			});
			const worker = createWorkloadReconciliationV1({
				store: first,
				runtime,
				maximumAttempts: 2,
			});
			for (let i = 0; i < (lifecycleState === "pending" ? 6 : 1); i++)
				await worker.tick("worker-cleanup");

			expect(
				(await sql`select state from platform.workload_reconciliations`)[0]
					?.state,
			).toMatchObject(
				hasVerifiedWorkload
					? {
							phase: "applying",
							rollback: true,
							revision: 3,
							sourceConfigurationRevision: 2,
							candidate: { configuration: { revision: 1 } },
						}
					: { phase: "failed", sourceConfigurationRevision: 2 },
			);
			expect(
				await sql<
					{ secret_id: string; lifecycle_state: string; record: unknown }[]
				>`select secret_id, lifecycle_state, record from platform.secret_records order by secret_id`,
			).toEqual([
				{
					secret_id: "candidate-key",
					lifecycle_state: "failed",
					record: expect.anything(),
				},
				{
					secret_id: "origin-key",
					lifecycle_state: "active",
					record: expect.anything(),
				},
			]);
			expect(
				(
					await sql`select record from platform.secret_records where secret_id = 'candidate-key'`
				)[0]?.record,
			).toMatchObject({
				lifecycleState: "failed",
				error: { code: "SECRET_ACTIVATION_FAILED", retryable: true },
			});
			expect(
				[...api.resources.values()]
					.filter((resource) => resource.kind === "Secret")
					.map((resource) => resource.metadata?.name),
			).toEqual([originName]);
			if (hasVerifiedWorkload) {
				expect(
					await api.client.read("StatefulSet", candidateDesired.service.name),
				).not.toBeNull();
				expect(
					await api.client.read(
						"PersistentVolumeClaim",
						candidateDesired.persistentVolume.name,
					),
				).not.toBeNull();
			} else {
				expect(
					[...api.resources.values()].filter(
						(resource) =>
							resource.kind === "Ingress" || resource.kind === "Service",
					),
				).toEqual([]);
			}
		},
	);
	it("rejects foreign owner, foreign Agent, retired, and mismatched Secret material", async () => {
		const crypto = secretCryptoFixture();
		const pending = crypto.encryptor.encrypt({
			schemaVersion: 1,
			secretId: "fixture-key",
			ownerType: "agent-owner",
			ownerId: "owner-a",
			agentId: "agent-a",
			name: "FIXTURE_KEY",
			secretVersion: 1,
			configRevision: 1,
			plaintext: "synthetic-fixture-value",
			occurredAt: "2026-09-07T00:00:00Z",
		});
		await configureSecretReference(1, {
			secretId: pending.secretId,
			name: pending.name,
			version: pending.secretVersion,
		});
		const foreignOwner = validatePlatformSecretRecordV1({
			...pending,
			ownerId: "owner-b",
			crypto: {
				...pending.crypto,
				aadBinding: { ...pending.crypto.aadBinding, ownerId: "owner-b" },
			},
		});
		await insertSecretRecord(foreignOwner);
		await expectResolverRejection();

		await sql`truncate platform.secret_records, platform.retired_secret_wrapping_keys cascade`;
		await insertSecretRecord(pending);
		await sql`insert into platform.retired_secret_wrapping_keys(key_version, retired_at) values (${pending.crypto.wrappingKeyVersion}, now())`;
		await expectResolverRejection();

		await sql`truncate platform.secret_records, platform.retired_secret_wrapping_keys cascade`;
		const mismatchedVersion = validatePlatformSecretRecordV1({
			...pending,
			secretVersion: 2,
			crypto: {
				...pending.crypto,
				dekFingerprint: "f".repeat(64),
				aadBinding: { ...pending.crypto.aadBinding, secretVersion: 2 },
			},
		});
		await insertSecretRecord(mismatchedVersion);
		await expectResolverRejection();

		await sql`insert into platform.agents(id, current_configuration_revision, authorization_revision) values ('agent-b', 1, 'authorization-b')`;
		await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) select 'agent-b', 1, source_reference, jsonb_set(configuration, '{agentId}', '"agent-b"'), now() from platform.agent_configuration_revisions where agent_id = 'agent-a' and revision = 1`;
		await sql`insert into platform.agent_owners(agent_id, owner_id, created_at) values ('agent-b', 'owner-b', now())`;
		const foreignAgent = validatePlatformSecretRecordV1({
			...pending,
			agentId: "agent-b",
			ownerId: "owner-b",
			crypto: {
				...pending.crypto,
				dekFingerprint: "e".repeat(64),
				aadBinding: {
					...pending.crypto.aadBinding,
					agentId: "agent-b",
					ownerId: "owner-b",
				},
			},
		});
		await insertSecretRecord(foreignAgent);
		await expectResolverRejection();
	});
	it.each(["pending", "applying", "observed", "failed"] as const)(
		"rejects a historical %s Secret record",
		async (lifecycleState) => {
			const crypto = secretCryptoFixture();
			const pending = crypto.encryptor.encrypt({
				schemaVersion: 1,
				secretId: "fixture-key",
				ownerType: "agent-owner",
				ownerId: "owner-a",
				agentId: "agent-a",
				name: "FIXTURE_KEY",
				secretVersion: 1,
				configRevision: 1,
				plaintext: "synthetic-fixture-value",
				occurredAt: "2026-09-07T00:00:00Z",
			});
			await configureSecretReference(2, {
				secretId: pending.secretId,
				name: pending.name,
				version: pending.secretVersion,
			});
			await insertSecretRecord(
				lifecycleState === "pending"
					? pending
					: materializedRecord(pending, lifecycleState),
			);
			await expectResolverRejection();
		},
	);
	it("runs A-to-B, rejects C, recovers each step on another Worker and retains one PVC", async () => {
		const api = fakeKubernetesApi();
		const registry = workloadRegistryFixture();
		let reject = false;
		const options = {
			workerId: "worker-a",
			client: api.client,
			policy: workloadTestPolicy,
			registry: {
				admit: (request: Parameters<typeof registry.admit>[0]) => {
					if (reject) return rejectRegistryAdmission(request);
					return registry.admit(request);
				},
			},
			admissionPolicyRef: "policy-a",
			registrySubjectRef: "subject-a",
			decryptor: {
				decrypt: async () => ({
					outcome: "failed" as const,
					code: "SECRET_KEY_UNAVAILABLE" as const,
				}),
			},
			fetch: (async () => new Response("ok")) as typeof fetch,
			probeRuntime: async () => ({ core: "passed" as const, capabilities: {} }),
		};
		async function advance(times: number) {
			for (let i = 0; i < times; i++) {
				await createWorkloadReconciliationV1({
					store: i % 2 ? first : second,
					runtime: createWorkloadRuntimeV1(options),
				}).tick(`worker-${i % 2}`);
			}
		}
		await advance(8);
		const before =
			await sql`select state from platform.workload_reconciliations`;
		expect(before[0]?.state.phase).toBe("ready");
		const pvc = [...api.resources.values()].find(
			(resource) => resource.kind === "PersistentVolumeClaim",
		);
		async function revise(revision: number, digit: string) {
			const [row] =
				await sql`select configuration from platform.agent_configuration_revisions where revision = 1`;
			const configuration = {
				...row?.configuration,
				revision,
				source: {
					...row?.configuration.source,
					imageDigest: `sha256:${digit.repeat(64)}`,
				},
			};
			await sql`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values ('agent-a', ${revision}, ${configuration.source.imageDigest}, ${sql.json(configuration)}, now())`;
			await sql`update platform.agents set current_configuration_revision = ${revision} where id = 'agent-a'`;
		}
		await revise(2, "b");
		await advance(10);
		expect(
			(await sql`select state from platform.workload_reconciliations`)[0]?.state
				.verified.configuration.source.imageDigest,
		).toBe(`sha256:${"b".repeat(64)}`);
		reject = true;
		await revise(3, "c");
		const writes = api.writes.length;
		await advance(4);
		expect(api.writes).toHaveLength(writes);
		expect(
			(await sql`select state from platform.workload_reconciliations`)[0]?.state
				.phase,
		).toBe("rejected");
		expect(
			[...api.resources.values()].filter(
				(resource) => resource.kind === "Ingress",
			),
		).toHaveLength(1);
		expect(
			[...api.resources.values()].find(
				(resource) => resource.kind === "PersistentVolumeClaim",
			)?.metadata?.uid,
		).toBe(pvc?.metadata?.uid);
	});
	it("persists progress, consumes outbox once, and writes lifecycle observations with audit atomically", async () => {
		const worker = createWorkloadReconciliationV1({
			store: first,
			runtime: runtime(),
		});
		for (let i = 0; i < 7; i++) await worker.tick("worker-a");
		expect(
			(
				await sql`select status, service_availability from platform.agent_applications`
			)[0],
		).toMatchObject({ status: "available", service_availability: "ready" });
		expect(
			(await sql`select state from platform.workload_reconciliations`)[0]?.state
				.phase,
		).toBe("ready");
		expect(
			(
				await sql`select status, delivery_fence::text from platform.outbox_items where id = 'task-a'`
			)[0],
		).toMatchObject({ status: "succeeded", delivery_fence: "1" });
		expect(
			await sql`select * from platform.audit_events where action = 'agent.workload.creation_succeeded'`,
		).toHaveLength(1);
		expect(
			await sql`select * from platform.persisted_events where stream_id = 'outbox:task-a'`,
		).toHaveLength(1);
	});
	it("does not consume another Worker's live outbox lease and fences an expired lease", async () => {
		await sql`update platform.outbox_items set status = 'processing', attempt_count = 4, delivery_fence = 7, lease_owner = 'worker-b', lease_expires_at = clock_timestamp() + interval '5 minutes' where id = 'task-a'`;
		const worker = createWorkloadReconciliationV1({
			store: first,
			runtime: runtime(),
		});
		await worker.tick("worker-a");
		expect(
			(
				await sql`select status, attempt_count, delivery_fence::text, lease_owner from platform.outbox_items where id = 'task-a'`
			)[0],
		).toMatchObject({
			status: "processing",
			attempt_count: 4,
			delivery_fence: "7",
			lease_owner: "worker-b",
		});
		await sql`update platform.outbox_items set lease_expires_at = clock_timestamp() - interval '1 millisecond' where id = 'task-a'`;
		await worker.tick("worker-a");
		expect(
			(
				await sql`select status, attempt_count, delivery_fence::text, lease_owner, lease_expires_at from platform.outbox_items where id = 'task-a'`
			)[0],
		).toMatchObject({
			status: "succeeded",
			attempt_count: 5,
			delivery_fence: "8",
			lease_owner: null,
			lease_expires_at: null,
		});
	});
	it("does not wake reconciliation from an equally named non-Agent outbox scope", async () => {
		const worker = createWorkloadReconciliationV1({
			store: first,
			runtime: runtime(),
		});
		await worker.tick("worker-a");
		await sql`update platform.workload_reconciliations set next_attempt_at = clock_timestamp() + interval '1 hour' where agent_id = 'agent-a'`;
		await sql`insert into platform.outbox_items(id, scope_type, scope_id, operation, payload, trace_id) values ('task-connection', 'connection', 'agent-a', 'agent.workload.reconcile.v1', ${sql.json({ schemaVersion: 1 })}, 'trace-connection')`;
		const step = vi.fn();
		expect(
			await first.runNext("worker-a", async () => {
				step();
				throw new Error("non-Agent task was claimed");
			}),
		).toBe("idle");
		expect(step).not.toHaveBeenCalled();
		expect(
			(
				await sql`select status from platform.outbox_items where id = 'task-connection'`
			)[0]?.status,
		).toBe("pending");
	});
	it("commits a claimed task after its lease expires inside the Agent transaction", async () => {
		const shortLeaseStore = openPostgresWorkloadReconciliationStoreV1({
			...database,
			retryDelayMs: 0,
			monitorDelayMs: 0,
			workloadLeaseMs: 1,
		});
		try {
			expect(
				await shortLeaseStore.runNext("worker-a", async (input) => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return {
						schemaVersion: 1,
						agentId: input.management.agentId,
						sourceConfigurationRevision: input.configuration.revision,
						sourceLifecycleRevision: input.management.revision,
						revision: input.management.workloadRevision,
						fence: input.management.fence,
						phase: "preflight",
						candidate: { configuration: input.configuration, deployment: null },
						verified: null,
						verifiedRevision: null,
						identity: null,
						rollback: false,
						failureCode: null,
						attempts: 0,
					};
				}),
			).toBe("advanced");
			expect(
				(
					await sql`select status, lease_owner, lease_expires_at from platform.outbox_items where id = 'task-a'`
				)[0],
			).toMatchObject({
				status: "succeeded",
				lease_owner: null,
				lease_expires_at: null,
			});
		} finally {
			await shortLeaseStore.close();
		}
	});
	it("serializes two Workers and prevents configuration writers from passing an in-flight step", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tick = first.runNext("worker-a", async (input) => {
			started.resolve();
			await release.promise;
			return {
				schemaVersion: 1,
				agentId: input.management.agentId,
				sourceConfigurationRevision: 1,
				sourceLifecycleRevision: 1,
				revision: 1,
				fence: input.management.fence,
				phase: "preflight",
				candidate: { configuration: input.configuration, deployment: null },
				verified: null,
				verifiedRevision: null,
				identity: null,
				rollback: false,
				failureCode: null,
				attempts: 0,
			};
		});
		await started.promise;
		let updated = false;
		const writer =
			sql`update platform.agents set authorization_revision = 'authorization-b' where id = 'agent-a'`.then(
				() => {
					updated = true;
				},
			);
		expect(
			await second.runNext("worker-b", async () => {
				throw new Error("Concurrent Worker entered");
			}),
		).toBe("idle");
		expect(updated).toBe(false);
		release.resolve();
		await tick;
		await writer;
		expect(updated).toBe(true);
	});
	it("recovers from a Worker crash without consuming the outbox or storing partial progress", async () => {
		await expect(
			first.runNext("worker-a", async () => {
				throw new Error("crash");
			}),
		).rejects.toThrow("Workload reconciliation persistence failed");
		expect(
			await sql`select * from platform.workload_reconciliations`,
		).toHaveLength(0);
		expect(
			(
				await sql`select status from platform.outbox_items where id = 'task-a'`
			)[0]?.status,
		).toBe("pending");
		const worker = createWorkloadReconciliationV1({
			store: second,
			runtime: runtime(),
		});
		await worker.tick("worker-b");
		expect(
			await sql`select * from platform.workload_reconciliations`,
		).toHaveLength(1);
	});
});
