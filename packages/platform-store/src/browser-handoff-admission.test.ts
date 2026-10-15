import { createHash } from "node:crypto";
import {
	type BrowserHandoffAdmissionPlanV1,
	type BrowserHandoffAdmissionRequestV1,
	type BrowserHandoffAdmissionStateV1,
	type BrowserHandoffCommandV1,
	browserHandoffAdmissionRequestDigestV1,
	type ConversationExecutionAuthorityV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresBrowserHandoffAdmissionTransactionV1 } from "./browser-handoff-admission.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

const conversationId = "conversation-browser-handoff-store";
const agentId = "agent-browser-handoff-store";
const actorId = "actor-browser-handoff-store";
const executionId = "execution-browser-handoff-store";
const turnId = "turn-browser-handoff-store";
const authorizationRevision = "authorization-browser-handoff-store";

let databaseUrl = "";
let client: ReturnType<typeof postgres>;
let testDatabase: PostgresTestDatabase | undefined;
let transaction: PostgresBrowserHandoffAdmissionTransactionV1;

const authority: ConversationExecutionAuthorityV1 = {
	schemaVersion: 1,
	actorId,
	agentId,
	channelId: "web",
	authorizationRevision,
	supportsSupplementaryInstruction: false,
};

function command(
	handoffId = "handoff-browser-handoff-store",
): BrowserHandoffCommandV1 {
	return { schemaVersion: 1, command: "take_over", handoffId };
}

function pause(
	handoffId = "handoff-browser-handoff-store",
): BrowserHandoffCommandV1 {
	return {
		schemaVersion: 1,
		command: "pause",
		handoffId,
	};
}

function sideEffect(
	commandValue:
		| "confirm_side_effect"
		| "reject_side_effect"
		| "cancel_side_effect",
	confirmationId = "confirmation-browser-handoff-store",
): BrowserHandoffCommandV1 {
	return { schemaVersion: 1, command: commandValue, confirmationId };
}

function request(
	idempotencyKey = "browser-handoff-key",
	commandValue = command(),
): {
	readonly request: BrowserHandoffAdmissionRequestV1;
	readonly input: Parameters<typeof transaction.admit>[0];
} {
	const requestValue: BrowserHandoffAdmissionRequestV1 = {
		schemaVersion: 1,
		conversationId,
		command: commandValue,
		idempotencyKey,
		requestId: `request-${idempotencyKey}`,
		traceId: `trace-${idempotencyKey}`,
	};
	return {
		request: requestValue,
		input: {
			command: requestValue,
			authority,
			requestDigest: browserHandoffAdmissionRequestDigestV1(requestValue),
		},
	};
}

function plan(
	input: Parameters<typeof transaction.admit>[0],
	state: BrowserHandoffAdmissionStateV1,
): BrowserHandoffAdmissionPlanV1 {
	const active = state.activeExecution;
	if (!active) throw new Error("missing active execution");
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				conversationId,
				actorId,
				idempotencyKey: input.command.idempotencyKey,
			}),
		)
		.digest("hex");
	return {
		schemaVersion: 1,
		kind: "browser-handoff",
		conversationId,
		agentId,
		actorId,
		channelId: "web",
		executionId: active.executionId,
		turnId: active.turnId,
		sessionGeneration: active.sessionGeneration,
		deliveryFence: active.deliveryFence,
		hostSessionRef: "host-browser-handoff-store",
		command: input.command.command,
		outbox: {
			id: `conversation:browser-handoff:${digest}`,
			operation: "conversation.browser.handoff.v1",
			payload: {
				schemaVersion: 1,
				conversationId,
				agentId,
				actorId,
				channelId: "web",
				executionId: active.executionId,
				turnId: active.turnId,
				sessionGeneration: active.sessionGeneration,
				deliveryFence: active.deliveryFence,
				command: input.command.command,
			},
			requestId: input.command.requestId,
			traceId: input.command.traceId,
		},
		result: {
			schemaVersion: 1,
			status: "submitted",
			conversationId,
			executionId: active.executionId,
			command: input.command.command.command,
		},
		idempotency: {
			scopeType: "conversation",
			scopeId: conversationId,
			actorId,
			key: input.command.idempotencyKey,
			requestDigest: input.requestDigest,
		},
	};
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("browser-handoff-admission");
	databaseUrl = testDatabase.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	client = postgres(databaseUrl, { max: 5, onnotice: () => {} });
	transaction = new PostgresBrowserHandoffAdmissionTransactionV1({
		databaseUrl,
	});
}, 120_000);

afterEach(async () => {
	await client`truncate platform.conversations cascade`;
	await client`truncate platform.agents cascade`;
	await client`truncate platform.outbox_items, platform.idempotency_records`;
});

afterAll(async () => {
	await transaction?.close();
	await client?.end();
	await testDatabase?.stop();
});

async function seed(status: "active" | "ready" = "active") {
	await client`insert into platform.agents
		(id, current_configuration_revision, authorization_revision)
		values (${agentId}, 1, ${authorizationRevision})`;
	await client`insert into platform.conversations
		(id, agent_id, actor_id, principal_type, channel_id, status,
		 session_generation, host_session_ref, authorization_revision,
		 last_conversation_cursor, created_at, updated_at)
		values (${conversationId}, ${agentId}, ${actorId}, 'user', 'web', ${status},
		 1, 'host-browser-handoff-store', ${authorizationRevision}, 0, now(), now())`;
	await client`insert into platform.conversation_executions
		(execution_id, conversation_id, agent_id, actor_id, principal_type, channel_id,
		 turn_id, status, session_generation, delivery_fence, authorization_revision,
		 created_at, updated_at)
		values (${executionId}, ${conversationId}, ${agentId}, ${actorId}, 'user', 'web',
		 ${turnId}, 'processing', 1, 7, ${authorizationRevision}, now(), now())`;
}

describe("Postgres Browser handoff admission", () => {
	it("commits one existing outbox/idempotency transaction and replays it", async () => {
		await seed();
		const { request: commandRequest, input } = request();
		const decide = async (state: BrowserHandoffAdmissionStateV1) =>
			plan(input, state);
		const accepted = await transaction.admit(input, decide, async () => true);
		expect(accepted.outcome).toBe("accepted");
		if (accepted.outcome !== "accepted") throw new Error("not accepted");
		const replayed = await transaction.admit(input, decide, async () => true);
		expect(replayed).toEqual({ outcome: "replayed", plan: accepted.plan });
		const [counts] = await client<
			[{ outbox: number; idempotency: number; audit: number }][]
		>`
			select
				(select count(*)::int from platform.outbox_items where operation = 'conversation.browser.handoff.v1') as outbox,
				(select count(*)::int from platform.idempotency_records where command_type = 'browser.handoff') as idempotency,
				(select count(*)::int from platform.conversation_audit_events where action = 'conversation.browser_handoff.accepted') as audit`;
		expect(counts).toEqual({ outbox: 1, idempotency: 1, audit: 1 });
		expect(commandRequest.command.command).toBe("take_over");
	});

	it("rejects a same-key request with a different digest", async () => {
		await seed();
		const first = request();
		await transaction.admit(
			first.input,
			async (state) => plan(first.input, state),
			async () => true,
		);
		const conflicting = request(
			first.request.idempotencyKey,
			command("different-handoff"),
		);
		await expect(
			transaction.admit(
				conflicting.input,
				async (state) => plan(conflicting.input, state),
				async () => true,
			),
		).resolves.toEqual({ outcome: "conflict", reason: "idempotency_conflict" });
	});

	it.each([
		["pause with handoff identity", pause("handoff-browser-handoff-store")],
		["confirm side effect", sideEffect("confirm_side_effect")],
		["reject side effect", sideEffect("reject_side_effect")],
		["cancel side effect", sideEffect("cancel_side_effect")],
	] as const)(
		"commits and replays %s through the same outbox",
		async (_name, commandValue) => {
			await seed();
			const { input } = request(
				`browser-handoff-${commandValue.command}`,
				commandValue,
			);
			const decide = async (state: BrowserHandoffAdmissionStateV1) =>
				plan(input, state);
			const accepted = await transaction.admit(input, decide, async () => true);
			expect(accepted).toMatchObject({
				outcome: "accepted",
				plan: { command: commandValue },
			});
			const replayed = await transaction.admit(input, decide, async () => true);
			expect(replayed).toEqual({
				outcome: "replayed",
				plan: (accepted as { plan: BrowserHandoffAdmissionPlanV1 }).plan,
			});
			const [counts] = await client<
				[{ outbox: number; idempotency: number }][]
			>`select
				(select count(*)::int from platform.outbox_items where operation = 'conversation.browser.handoff.v1') as outbox,
				(select count(*)::int from platform.idempotency_records where command_type = 'browser.handoff') as idempotency`;
			expect(counts).toEqual({ outbox: 1, idempotency: 1 });
		},
	);

	it("fails closed for an active execution in a ready conversation", async () => {
		await seed("ready");
		const { input } = request();
		await expect(
			transaction.admit(
				input,
				async (state) => plan(input, state),
				async () => true,
			),
		).resolves.toEqual({
			outcome: "unavailable",
			reason: "conversation_unavailable",
		});
	});

	it("fails closed when the active Execution belongs to an older session", async () => {
		await seed();
		await client`
			update platform.conversations
			set session_generation = 2
			where id = ${conversationId}
		`;
		const { input } = request();
		await expect(
			transaction.admit(
				input,
				async (state) => plan(input, state),
				async () => true,
			),
		).resolves.toEqual({
			outcome: "unavailable",
			reason: "conversation_unavailable",
		});
	});
});
