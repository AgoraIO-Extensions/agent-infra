import { createHash, generateKeyPairSync } from "node:crypto";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import {
	createWorkloadReconciliationV1,
	type WorkloadRuntimePortV1,
} from "@agent-infra/platform-core";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import {
	createSecretKeyringDecryptorV1,
	createSecretRevisionBindingCryptoV1,
} from "@agent-infra/secret-store/worker";
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
	workloadRegistryFixture,
	workloadTestPolicy,
} from "../../../apps/platform-worker/src/kubernetes.fixture.js";
import { createWorkloadRuntimeV1 } from "../../../apps/platform-worker/src/workload-runtime.js";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
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
		encryptionKeys,
		keys,
		encryptor: createSecretEncryptorV1({ encryptionKeys }),
		decryptor: createSecretKeyringDecryptorV1({ keys }),
		revisionBinder: createSecretRevisionBindingCryptoV1({
			keys,
			encryptionKeys,
		}),
	};
}

describe("PostgreSQL Workload steps", () => {
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
		async function advance(revisionBinder = crypto.revisionBinder) {
			for (let i = 0; i < 12; i++) {
				const runtime = createWorkloadRuntimeV1({
					workerId: `worker-${i}`,
					client: api.client,
					policy: workloadTestPolicy,
					registry: workloadRegistryFixture(),
					admissionPolicyRef: "policy-a",
					registrySubjectRef: "subject-a",
					revisionBinder,
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
		await expect(
			first.runNext("worker-binding-crash", async (input) => {
				if (!input.secrets) throw new Error();
				const source = validatePlatformSecretRecordV1(input.secrets.records[0]);
				const binding = await crypto.revisionBinder.bind({
					encryptedRecord: source,
					expectedBinding: {
						agentId: source.agentId,
						secretId: source.secretId,
						secretVersion: source.secretVersion,
						configRevision: source.configRevision,
						ownerType: source.ownerType,
						ownerId: source.ownerId,
						name: source.name,
						wrappingKeyVersion: source.crypto.wrappingKeyVersion,
						dekFingerprint: source.crypto.dekFingerprint,
					},
					targetConfigRevision: input.configuration.revision,
					traceId: input.traceId,
				});
				if (binding.outcome !== "bound") throw new Error();
				await input.secrets.persistCurrentRevisionRecord(
					binding.encryptedRecord,
				);
				throw new Error("simulated transaction failure");
			}),
		).rejects.toThrow("Workload reconciliation persistence failed");
		expect(
			await sql`select * from platform.secret_records where configuration_revision = 2`,
		).toHaveLength(0);
		expect(
			(
				await sql`select record from platform.secret_records where configuration_revision = 1`
			)[0]?.record.lifecycleState,
		).toBe("active");
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
		expect(revisionTwo).toHaveLength(2);
		expect(revisionTwo).toMatchObject([
			{
				configuration_revision: "1",
				lifecycle_state: "active",
				record: { crypto: { aadBinding: { configRevision: 1 } } },
			},
			{
				configuration_revision: "2",
				lifecycle_state: "active",
				record: { crypto: { aadBinding: { configRevision: 2 } } },
			},
		]);
		expect(
			await sql`select * from platform.audit_events where action = 'secret.activate'`,
		).toHaveLength(activationCount + 1);

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
					revisionBinder: crypto.revisionBinder,
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
					revisionBinder: crypto.revisionBinder,
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
		expect(revisionThree).toHaveLength(3);
		expect(revisionThree[2]).toMatchObject({
			configuration_revision: "3",
			lifecycle_state: "active",
			record: { crypto: { aadBinding: { configRevision: 3 } } },
		});

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
			{ configuration_revision: "2", lifecycle_state: "active" },
			{ configuration_revision: "3", lifecycle_state: "active" },
			{ configuration_revision: "5", lifecycle_state: "active" },
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
		const failedBinder = createSecretRevisionBindingCryptoV1({
			keys: crypto.keys,
			encryptionKeys: crypto.encryptionKeys,
			now: () => new Date(Number.NaN),
		});
		await advance(failedBinder);
		await advance(failedBinder);
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
				await sql`select record from platform.secret_records where configuration_revision = 5`
			)[0]?.record.lifecycleState,
		).toBe("active");
	});
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
					if (reject) throw new Error("private registry response");
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
