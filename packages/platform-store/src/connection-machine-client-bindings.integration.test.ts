import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
	connectionMachineRegistrationKeyHashV1,
	PostgresConnectionMachineClientBindingStoreV1,
	type ConnectionMachineClientBindingV1,
} from "./connection-machine-client-bindings.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresConnectionMachineClientBindingStoreV1;

beforeAll(async () => {
	database = await startPostgresTestDatabase("connection-machine-bindings");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 2, onnotice: () => {} });
	store = new PostgresConnectionMachineClientBindingStoreV1({
		databaseUrl: database.databaseUrl,
	});
}, 120_000);

beforeEach(async () => {
	await sql`truncate platform.agents cascade`;
	await sql`
		insert into platform.agents (id)
		values ('agent-a'), ('agent-b')
	`;
	await sql`
		insert into platform.connection_manual_associations (
			agent_id, connection_agent_id, credential_fingerprint,
			association_revision, owner_id, credential_ciphertext, verified_at
		) values
			('agent-a', 'consumer-a', repeat('a', 64), 1, 'owner-a',
			 jsonb_build_object('schemaVersion', 1, 'agentId', 'agent-a', 'ownerId', 'owner-a', 'secretVersion', 1,
				'crypto', jsonb_build_object('dekFingerprint', repeat('b', 64))), now()),
			('agent-b', 'consumer-b', repeat('c', 64), 1, 'owner-b',
			 jsonb_build_object('schemaVersion', 1, 'agentId', 'agent-b', 'ownerId', 'owner-b', 'secretVersion', 1,
				'crypto', jsonb_build_object('dekFingerprint', repeat('d', 64))), now())
	`;
});

afterAll(async () => {
	await store?.close();
	await sql?.end();
	await database?.stop();
});

const binding: ConnectionMachineClientBindingV1 = {
	clientId: "machine-client-a",
	callbackUrl: "https://platform.example.test/internal/runtime/oauth/v1/callback/agent-a",
	profileFingerprint: "e".repeat(64),
	source: { ref: "association:agent-a", revision: "1" },
	registrationKey: "agent-a-install-1",
};

it("persists a non-secret binding and reads it only for the matching association revision", async () => {
	await store.persist("agent-a", binding, 1);
	expect(await store.load("agent-a", 1, binding.registrationKey!)).toEqual({
		clientId: binding.clientId,
		callbackUrl: binding.callbackUrl,
		profileFingerprint: binding.profileFingerprint,
		source: binding.source,
	});
	expect(
		await store.load("agent-a", 1, "agent-a-install-wrong"),
	).toBeUndefined();
	await expect(
		(store.load as unknown as (agentId: string, revision: number) => Promise<unknown>)
			("agent-a", 2),
	).rejects.toThrow("CONNECTION_MACHINE_BINDING_REGISTRATION_KEY_REQUIRED");
	await expect(store.load("agent-a", 2, "")).rejects.toThrow(
		"CONNECTION_MACHINE_BINDING_REGISTRATION_KEY_REQUIRED",
	);
	const rows = await sql`
		select client_id, callback_url, profile_fingerprint, source_ref, source_revision, registration_key_hash
		from platform.connection_machine_client_bindings
	`;
	expect(rows).toEqual([
		{
			client_id: binding.clientId,
			callback_url: binding.callbackUrl,
			profile_fingerprint: binding.profileFingerprint,
			source_ref: binding.source.ref,
			source_revision: binding.source.revision,
			registration_key_hash: connectionMachineRegistrationKeyHashV1(binding.registrationKey!),
		},
	]);
	expect(JSON.stringify(rows)).not.toContain("conn_consumer_");
	expect(JSON.stringify(rows)).not.toContain(binding.registrationKey!);
});

it("replaces a binding only after the association revision advances and rejects cross-Agent client reuse", async () => {
	await store.persist("agent-a", binding, 1);
	await expect(
		store.persist("agent-a", { ...binding, clientId: "client-revision-2" }, 2),
	).rejects.toThrow("CONNECTION_MACHINE_BINDING_REVISION_CONFLICT");
	await sql`
		update platform.connection_manual_associations
		set association_revision = 2,
			credential_ciphertext = jsonb_set(credential_ciphertext, '{secretVersion}', '2'::jsonb),
			updated_at = now()
		where agent_id = 'agent-a'
	`;
	const replacement = {
		...binding,
		clientId: "machine-client-a-replacement",
		source: { ref: "association:agent-a", revision: "2" },
		registrationKey: "agent-a-install-2",
	};
	await store.persist("agent-a", replacement, 2);
	expect(await store.load("agent-a", 1, replacement.registrationKey!)).toBeUndefined();
	expect(await store.load("agent-a", 2, replacement.registrationKey)).toEqual({
		clientId: replacement.clientId,
		callbackUrl: replacement.callbackUrl,
		profileFingerprint: replacement.profileFingerprint,
		source: replacement.source,
	});
	// A different Owner/Agent cannot read Agent A's binding by using Agent B's key.
	expect(
		await store.load("agent-b", 1, replacement.registrationKey),
	).toBeUndefined();
	await expect(
		store.persist(
			"agent-b",
			{ ...binding, clientId: replacement.clientId },
			1,
		),
	).rejects.toMatchObject({ code: "23505" });
});

it("does not revive a binding after the association row is removed", async () => {
	await store.persist("agent-a", binding, 1);
	await sql`delete from platform.connection_manual_associations where agent_id = 'agent-a'`;
	expect(await store.load("agent-a", 1, binding.registrationKey!)).toBeUndefined();
	await expect(store.persist("agent-a", binding, 1)).rejects.toThrow(
		"CONNECTION_MACHINE_BINDING_REVISION_CONFLICT",
	);
});
