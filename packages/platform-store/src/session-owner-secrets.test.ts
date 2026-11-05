import {
	type PlatformSecretRecordV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import {
	PostgresSessionOwnerSecretStoreV1,
	type SessionOwnerSecretReferenceV1,
} from "./session-owner-secrets.ts";

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
let store: PostgresSessionOwnerSecretStoreV1;

function activeRecord(input: {
	readonly agentId?: string;
	readonly secretId: string;
	readonly ownerId?: string;
	readonly name: string;
	readonly secretVersion?: number;
	readonly configRevision?: number;
	readonly wrappingKeyVersion?: string;
	readonly fingerprint: string;
	readonly lifecycleState?: "active" | "pending";
}): PlatformSecretRecordV1 {
	const agentId = input.agentId ?? "agent_01";
	const ownerId = input.ownerId ?? "owner_01";
	const secretVersion = input.secretVersion ?? 2;
	const configRevision = input.configRevision ?? 7;
	const wrappingKeyVersion = input.wrappingKeyVersion ?? "key_01";
	const identity = {
		schemaVersion: 1 as const,
		secretId: input.secretId,
		ownerType: "agent-owner" as const,
		ownerId,
		agentId,
		name: input.name,
		secretVersion,
		configRevision,
	};
	const kubernetesSecretName = `agent-aaaaaaaaaaaaaaaa.secret-${input.fingerprint.repeat(16)}-v${secretVersion}-r${configRevision}`;
	return validatePlatformSecretRecordV1({
		...identity,
		lifecycleState: input.lifecycleState ?? "active",
		crypto: {
			schemaVersion: 1,
			algorithmVersion: "aes-256-gcm:v1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			wrappingKeyVersion,
			aadBinding: {
				...identity,
				aadVersion: "platform-secret-aad:v1",
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion,
			},
			dekFingerprint: input.fingerprint.repeat(64),
			nonce: "AAAAAAAAAAAAAAAA",
			ciphertext: "YWJjZA==",
			authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA==",
			wrappedDek: "A".repeat(512),
		},
		...(input.lifecycleState === "pending"
			? {}
			: {
					kubernetesSecretRef: {
						schemaVersion: 1,
						ownerType: "agent-owner",
						ownerId,
						agentId,
						secretId: input.secretId,
						secretVersion,
						configRevision,
						algorithmVersion: "aes-256-gcm:v1",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						wrappingKeyVersion,
						name: kubernetesSecretName,
					},
					activationFence: {
						schemaVersion: 1,
						agentId,
						secretId: input.secretId,
						secretVersion,
						configRevision,
						kubernetesSecretName,
						workloadUid: "workload_uid_01",
						workloadGeneration: 3,
						fence: 4,
					},
				}),
		createdAt: "2026-09-05T08:00:00.000Z",
		updatedAt: "2026-09-05T08:00:00.000Z",
	});
}

const current = activeRecord({
	secretId: "credential_01",
	name: "BOT_TOKEN",
	fingerprint: "a",
});
// Active-origin record from an earlier configuration revision.
const origin = activeRecord({
	secretId: "credential_02",
	name: "MODEL_API_KEY",
	secretVersion: 1,
	configRevision: 6,
	fingerprint: "b",
});
const pending = activeRecord({
	secretId: "credential_03",
	name: "PENDING_KEY",
	fingerprint: "c",
	lifecycleState: "pending",
});
const formerOwner = activeRecord({
	secretId: "credential_04",
	name: "FORMER_OWNER_KEY",
	ownerId: "owner_removed",
	fingerprint: "d",
});
const retired = activeRecord({
	secretId: "credential_05",
	name: "RETIRED_KEY",
	wrappingKeyVersion: "key_retired",
	fingerprint: "e",
});
const foreign = activeRecord({
	agentId: "agent_02",
	secretId: "credential_01",
	ownerId: "owner_02",
	name: "BOT_TOKEN",
	fingerprint: "f",
});

function reference(
	record: PlatformSecretRecordV1,
): SessionOwnerSecretReferenceV1 {
	return {
		ownerType: record.ownerType,
		ownerId: record.ownerId,
		agentId: record.agentId,
		secretId: record.secretId,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		algorithmVersion: record.crypto.algorithmVersion,
		wrappingAlgorithmVersion: record.crypto.wrappingAlgorithmVersion,
		wrappingKeyVersion: record.crypto.wrappingKeyVersion,
	};
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("session-owner-secrets");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
	// The Store needs only these reads and the value-free audit insert.
	await client`create role session_owner_secret_runtime login password 'controlled_session_owner_secret_test'`;
	await client`grant usage on schema platform to session_owner_secret_runtime`;
	await client`grant select on platform.secret_records, platform.agent_owners, platform.retired_secret_wrapping_keys to session_owner_secret_runtime`;
	await client`grant insert on platform.audit_events to session_owner_secret_runtime`;
	const runtimeUrl = new URL(database.databaseUrl);
	runtimeUrl.username = "session_owner_secret_runtime";
	runtimeUrl.password = "controlled_session_owner_secret_test";
	store = new PostgresSessionOwnerSecretStoreV1({
		databaseUrl: runtimeUrl.toString(),
	});
	for (const agentId of ["agent_01", "agent_02"]) {
		await client`insert into platform.agents (id, current_configuration_revision) values (${agentId}, 7)`;
		await client`
			insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, created_at)
			values
				(${agentId}, 6, 'configuration_06', now()),
				(${agentId}, 7, 'configuration_07', now())`;
	}
	await client`
		insert into platform.agent_owners (agent_id, owner_id, created_at)
		values ('agent_01', 'owner_01', now()), ('agent_02', 'owner_02', now())`;
	await client`insert into platform.retired_secret_wrapping_keys (key_version) values ('key_retired')`;
	for (const record of [
		current,
		origin,
		pending,
		formerOwner,
		retired,
		foreign,
	]) {
		await client`
			insert into platform.secret_records
				(agent_id, secret_id, secret_version, configuration_revision,
				 owner_type, owner_id, name, lifecycle_state, dek_fingerprint,
				 wrapping_key_version, record, created_at, updated_at)
			values
				(${record.agentId}, ${record.secretId}, ${record.secretVersion},
				 ${record.configRevision}, ${record.ownerType}, ${record.ownerId},
				 ${record.name}, ${record.lifecycleState},
				 ${record.crypto.dekFingerprint}, ${record.crypto.wrappingKeyVersion},
				 ${client.json(record)},
				 ${new Date(record.createdAt)}, ${new Date(record.updatedAt)})`;
	}
}, 120_000);

afterAll(async () => {
	await store?.close();
	await client?.end();
	await database?.stop();
});

describe("PostgreSQL Session Owner Secret Store (#3938)", () => {
	it("returns the exact active records of the verified references in order", async () => {
		await expect(
			store.resolve({
				agentId: "agent_01",
				references: [reference(origin), reference(current)],
			}),
		).resolves.toEqual([origin, current]);
	});

	it.each([
		[
			"a missing record",
			{ ...reference(current), secretId: "credential_missing" },
		],
		["another version", { ...reference(current), secretVersion: 3 }],
		[
			"another configuration revision",
			{ ...reference(current), configRevision: 6 },
		],
		["another Owner", { ...reference(current), ownerId: "owner_02" }],
		["another Agent", reference(foreign)],
		[
			"another wrapping key",
			{ ...reference(current), wrappingKeyVersion: "key_02" },
		],
		["a pending record", reference(pending)],
		["a record whose Owner was removed", reference(formerOwner)],
		["a retired wrapping key", reference(retired)],
	])("rejects %s without returning any record", async (_name, rejected) => {
		await expect(
			store.resolve({
				agentId: "agent_01",
				references: [reference(current), rejected],
			}),
		).rejects.toThrow("Session Owner Secret is unavailable");
	});

	it("rejects empty and duplicated reference sets", async () => {
		await expect(
			store.resolve({ agentId: "agent_01", references: [] }),
		).rejects.toThrow("Session Owner Secret is unavailable");
		await expect(
			store.resolve({
				agentId: "agent_01",
				references: [reference(current), reference(current)],
			}),
		).rejects.toThrow("Session Owner Secret is unavailable");
	});

	it("writes the value-free secret.decrypt audit used by the Workload path", async () => {
		await store.auditDecryption({
			agentId: "agent_01",
			secretId: current.secretId,
			wrappingKeyVersion: current.crypto.wrappingKeyVersion,
			outcome: "succeeded",
			traceId: "trace_session_01",
			requestId: "request_session_01",
			workerId: "worker_01",
		});
		await store.auditDecryption({
			agentId: "agent_01",
			secretId: origin.secretId,
			wrappingKeyVersion: origin.crypto.wrappingKeyVersion,
			outcome: "rejected",
			traceId: "trace_session_01",
			requestId: "request_session_01",
			workerId: "worker_01",
		});
		const rows = await client<
			{
				trace_id: string;
				actor_type: string;
				actor_id: string;
				action: string;
				target_type: string;
				target_id: string;
				outcome: string;
				request_id: string;
				agent_id: string;
				details: unknown;
			}[]
		>`
			select trace_id, actor_type, actor_id, action, target_type, target_id,
				outcome, request_id, agent_id, details
			from platform.audit_events where trace_id = 'trace_session_01'
			order by target_id`;
		expect(rows).toEqual([
			{
				trace_id: "trace_session_01",
				actor_type: "system",
				actor_id: "worker_01",
				action: "secret.decrypt",
				target_type: "secret",
				target_id: current.secretId,
				outcome: "succeeded",
				request_id: "request_session_01",
				agent_id: "agent_01",
				details: {
					wrappingKeyVersion: "key_01",
					operation: "decrypt",
					result: "succeeded",
				},
			},
			{
				trace_id: "trace_session_01",
				actor_type: "system",
				actor_id: "worker_01",
				action: "secret.decrypt",
				target_type: "secret",
				target_id: origin.secretId,
				outcome: "rejected",
				request_id: "request_session_01",
				agent_id: "agent_01",
				details: {
					wrappingKeyVersion: "key_01",
					operation: "decrypt",
					result: "rejected",
				},
			},
		]);
	});

	it("rejects an invalid audit request without writing an event", async () => {
		await expect(
			store.auditDecryption({
				agentId: "agent_01",
				secretId: current.secretId,
				wrappingKeyVersion: current.crypto.wrappingKeyVersion,
				outcome: "succeeded",
				traceId: "",
				requestId: "request_session_02",
				workerId: "worker_01",
			}),
		).rejects.toThrow("Session Owner Secret is unavailable");
		const [count] = await client<{ count: string }[]>`
			select count(*)::text as count from platform.audit_events
			where request_id = 'request_session_02'`;
		expect(count?.count).toBe("0");
	});
});
