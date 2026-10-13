import { createHash } from "node:crypto";
import {
	type CurrentTaskUserV1,
	createWecomAuthorizationV1,
	createWecomChannelV1,
	createWecomDeliveryV1,
	type WecomConnectionAuthorizationFactV1,
	type WecomConnectionAuthorizationPortV1,
	type WecomConnectionAuthorizationRequestV1,
	type WecomIdentityPortV1,
	type WecomMessageV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { PostgresWecomChannelV1 } from "./wecom-channel.ts";

let db: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
const disabledUsers = new Set<string>();

const fixtureUserDirectory = {
	resolveUser: async (userId: string): Promise<CurrentTaskUserV1> => ({
		schemaVersion: 1,
		userId,
		accountStatus: disabledUsers.has(userId) ? "disabled" : "active",
		organizationIds: ["controlled-org"],
		authorizationRevision: "identity-1",
	}),
};
const fixtureIdentity: WecomIdentityPortV1 = {
	resolveSender: async (scope) =>
		fixtureUserDirectory.resolveUser(scope.senderId),
	activeUsers: async (ids) => ids,
};

const digest = (values: readonly unknown[]) =>
	createHash("sha256").update(JSON.stringify(values)).digest("hex");

function eventKey(message: WecomMessageV1) {
	return digest([message.kind, message.providerId, message.eventId]);
}

function factFor(
	message: WecomMessageV1,
	overrides: Partial<WecomConnectionAuthorizationFactV1> = {},
): WecomConnectionAuthorizationFactV1 {
	return {
		schemaVersion: 1,
		providerId: message.providerId,
		bindingReference: message.bindingReference,
		senderId: message.senderId,
		authorizationReference: `opaque-ref-${message.agentId}`,
		authorizationRevision: "authorization-r1",
		grantRevision: "grant-r1",
		revocationRevision: "revocation-r1",
		expiresAt: "2099-01-01T00:00:00.000Z",
		...overrides,
	};
}

function messageFor(
	agentId: string,
	eventId: string,
	overrides: Partial<WecomMessageV1> = {},
): WecomMessageV1 {
	return {
		providerId: `provider-${agentId}`,
		agentId,
		bindingReference: "binding-1",
		kind: "wecom_bot",
		senderId: `sender-${eventId}`,
		peerId: `group-${eventId}`,
		conversationType: "group",
		threadId: null,
		eventId,
		text: "controlled connection fact message",
		replyHandle: `reply-${eventId}`,
		replyExpiresAt: "2099-01-01T00:00:00.000Z",
		...overrides,
	};
}

async function seedAgent(agentId: string) {
	const configuration = {
		schemaVersion: 1,
		agentId,
		revision: 1,
		source: {
			kind: "standard",
			templateId: "codex",
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admitted",
			allowedEnvironmentKeys: [],
			allowedSecretKeys: [],
			platformManagedKeys: [],
			connectionEnabled: true,
		},
		modelConfiguration: {
			catalogRevision: "catalog-1",
			options: [
				{
					optionId: "model-1",
					endpointId: "endpoint-1",
					modelId: "model-1",
					reasoningLevels: ["low"],
					credential: { secretId: "fixture-secret", version: 1, isSet: true },
				},
			],
			defaultOptionId: "model-1",
			defaultReasoningLevel: "low",
		},
		actions: [],
		actionSetRevision: "actions-1",
		environment: [],
		secrets: [],
		channels: [{ kind: "wecom_bot", bindingReference: "binding-1" }],
		channelRevision: "channels-1",
	};
	await sql`insert into platform.agents
		(id,current_configuration_revision,authorization_revision)
		values (${agentId},1,'authorization-1')`;
	await sql`insert into platform.agent_applications
		(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,
		 management_revision,approval_revision,service_availability,desired_state,workload_revision,fence)
		values (${`app-${agentId}`},${agentId},'owner-1','Fixture','Fixture','available',
		 'trace-1','request-1',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_owners (agent_id,owner_id,created_at)
		values (${agentId},'owner-1',now())`;
	await sql`insert into platform.agent_availability (agent_id,target_type,target_id)
		values (${agentId},'organization','controlled-org')`;
	await sql`insert into platform.agent_configuration_revisions
		(agent_id,revision,source_reference,configuration,created_at)
		values (${agentId},1,'fixture',${sql.json(configuration)},now())`;
}

async function seedRelayKey(senderId: string) {
	const keyId = `fixture-key:personal:${senderId}`;
	await sql`insert into platform.relay_key_subjects
		(purpose,subject_id,last_version,current_version)
		values ('personal',${senderId},1,1)
		on conflict (purpose,subject_id) do nothing`;
	await sql`insert into platform.relay_key_versions
		(purpose,subject_id,key_version,key_id,ciphertext)
		values ('personal',${senderId},1,${keyId},
		${sql.json({ purpose: "personal", subjectId: senderId, keyId, keyVersion: 1 })})
		on conflict do nothing`;
}

async function seedWorkerLease(
	message: WecomMessageV1,
	holderId = "worker-1",
	fence = 7,
) {
	await sql`insert into platform.wecom_connections
		(bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status)
		values (${message.providerId},${message.agentId},${message.bindingReference},
		${holderId},${fence},now()+interval '5 minutes','connected')`;
	return { botId: message.providerId, holderId, fence };
}

function fixture(options: {
	readonly connectionAuthorization?: WecomConnectionAuthorizationPortV1;
	readonly connectionHolderId?: string;
}) {
	const store = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
		identity: fixtureIdentity,
		connectionAuthorization: options.connectionAuthorization,
		connectionHolderId: options.connectionHolderId,
	});
	const authorization = createWecomAuthorizationV1({
		identity: fixtureIdentity,
		state: store,
		connectionAuthorization: options.connectionAuthorization,
	});
	const base = createWecomChannelV1({ store, authorization });
	return {
		store,
		authorization,
		async receive(
			message: WecomMessageV1,
			connectionFence?: {
				readonly botId: string;
				readonly holderId: string;
				readonly fence: number;
			},
		) {
			await seedRelayKey(message.senderId);
			return base.receive(message, connectionFence);
		},
	};
}

async function businessFacts(agentId: string, message: WecomMessageV1) {
	const key = eventKey(message);
	const [row] = await sql`
		select
			(select count(*)::int from platform.wecom_receipts where id=${key}) as receipts,
			(select count(*)::int from platform.conversations where agent_id=${agentId}) as conversations,
			(select count(*)::int from platform.conversation_executions where agent_id=${agentId}) as executions,
			(select count(*)::int from platform.conversation_messages where conversation_id in
				(select id from platform.conversations where agent_id=${agentId})) as messages,
			(select count(*)::int from platform.task_authorization_records where boundary->>'agentId'=${agentId}) as authority,
			(select count(*)::int from platform.outbox_items where trace_id=${key} or request_id=${key}) as outbox,
			(select count(*)::int from platform.audit_events where agent_id=${agentId} and action='wecom.accepted') as accepted_audit`;
	return row;
}

async function expectBusinessRollback(
	agentId: string,
	message: WecomMessageV1,
) {
	expect(await businessFacts(agentId, message)).toEqual({
		receipts: 0,
		conversations: 0,
		executions: 0,
		messages: 0,
		authority: 0,
		outbox: 0,
		accepted_audit: 0,
	});
}

beforeAll(async () => {
	db = await startPostgresTestDatabase("wecom-connection-fact");
	await migratePlatformDatabase(db);
	sql = postgres(db.databaseUrl);
}, 120_000);

afterAll(async () => {
	await sql?.end();
	await db?.stop();
});

describe("WeCom sender-to-Connection authorization fact", () => {
	it.each([
		{
			name: "missing producer",
			resolver: undefined,
			outcome: "unavailable" as const,
		},
		{
			name: "null grant",
			resolver: {
				resolve: async (): Promise<WecomConnectionAuthorizationFactV1 | null> =>
					null,
			},
			outcome: "denied" as const,
		},
		{
			name: "revoked or expired grant",
			resolver: {
				resolve: async (
					request: WecomConnectionAuthorizationRequestV1,
				): Promise<WecomConnectionAuthorizationFactV1 | null> => ({
					schemaVersion: 1,
					providerId: request.providerId,
					bindingReference: request.bindingReference,
					senderId: request.senderId,
					authorizationReference: "revoked-ref",
					authorizationRevision: "authorization-r1",
					grantRevision: "grant-revoked",
					revocationRevision: "revoked-r2",
					expiresAt: "2020-01-01T00:00:00.000Z",
				}),
			},
			outcome: "denied" as const,
		},
		{
			name: "producer unavailable",
			resolver: {
				resolve:
					async (): Promise<WecomConnectionAuthorizationFactV1 | null> => {
						throw new Error("controlled producer unavailable");
					},
			},
			outcome: "unavailable" as const,
		},
	])(
		"rejects ingress when the Connection fact is $name",
		async ({ name: _name, resolver, outcome }) => {
			const agentId = `fact-ingress-${Math.random().toString(36).slice(2)}`;
			await seedAgent(agentId);
			const message = messageFor(
				agentId,
				`ingress-${Date.now()}-${Math.random()}`,
			);
			const useCase = fixture({ connectionAuthorization: resolver });
			try {
				expect(await useCase.receive(message)).toEqual({ outcome });
				await expectBusinessRollback(agentId, message);
			} finally {
				await useCase.store.close();
			}
		},
	);

	it.each([
		{
			name: "sender mismatch",
			mutate: (message: WecomMessageV1) =>
				factFor(message, { senderId: "different-sender" }),
		},
		{
			name: "provider mismatch",
			mutate: (message: WecomMessageV1) =>
				factFor(message, { providerId: "different-provider" }),
		},
		{
			name: "binding mismatch",
			mutate: (message: WecomMessageV1) =>
				factFor(message, { bindingReference: "different-binding" }),
		},
	])(
		"rejects ingress when the producer returns a $name fact",
		async ({ mutate }) => {
			const agentId = `fact-cross-${Math.random().toString(36).slice(2)}`;
			await seedAgent(agentId);
			const message = messageFor(
				agentId,
				`cross-${Date.now()}-${Math.random()}`,
			);
			const resolver: WecomConnectionAuthorizationPortV1 = {
				resolve: async () => mutate(message),
			};
			const useCase = fixture({ connectionAuthorization: resolver });
			try {
				expect(await useCase.receive(message)).toEqual({ outcome: "denied" });
				await expectBusinessRollback(agentId, message);
			} finally {
				await useCase.store.close();
			}
		},
	);

	it.each([
		{
			name: "null at the final resolver check",
			terminal: null,
		},
		{
			name: "a changed grant revision at the final resolver check",
			terminal: "changed" as const,
		},
	])("rolls back all business state when $name", async ({ terminal }) => {
		const agentId = `fact-final-${Math.random().toString(36).slice(2)}`;
		await seedAgent(agentId);
		const message = messageFor(agentId, `final-${Date.now()}-${Math.random()}`);
		const fact = factFor(message);
		let calls = 0;
		const resolver: WecomConnectionAuthorizationPortV1 = {
			resolve: async () => {
				calls += 1;
				if (calls < 3) return fact;
				return terminal === null
					? null
					: { ...fact, grantRevision: "grant-r2" };
			},
		};
		const useCase = fixture({ connectionAuthorization: resolver });
		try {
			expect(await useCase.receive(message)).toEqual({ outcome: "denied" });
			expect(calls).toBeGreaterThanOrEqual(3);
			await expectBusinessRollback(agentId, message);
		} finally {
			await useCase.store.close();
		}
	});

	it("does not treat a valid Worker lease/fence as sender authorization", async () => {
		const agentId = `fact-fence-${Math.random().toString(36).slice(2)}`;
		await seedAgent(agentId);
		const message = messageFor(agentId, `fence-${Date.now()}-${Math.random()}`);
		const fence = await seedWorkerLease(message);
		const useCase = fixture({ connectionHolderId: fence.holderId });
		try {
			expect(await useCase.receive(message, fence)).toEqual({
				outcome: "unavailable",
			});
			await expectBusinessRollback(agentId, message);
		} finally {
			await useCase.store.close();
		}
	});

	it("persists the fact in JSONB, keeps it out of task/message/receipt/audit data, and delivers after restart", async () => {
		const agentId = `fact-restart-${Math.random().toString(36).slice(2)}`;
		await seedAgent(agentId);
		const message = messageFor(
			agentId,
			`restart-${Date.now()}-${Math.random()}`,
		);
		const fact = factFor(message);
		const resolver: WecomConnectionAuthorizationPortV1 = {
			resolve: async () => fact,
		};
		const fence = await seedWorkerLease(message);
		const first = fixture({
			connectionAuthorization: resolver,
			connectionHolderId: fence.holderId,
		});
		let accepted: Awaited<ReturnType<typeof first.receive>>;
		try {
			accepted = await first.receive(message, fence);
			expect(accepted.outcome).toBe("accepted");
			if (accepted.outcome !== "accepted") throw new Error("Expected accepted");
			const receiptId = accepted.receipt.receiptId;
			const [receipt] = await sql<
				{ connection_authorization_fact: unknown }[]
			>`select connection_authorization_fact from platform.wecom_receipts where id=${receiptId}`;
			expect(receipt?.connection_authorization_fact).toEqual(fact);
			const read = await first.store.read(receiptId, message.senderId);
			expect(read).not.toHaveProperty("connectionAuthorizationFact");
			const [boundary] = await sql<{ boundary: unknown }[]>`
				select boundary from platform.task_authorization_records where execution_id=${accepted.receipt.executionId}`;
			const [storedMessage] = await sql<{ text: string }[]>`
				select text from platform.conversation_messages where execution_id=${accepted.receipt.executionId}`;
			const auditRows = await sql<{ details: unknown }[]>`
				select details from platform.audit_events where trace_id=${receiptId}`;
			const ordinaryData = JSON.stringify({
				boundary: boundary?.boundary,
				message: storedMessage?.text,
				audit: auditRows.map((row) => row.details),
			});
			expect(ordinaryData).not.toContain(fact.authorizationReference);
			expect(ordinaryData).not.toContain(fact.grantRevision);
			expect(ordinaryData).not.toContain(fact.revocationRevision);
			await sql`update platform.conversation_executions set status='completed' where execution_id=${accepted.receipt.executionId}`;
			await sql`insert into platform.conversation_events
				(event_id,conversation_id,execution_id,adapter_event_key,sequence,
				 conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,
				 occurred_at,source)
				values (${`reply-event-${agentId}`},${accepted.receipt.conversationId},
				 ${accepted.receipt.executionId},${`reply-adapter-${agentId}`},1,1,
				 'text.delta',${sql.json({ type: "text.delta", text: "legitimate reply" })},
				 ${"d".repeat(64)},${`runtime-reply-${agentId}`},now(),'runtime')`;
		} finally {
			await first.store.close();
		}

		const restarted = fixture({
			connectionAuthorization: resolver,
			connectionHolderId: fence.holderId,
		});
		try {
			const persistedClaim = await restarted.store.claim();
			expect(persistedClaim?.connectionAuthorizationFact).toEqual(fact);
			if (!persistedClaim) throw new Error("Expected persisted claim");
			await sql`update platform.wecom_receipts set delivery_status='pending', lease_until=null where id=${persistedClaim.receiptId}`;
			let sends = 0;
			let revalidated = false;
			const delivery = createWecomDeliveryV1({
				store: restarted.store,
				authorization: restarted.authorization,
				sender: {
					async send(input) {
						sends += 1;
						revalidated = (await input.revalidate?.()) === true;
						return "sent";
					},
				},
			});
			expect(await delivery.dispatch()).toBe(true);
			expect(sends).toBe(1);
			expect(revalidated).toBe(true);
		} finally {
			await restarted.store.close();
		}
	});

	it("does not call the sender when the persisted grant is revoked before send", async () => {
		const agentId = `fact-revoke-${Math.random().toString(36).slice(2)}`;
		await seedAgent(agentId);
		const message = messageFor(
			agentId,
			`revoke-${Date.now()}-${Math.random()}`,
		);
		const fact = factFor(message);
		let current: WecomConnectionAuthorizationFactV1 | null = fact;
		const resolver: WecomConnectionAuthorizationPortV1 = {
			resolve: async () => current,
		};
		const fence = await seedWorkerLease(message);
		const useCase = fixture({
			connectionAuthorization: resolver,
			connectionHolderId: fence.holderId,
		});
		try {
			const accepted = await useCase.receive(message, fence);
			expect(accepted.outcome).toBe("accepted");
			if (accepted.outcome !== "accepted") throw new Error("Expected accepted");
			await sql`update platform.conversation_executions set status='completed' where execution_id=${accepted.receipt.executionId}`;
			current = null;
			let sends = 0;
			const delivery = createWecomDeliveryV1({
				store: useCase.store,
				authorization: useCase.authorization,
				sender: {
					async send() {
						sends += 1;
						return "sent";
					},
				},
			});
			expect(await delivery.dispatch()).toBe(true);
			expect(sends).toBe(0);
			expect(
				(await useCase.store.read(accepted.receipt.receiptId, message.senderId))
					?.deliveryStatus,
			).toBe("cancelled");
		} finally {
			await useCase.store.close();
		}
	});

	it("does not call the sender when the trusted sender is disabled before send", async () => {
		const agentId = `fact-disable-${Math.random().toString(36).slice(2)}`;
		await seedAgent(agentId);
		const message = messageFor(
			agentId,
			`disable-${Date.now()}-${Math.random()}`,
		);
		const fact = factFor(message);
		const resolver: WecomConnectionAuthorizationPortV1 = {
			resolve: async () => fact,
		};
		const useCase = fixture({ connectionAuthorization: resolver });
		try {
			const accepted = await useCase.receive(message);
			expect(accepted.outcome).toBe("accepted");
			if (accepted.outcome !== "accepted") throw new Error("Expected accepted");
			await sql`update platform.conversation_executions set status='completed'
				where execution_id=${accepted.receipt.executionId}`;
			await sql`insert into platform.conversation_events
				(event_id,conversation_id,execution_id,adapter_event_key,sequence,
				 conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
				values (${`disable-reply-${agentId}`},${accepted.receipt.conversationId},
				 ${accepted.receipt.executionId},${`disable-adapter-${agentId}`},1,1,'text.delta',
				 ${sql.json({ type: "text.delta", text: "reply" })},${"e".repeat(64)},
				 ${`runtime-disable-${agentId}`},now(),'runtime')`;
			disabledUsers.add(message.senderId);
			let sends = 0;
			const delivery = createWecomDeliveryV1({
				store: useCase.store,
				authorization: useCase.authorization,
				sender: {
					async send() {
						sends += 1;
						return "sent";
					},
				},
			});
			expect(await delivery.dispatch()).toBe(true);
			expect(sends).toBe(0);
			expect(
				(await useCase.store.read(accepted.receipt.receiptId, message.senderId))
					?.deliveryStatus,
			).toBe("cancelled");
		} finally {
			disabledUsers.delete(message.senderId);
			await useCase.store.close();
		}
	});
});
