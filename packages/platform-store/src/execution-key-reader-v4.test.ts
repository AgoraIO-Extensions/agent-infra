import { RuntimeSubmitTurnRequestV4Schema } from "@agent-infra/contracts/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresExecutionKeyReaderV4 } from "./execution-key-reader-v4.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let reader: PostgresExecutionKeyReaderV4;

function ciphertext(version: number, keyId: string) {
	return {
		schemaVersion: 1,
		purpose: "personal",
		subjectId: "alice",
		keyId,
		keyVersion: version,
		crypto: {
			schemaVersion: 1,
			algorithmVersion: "aes-256-gcm:v1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			wrappingKeyVersion: "wrapping-key-1",
			aadVersion: "relay-key-aad:v1",
			dekFingerprint: "a".repeat(64),
			nonce: Buffer.alloc(12).toString("base64"),
			ciphertext: Buffer.alloc(16).toString("base64"),
			authenticationTag: Buffer.alloc(16).toString("base64"),
			wrappedDek: Buffer.alloc(384).toString("base64"),
		},
	};
}

const request = RuntimeSubmitTurnRequestV4Schema.parse({
	schemaVersion: 4,
	requestId: "request-1",
	traceId: "trace-1",
	principal: { kind: "user", id: "alice" },
	executionSource: "web",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	hostSessionRef: null,
	operation: {
		kind: "execution",
		id: "execution-1",
		deliveryFence: 1,
		executionDeliveryFence: 1,
	},
	grant: { schemaVersion: 4, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
	input: { text: "hello", attachments: [] },
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-1",
		reasoningLevel: "high",
	},
});

beforeAll(async () => {
	database = await startPostgresTestDatabase("execution-key-v4");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl);
	reader = new PostgresExecutionKeyReaderV4({
		databaseUrl: database.databaseUrl,
	});
	await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision)
		values ('agent-1', 1, 'revision-1')`;
	await sql`insert into platform.relay_key_subjects
		(purpose, subject_id, last_version, current_version)
		values ('personal', 'alice', 2, 2)`;
	for (const version of [1, 2]) {
		await sql`insert into platform.relay_key_versions
			(purpose, subject_id, key_version, key_id, ciphertext)
			values ('personal', 'alice', ${version}, ${`key-${version}`},
				${sql.json(ciphertext(version, `key-${version}`))})`;
	}
	await sql`insert into platform.conversations
		(id, agent_id, actor_id, channel_id, status, session_generation,
		 authorization_revision)
		values ('conversation-1', 'agent-1', 'alice', 'web', 'ready', 1, 'revision-1')`;
	await sql`insert into platform.conversation_executions
		(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
		 status, session_generation, authorization_revision, created_at,
		 execution_source, relay_key_purpose, relay_key_subject_id,
		 relay_key_id, relay_key_version)
		values ('execution-1', 'conversation-1', 'agent-1', 'alice', 'web',
		 'turn-1', 'submitted', 1, 'revision-1', now(), 'web', 'personal',
		 'alice', 'key-1', 1)`;
	await sql`insert into platform.task_authorization_records
		(id, execution_id, boundary)
		values ('authorization-1', 'execution-1', ${sql.json({
			schemaVersion: 1,
			principal: { kind: "user", id: "alice" },
			agentId: "agent-1",
			channelId: "web",
			identityRevision: "identity-1",
			agentAuthorizationRevision: "revision-1",
			accessSources: [{ kind: "owner", userId: "alice" }],
		})})`;
}, 120_000);

afterAll(async () => {
	await reader?.close();
	await sql?.end();
	await database?.stop();
});

it("reads the original K1 after the current subject Key advances to K2", async () => {
	const accepted = await reader.readAcceptedExecution(request);
	expect(accepted?.scope.keyBinding).toEqual(request.keyBinding);
	const record = await reader.readCiphertext({
		purpose: "personal",
		subjectId: "alice",
		keyId: "key-1",
		keyVersion: 1,
	});
	expect(record?.keyVersion).toBe(1);
	expect(record?.keyId).toBe("key-1");
	expect(
		await reader.readCiphertext({
			purpose: "personal",
			subjectId: "alice",
			keyId: "key-2",
			keyVersion: 1,
		}),
	).toBeNull();
});

it("does not derive an accepted scope from a forged request", async () => {
	const accepted = await reader.readAcceptedExecution({
		...request,
		principal: { kind: "user", id: "bob" },
		keyBinding: { ...request.keyBinding, version: 2 },
	});
	expect(accepted?.scope.principal).toEqual(request.principal);
	expect(accepted?.scope.keyBinding).toEqual(request.keyBinding);
});

it("uses the immutable submit Session for submit recovery", async () => {
	await sql`
		update platform.conversation_executions
		set runtime_submit_protocol = 'v4',
			original_operation_digest = repeat('a', 43),
			original_submit_host_session_ref = 'original-host'
		where execution_id = 'execution-1'
	`;
	await sql`
		update platform.conversations
		set host_session_ref = 'current-host'
		where id = 'conversation-1'
	`;
	try {
		const accepted = await reader.readAcceptedExecution({
			...request,
			hostSessionRef: "original-host",
		});
		expect(accepted?.scope.hostSessionRef).toBe("original-host");
		expect(accepted?.trustedHostSessionRef).toBe("original-host");
	} finally {
		await sql`
			update platform.conversation_executions
			set runtime_submit_protocol = null,
				original_operation_digest = null,
				original_submit_host_session_ref = null
			where execution_id = 'execution-1'
		`;
		await sql`
			update platform.conversations
			set host_session_ref = null
			where id = 'conversation-1'
		`;
	}
});

it("preserves an explicitly null V4 submit Session", async () => {
	await sql`
		update platform.conversation_executions
		set runtime_submit_protocol = 'v4',
			original_operation_digest = repeat('a', 43),
			original_submit_host_session_ref = null
		where execution_id = 'execution-1'
	`;
	await sql`
		update platform.conversations
		set host_session_ref = 'current-host'
		where id = 'conversation-1'
	`;
	try {
		const accepted = await reader.readAcceptedExecution(request);
		expect(accepted?.scope.hostSessionRef).toBeNull();
		expect(accepted?.trustedHostSessionRef).toBeNull();
	} finally {
		await sql`
			update platform.conversation_executions
			set runtime_submit_protocol = null,
			original_operation_digest = null,
			original_submit_host_session_ref = null
			where execution_id = 'execution-1'
		`;
		await sql`
			update platform.conversations
			set host_session_ref = null
			where id = 'conversation-1'
		`;
	}
});

it("withholds a terminal Execution's Key binding", async () => {
	for (const status of ["completed", "failed", "cancelled"] as const) {
		await sql`
			update platform.conversation_executions
			set status = ${status}
			where execution_id = 'execution-1'
		`;
		try {
			expect(await reader.readAcceptedExecution(request)).toBeNull();
		} finally {
			await sql`
				update platform.conversation_executions
				set status = 'submitted'
				where execution_id = 'execution-1'
			`;
		}
	}
});

it("withholds a revoked Execution's Key binding", async () => {
	await sql`update platform.task_authorization_records
		set revoked_at = now() where id = 'authorization-1'`;
	expect(await reader.readAcceptedExecution(request)).toBeNull();
});
