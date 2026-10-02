import {
	type ConversationExecutionAuthorityV1,
	createConversationExecutionUseCaseV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { agentConfigurationConformanceRecordV1 as configuration } from "@agent-infra/platform-core/testing";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import * as keyAuthority from "./conversation-execution-key.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

// Authored real-PG integration cases. Not executed in this design delivery.
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let adapter: PostgresConversationExecutionTransactionV1;
let actor = "alice";
let channel = "web";
const userDirectory: TaskUserDirectoryV1 = {
	async resolveUser(id) {
		return {
			schemaVersion: 1,
			userId: id,
			accountStatus: "active",
			organizationIds: ["org-1"],
			authorizationRevision: "identity-1",
		};
	},
};
function authority(): ConversationExecutionAuthorityV1 {
	return {
		schemaVersion: 1,
		actorId: actor,
		agentId: configuration.agentId,
		channelId: channel,
		authorizationRevision: "access-1",
		supportsSupplementaryInstruction: true,
		taskBoundary: {
			schemaVersion: 1,
			principal: { kind: "user", id: actor },
			agentId: configuration.agentId,
			channelId: channel,
			identityRevision: "identity-1",
			agentAuthorizationRevision: "access-1",
			accessSources: [{ kind: "organization", organizationId: "org-1" }],
		},
	};
}
function ciphertext(version: number) {
	return {
		schemaVersion: 1,
		purpose: "personal",
		subjectId: "alice",
		keyId: `key-${version}`,
		keyVersion: version,
		crypto: {
			schemaVersion: 1,
			algorithmVersion: "aes-256-gcm:v1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			wrappingKeyVersion: "wrapping-1",
			aadVersion: "relay-key-aad:v1",
			dekFingerprint: "a".repeat(64),
			nonce: Buffer.alloc(12).toString("base64"),
			ciphertext: Buffer.alloc(16).toString("base64"),
			authenticationTag: Buffer.alloc(16).toString("base64"),
			wrappedDek: Buffer.alloc(384).toString("base64"),
		},
	};
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("accepted-execution-key");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl);
	adapter = new PostgresConversationExecutionTransactionV1({
		databaseUrl: database.databaseUrl,
		userDirectory,
	});
	await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision)
		values (${configuration.agentId}, ${configuration.revision}, 'access-1')`;
	await sql`insert into platform.agent_configuration_revisions
		(agent_id, revision, source_reference, configuration)
		values (${configuration.agentId}, ${configuration.revision}, 'configuration-fixture', ${sql.json(configuration)})`;
	await sql`insert into platform.relay_key_subjects (purpose, subject_id, last_version, current_version)
		values ('personal', 'alice', 2, 1)`;
	for (const version of [1, 2]) {
		await sql`insert into platform.relay_key_versions (purpose, subject_id, key_version, key_id, ciphertext)
			values ('personal', 'alice', ${version}, ${`key-${version}`}, ${sql.json(ciphertext(version))})`;
	}
}, 120_000);

afterEach(async () => {
	vi.restoreAllMocks();
	actor = "alice";
	channel = "web";
	await sql`truncate platform.task_control_records, platform.task_authorization_records,
		platform.conversation_generation_tombstones, platform.file_accesses, platform.files,
		platform.conversation_events, platform.conversation_audit_events, platform.audit_events,
		platform.outbox_items, platform.idempotency_records, platform.conversation_stops,
		platform.conversation_messages, platform.conversation_executions, platform.conversations`;
	await sql`update platform.relay_key_subjects set current_version = 1 where purpose = 'personal' and subject_id = 'alice'`;
});
afterAll(async () => {
	await adapter?.close();
	await sql?.end();
	await database?.stop();
});

async function conversation() {
	let sequence = 0;
	const useCase = createConversationExecutionUseCaseV1(
		{
			authorization: {
				async authorize() {
					return { outcome: "allowed", authority: authority() };
				},
			},
			transaction: adapter,
		},
		{ newId: () => `accepted-key-${++sequence}` },
	);
	const created = await useCase.createConversation({
		schemaVersion: 1,
		agentId: configuration.agentId,
		idempotencyKey: "create",
		requestId: "create-request",
		traceId: "create-trace",
	});
	if (created.outcome !== "accepted")
		throw new Error("Fixture Conversation not created");
	const command = {
		schemaVersion: 1 as const,
		command: "message" as const,
		conversationId: created.result.conversationId,
		text: "fixture-message",
		idempotencyKey: "message-1",
		requestId: "request-1",
		traceId: "trace-1",
	};
	return { useCase, command, conversationId: created.result.conversationId };
}

async function acceptedRow(executionId: string) {
	const [row] =
		await sql`select execution_id, conversation_id, turn_id, session_generation::text,
		execution_source, relay_key_purpose, relay_key_subject_id, relay_key_id, relay_key_version::text
		from platform.conversation_executions where execution_id = ${executionId}`;
	return row;
}

it("freezes the original version with authorization and outbox on initial accept", async () => {
	const fixture = await conversation();
	const accepted = await fixture.useCase.accept(fixture.command);
	if (accepted.outcome !== "accepted")
		throw new Error("Fixture Execution not accepted");
	expect(await acceptedRow(accepted.result.executionId)).toMatchObject({
		execution_source: "web",
		relay_key_purpose: "personal",
		relay_key_subject_id: "alice",
		relay_key_id: "key-1",
		relay_key_version: "1",
	});
	const records = await sql`select a.execution_id, o.payload
		from platform.task_authorization_records a join platform.outbox_items o
		on o.payload->>'executionId' = a.execution_id where a.execution_id = ${accepted.result.executionId}`;
	expect(records).toHaveLength(1);
	expect(Object.keys(records[0]?.payload ?? {})).not.toContain(
		"relayKeyBinding",
	);
	expect(Object.keys(records[0]?.payload ?? {})).not.toContain(
		"personalApiAdmissionAuthority",
	);
});

it("replay and supplement keep K1 after the alias changes to K2 without selecting again", async () => {
	const fixture = await conversation();
	const accepted = await fixture.useCase.accept(fixture.command);
	if (accepted.outcome !== "accepted")
		throw new Error("Fixture Execution not accepted");
	const before = await acceptedRow(accepted.result.executionId);
	await sql`update platform.relay_key_subjects set current_version = 2 where purpose = 'personal' and subject_id = 'alice'`;
	const select = vi.spyOn(
		keyAuthority,
		"currentConversationExecutionRelayKeyBindingV1",
	);
	expect(await fixture.useCase.accept(fixture.command)).toEqual({
		outcome: "replayed",
		result: accepted.result,
	});
	const supplement = await fixture.useCase.accept({
		...fixture.command,
		text: "supplement",
		idempotencyKey: "message-2",
	});
	if (supplement.outcome !== "accepted")
		throw new Error("Fixture supplement not accepted");
	expect(supplement.result.executionId).toBe(accepted.result.executionId);
	expect(await acceptedRow(accepted.result.executionId)).toEqual(before);
	expect(select).not.toHaveBeenCalled();
});

it("regeneration selects K2 for the new Execution while keeping original IDs and Session", async () => {
	const fixture = await conversation();
	const accepted = await fixture.useCase.accept(fixture.command);
	if (accepted.outcome !== "accepted" || !accepted.result.messageId)
		throw new Error("Fixture Execution not accepted");
	const before = await acceptedRow(accepted.result.executionId);
	await sql`update platform.conversation_executions set status = 'completed' where execution_id = ${accepted.result.executionId}`;
	await sql`update platform.conversations set status = 'ready', host_session_ref = 'same-session' where id = ${fixture.conversationId}`;
	await sql`update platform.relay_key_subjects set current_version = 2 where purpose = 'personal' and subject_id = 'alice'`;
	const regenerated = await fixture.useCase.regenerate({
		schemaVersion: 1,
		command: "regenerate",
		conversationId: fixture.conversationId,
		sourceMessageId: accepted.result.messageId,
		idempotencyKey: "regenerate",
		requestId: "regenerate-request",
		traceId: "regenerate-trace",
	});
	if (regenerated.outcome !== "accepted")
		throw new Error("Fixture regeneration not accepted");
	expect(regenerated.result.executionId).not.toBe(accepted.result.executionId);
	expect(await acceptedRow(accepted.result.executionId)).toEqual(before);
	expect(await acceptedRow(regenerated.result.executionId)).toMatchObject({
		relay_key_id: "key-2",
		relay_key_version: "2",
		conversation_id: fixture.conversationId,
		session_generation: "1",
	});
	expect(
		(
			await sql`select host_session_ref, last_conversation_cursor::text from platform.conversations where id = ${fixture.conversationId}`
		)[0],
	).toEqual({
		host_session_ref: "same-session",
		last_conversation_cursor: "0",
	});
});

it("refuses another actor's original Conversation before selecting or writing a Key", async () => {
	const fixture = await conversation();
	actor = "bob";
	const select = vi.spyOn(
		keyAuthority,
		"currentConversationExecutionRelayKeyBindingV1",
	);
	expect(await fixture.useCase.accept(fixture.command)).toEqual({
		outcome: "denied",
	});
	expect(select).not.toHaveBeenCalled();
	expect(
		await sql`select execution_id from platform.conversation_executions`,
	).toHaveLength(0);
});

it("missing current Key refuses before reserving or changing the original Conversation", async () => {
	const fixture = await conversation();
	const before =
		await sql`select * from platform.conversations where id = ${fixture.conversationId}`;
	await sql`update platform.relay_key_subjects set current_version = null where purpose = 'personal' and subject_id = 'alice'`;
	expect(await fixture.useCase.accept(fixture.command)).toEqual({
		outcome: "denied",
	});
	expect(
		await sql`select * from platform.conversations where id = ${fixture.conversationId}`,
	).toEqual(before);
	expect(
		await sql`select execution_id from platform.conversation_executions`,
	).toHaveLength(0);
	expect(await sql`select id from platform.outbox_items`).toHaveLength(0);
});

it.each([
	"conversation_executions",
	"task_authorization_records",
	"outbox_items",
	"conversation_audit_events",
])(
	"rolls back Key binding and original Conversation when %s persistence fails",
	async (table) => {
		const fixture = await conversation();
		const before =
			await sql`select * from platform.conversations where id = ${fixture.conversationId}`;
		await sql`create function platform.fail_accepted_key_fixture() returns trigger language plpgsql as $$ begin raise exception 'private-fixture-sentinel'; end; $$`;
		await sql`create trigger fail_accepted_key before insert on platform.${sql(table)} for each row execute function platform.fail_accepted_key_fixture()`;
		try {
			await expect(
				fixture.useCase.accept(fixture.command),
			).rejects.toMatchObject({
				code: "unavailable",
				message: "Conversation persistence is unavailable",
			});
			expect(
				await sql`select * from platform.conversations where id = ${fixture.conversationId}`,
			).toEqual(before);
			expect(
				await sql`select execution_id from platform.conversation_executions`,
			).toHaveLength(0);
			expect(await sql`select id from platform.outbox_items`).toHaveLength(0);
			expect(
				await sql`select id from platform.task_authorization_records`,
			).toHaveLength(0);
		} finally {
			await sql`drop trigger fail_accepted_key on platform.${sql(table)}`;
			await sql`drop function platform.fail_accepted_key_fixture()`;
		}
	},
);

it.each(["api", "wecom:fixture", "eval"])(
	"keeps original non-Web %s accept/replay/regenerate without selecting a Web Key",
	async (originalChannel) => {
		channel = originalChannel;
		const fixture = await conversation();
		const select = vi.spyOn(
			keyAuthority,
			"currentConversationExecutionRelayKeyBindingV1",
		);
		const accepted = await fixture.useCase.accept(fixture.command);
		if (accepted.outcome !== "accepted" || !accepted.result.messageId)
			throw new Error("Fixture original non-Web Execution not accepted");
		const original = await acceptedRow(accepted.result.executionId);
		expect(original).toMatchObject({
			execution_source: null,
			relay_key_purpose: null,
			relay_key_subject_id: null,
			relay_key_id: null,
			relay_key_version: null,
		});
		expect(await fixture.useCase.accept(fixture.command)).toEqual({
			outcome: "replayed",
			result: accepted.result,
		});
		await sql`update platform.conversation_executions set status = 'completed' where execution_id = ${accepted.result.executionId}`;
		await sql`update platform.conversations set status = 'ready' where id = ${fixture.conversationId}`;
		const regenerated = await fixture.useCase.regenerate({
			schemaVersion: 1,
			command: "regenerate",
			conversationId: fixture.conversationId,
			sourceMessageId: accepted.result.messageId,
			idempotencyKey: "non-web-regenerate",
			requestId: "non-web-regenerate",
			traceId: "non-web-regenerate",
		});
		if (regenerated.outcome !== "accepted")
			throw new Error("Fixture original non-Web regeneration not accepted");
		expect(await acceptedRow(accepted.result.executionId)).toEqual(original);
		expect(await acceptedRow(regenerated.result.executionId)).toMatchObject({
			execution_source: null,
			relay_key_purpose: null,
			relay_key_subject_id: null,
			relay_key_id: null,
			relay_key_version: null,
		});
		expect(select).not.toHaveBeenCalled();
	},
);
