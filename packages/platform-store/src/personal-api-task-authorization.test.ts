import { createHash } from "node:crypto";
import {
	createPersonalApiCredentialUseCaseV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
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
import { migratePlatformDatabase } from "./migrate.ts";
import { PostgresPersonalApiCredentialStoreV1 } from "./personal-api-credentials.ts";
import {
	requireCurrentPersonalApiTaskAdmissionV1,
	resolvePersonalApiTaskAdmissionAuthorityV1,
} from "./personal-api-task-authorization.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const userId = "policy_user";
const agentId = "policy_agent";
const binding = {
	principal: { kind: "user" as const, id: userId },
	actorId: userId,
	agentId,
	channelId: "api" as const,
};
const currentUser = (id: string) => ({
	schemaVersion: 1,
	userId: id,
	accountStatus: "active",
	organizationIds: ["owner_org"],
	authorizationRevision: "identity_1",
});
let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let governanceStore: PostgresPersonalApiCredentialStoreV1;
let resolveUser: TaskUserDirectoryV1["resolveUser"];
const directory: TaskUserDirectoryV1 = {
	resolveUser: (id) => resolveUser(id),
};

async function issue(key = "issue.1", scopes = ["agent:use"]) {
	const result = await createPersonalApiCredentialUseCaseV1({
		transaction: governanceStore,
		userDirectory: directory,
	}).issue(
		{ userId, idempotencyKey: key, requestId: key, traceId: "policy_trace" },
		{ scopes, expiresAt: null },
	);
	if (result.credential === null) throw new Error("Expected first delivery");
	return { ...result, credential: result.credential };
}

async function resolve(transaction: postgres.TransactionSql, material: string) {
	await transaction`select set_config('lock_timeout', '5s', true)`;
	return resolvePersonalApiTaskAdmissionAuthorityV1(
		transaction,
		{ material, agentId },
		directory,
	);
}

// A policy transaction harness using real business tables, not submitTask or an
// API/Worker acceptance claim. The Task consumer owner verifies its actual path.
async function writePolicyRecords(transaction: postgres.TransactionSql) {
	await transaction`insert into platform.conversations
		(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision)
		values ('policy_conversation',${agentId},${userId},'api','ready',1,'agent_1')`;
	await transaction`insert into platform.conversation_executions
		(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,
		 session_generation,authorization_revision,created_at)
		values ('policy_execution','policy_conversation',${agentId},${userId},'api',
		 'policy_turn','submitted',1,'agent_1',clock_timestamp())`;
	await transaction`insert into platform.outbox_items
		(id,scope_type,scope_id,operation,payload,trace_id,request_id)
		values ('policy_work','conversation','policy_conversation','policy.transaction.test',
		 ${transaction.json({ executionId: "policy_execution" })},'policy_trace','policy_request')`;
	await transaction`insert into platform.idempotency_records
		(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result)
		values ('policy_idempotency','policy_test',${userId},${userId},'policy_test','task.1',
		 ${"b".repeat(64)},'completed',${transaction.json({ executionId: "policy_execution" })})`;
	await writePolicyAudit(transaction, "policy_accepted");
}

async function writePolicyAudit(
	transaction: postgres.TransactionSql,
	id: string,
) {
	await transaction`insert into platform.audit_events
		(id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,request_id)
		values (${id},'policy_trace','user',${userId},'policy.test','execution',
		 'policy_execution','succeeded','policy_request')`;
}

async function counts() {
	const [row] = await client`select
		(select count(*)::int from platform.conversations) as conversations,
		(select count(*)::int from platform.conversation_executions) as executions,
		(select count(*)::int from platform.outbox_items) as outbox,
		(select count(*)::int from platform.audit_events where action='policy.test') as audit,
		(select count(*)::int from platform.idempotency_records where scope_type='policy_test') as idempotency`;
	return row;
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("personal-api-task-policy");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 5 });
	governanceStore = new PostgresPersonalApiCredentialStoreV1({
		databaseUrl: database.databaseUrl,
	});
});
beforeEach(async () => {
	resolveUser = async (id) => currentUser(id);
	await client`truncate platform.agents,platform.conversations,platform.platform_api_credentials,
		platform.platform_user_disables,platform.platform_applications,platform.idempotency_records,platform.audit_events,
		platform.outbox_items cascade`;
	await client`insert into platform.agents(id,authorization_revision) values (${agentId},'agent_1')`;
	await client`insert into platform.agent_principal_grants
		(agent_id,principal_type,principal_id,grant_type,authorization_revision)
		values (${agentId},'user',${userId},'use','use_1')`;
});
afterAll(async () => {
	await governanceStore?.close();
	await client?.end();
	await database?.stop();
});

describe("PostgreSQL same-transaction personal Task policy", () => {
	it("resolves actual issued material and keeps transient references out of business records", async () => {
		const credential = await issue();
		await client.begin(async (transaction) => {
			const authority = await resolve(transaction, credential.credential);
			expect(authority.credentialId).toBe(credential.metadata.credentialId);
			await requireCurrentPersonalApiTaskAdmissionV1(
				transaction,
				authority,
				binding,
				directory,
			);
			await writePolicyRecords(transaction);
			await requireCurrentPersonalApiTaskAdmissionV1(
				transaction,
				authority,
				binding,
				directory,
			);
		});
		expect(await counts()).toEqual({
			conversations: 1,
			executions: 1,
			outbox: 1,
			audit: 1,
			idempotency: 1,
		});
		const records = await client`select payload from platform.outbox_items
			union all select result as payload from platform.idempotency_records where scope_type='policy_test'
			union all select details as payload from platform.audit_events where action='policy.test'`;
		const durable = JSON.stringify(records);
		expect(durable).not.toContain(credential.credential);
		expect(durable).not.toContain(credential.metadata.credentialId);
		expect(durable).not.toContain(
			createHash("sha256").update(credential.credential).digest("hex"),
		);
	});

	it.each(["manage", "missing", "revoked"])(
		"requires explicit use instead of %s",
		async (kind) => {
			const credential = await issue();
			if (kind === "manage") {
				await client`update platform.agent_principal_grants set grant_type='manage'`;
			} else if (kind === "missing") {
				await client`delete from platform.agent_principal_grants`;
			} else {
				await client`update platform.agent_principal_grants set revoked_at=clock_timestamp()`;
			}
			await expect(
				client.begin((transaction) =>
					resolve(transaction, credential.credential),
				),
			).rejects.toMatchObject({ code: "not_found" });
		},
	);

	it("rejects missing use scope, another exact credential and ambiguous material", async () => {
		const readOnly = await issue("issue.read", ["agent:read"]);
		await expect(
			client.begin((transaction) => resolve(transaction, readOnly.credential)),
		).rejects.toMatchObject({ code: "forbidden" });
		const first = await issue();
		const second = await issue("issue.2");
		await expect(
			client.begin(async (transaction) => {
				const authority = await resolve(transaction, first.credential);
				await requireCurrentPersonalApiTaskAdmissionV1(
					transaction,
					{ ...authority, credentialId: second.metadata.credentialId },
					binding,
					directory,
				);
			}),
		).rejects.toMatchObject({ code: "authentication_required" });
		await client`update platform.platform_api_credentials set credential_hash=
			(select credential_hash from platform.platform_api_credentials where id=${first.metadata.credentialId})
			where id=${second.metadata.credentialId}`;
		await expect(
			client.begin((transaction) => resolve(transaction, first.credential)),
		).rejects.toMatchObject({ code: "unavailable" });
	});

	it.each(["repeatable read", "serializable"] as const)(
		"rejects unsupported %s without changing it",
		async (isolation) => {
			const credential = await issue();
			await expect(
				client.begin(`isolation level ${isolation}`, async (transaction) => {
					const [before] = await transaction`show transaction_isolation`;
					expect(before?.transaction_isolation).toBe(isolation);
					try {
						return await resolve(transaction, credential.credential);
					} finally {
						const [after] = await transaction`show transaction_isolation`;
						expect(after?.transaction_isolation).toBe(isolation);
					}
				}),
			).rejects.toMatchObject({ code: "unavailable" });
		},
	);

	it.each(["accepted", "replayed"] as const)(
		"rolls back the %s work on every final-check failure",
		async (exit) => {
			for (const failure of [
				"expiry",
				"credential_revoke",
				"use_revoke",
				"disabled",
				"identity_drift",
			] as const) {
				const credential = await issue(`issue.${failure}`);
				if (exit === "replayed" && failure === "expiry") {
					await client.begin((transaction) => writePolicyRecords(transaction));
				}
				const baseline = await counts();
				await expect(
					client.begin(async (transaction) => {
						const authority = await resolve(transaction, credential.credential);
						await requireCurrentPersonalApiTaskAdmissionV1(
							transaction,
							authority,
							binding,
							directory,
						);
						if (exit === "accepted") await writePolicyRecords(transaction);
						else
							await writePolicyAudit(transaction, `policy_replay_${failure}`);
						if (failure === "expiry") {
							await transaction`update platform.platform_api_credentials set expires_at=clock_timestamp()-interval '1 second' where id=${authority.credentialId}`;
						} else if (failure === "credential_revoke") {
							await transaction`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id=${authority.credentialId}`;
						} else if (failure === "use_revoke") {
							await transaction`update platform.agent_principal_grants set revoked_at=clock_timestamp()`;
						} else if (failure === "disabled") {
							resolveUser = async (id) => ({
								...currentUser(id),
								accountStatus: "disabled",
							});
						} else {
							resolveUser = async (id) => ({
								...currentUser(id),
								authorizationRevision: "identity_2",
							});
						}
						await requireCurrentPersonalApiTaskAdmissionV1(
							transaction,
							authority,
							binding,
							directory,
						);
					}),
				).rejects.toMatchObject({
					code:
						failure === "use_revoke"
							? "not_found"
							: failure === "disabled"
								? "forbidden"
								: failure === "identity_drift"
									? "unavailable"
									: "authentication_required",
				});
				resolveUser = async (id) => currentUser(id);
				expect(await counts()).toEqual(baseline);
			}
		},
	);

	it("uses a fresh DB clock after a slow identity dependency", async () => {
		const credential = await issue();
		await client`update platform.platform_api_credentials set expires_at=clock_timestamp()+interval '1 second' where id=${credential.metadata.credentialId}`;
		await expect(
			client.begin(async (transaction) => {
				const authority = await resolve(transaction, credential.credential);
				await writePolicyRecords(transaction);
				resolveUser = async (id) => {
					for (let attempt = 0; attempt < 100; attempt++) {
						const [row] =
							await client`select clock_timestamp()>=expires_at as expired from platform.platform_api_credentials where id=${credential.metadata.credentialId}`;
						if (row?.expired) return currentUser(id);
						await new Promise((done) => setTimeout(done, 20));
					}
					throw new Error("Expected database expiry");
				};
				await requireCurrentPersonalApiTaskAdmissionV1(
					transaction,
					authority,
					binding,
					directory,
				);
			}),
		).rejects.toMatchObject({ code: "authentication_required" });
		expect(await counts()).toEqual({
			conversations: 0,
			executions: 0,
			outbox: 0,
			audit: 0,
			idempotency: 0,
		});
	});

	it.each(["credential", "use", "disable"] as const)(
		"orders concurrent %s mutation after the held policy transaction",
		async (kind) => {
			const credential = await issue();
			const writer = postgres(database.databaseUrl, { max: 1 });
			let signalEntered = () => {};
			let releaseWork = () => {};
			const entered = new Promise<void>((done) => {
				signalEntered = done;
			});
			const held = new Promise<void>((done) => {
				releaseWork = done;
			});
			const [writerSession] = await writer<
				{ pid: number }[]
			>`select pg_backend_pid() as pid`;
			const work = client.begin(async (transaction) => {
				const authority = await resolve(transaction, credential.credential);
				signalEntered();
				await held;
				await writePolicyRecords(transaction);
				await requireCurrentPersonalApiTaskAdmissionV1(
					transaction,
					authority,
					binding,
					directory,
				);
			});
			let pending: Promise<unknown> | undefined;
			try {
				await Promise.race([entered, work]);
				const mutation =
					kind === "credential"
						? writer`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id=${credential.metadata.credentialId}`
						: kind === "use"
							? writer`update platform.agent_principal_grants set revoked_at=clock_timestamp()`
							: writer`insert into platform.platform_user_disables(user_id) values (${userId})`;
				pending = Promise.resolve(mutation);
				let blocked = false;
				for (let attempt = 0; attempt < 100; attempt++) {
					const [activity] =
						await client`select wait_event_type from pg_stat_activity where pid=${writerSession?.pid ?? 0}`;
					if (activity?.wait_event_type === "Lock") {
						blocked = true;
						break;
					}
					await new Promise((done) => setTimeout(done, 20));
				}
				expect(blocked).toBe(true);
				releaseWork();
				await work;
				await pending;
				expect(await counts()).toEqual({
					conversations: 1,
					executions: 1,
					outbox: 1,
					audit: 1,
					idempotency: 1,
				});
				await expect(
					client.begin((transaction) =>
						resolve(transaction, credential.credential),
					),
				).rejects.toMatchObject({
					code:
						kind === "credential"
							? "authentication_required"
							: kind === "use"
								? "not_found"
								: "forbidden",
				});
			} finally {
				releaseWork();
				await work.catch(() => {});
				await pending?.catch(() => {});
				await writer.end();
			}
		},
	);

	it("fails without leaking an identity dependency payload", async () => {
		const credential = await issue();
		resolveUser = async () => {
			throw new Error(`PRIVATE_IDENTITY_PAYLOAD ${credential.credential}`);
		};
		try {
			await client.begin((transaction) =>
				resolve(transaction, credential.credential),
			);
			throw new Error("Expected refusal");
		} catch (error) {
			expect(error).toMatchObject({ code: "unavailable" });
			expect(String(error)).not.toContain("PRIVATE_IDENTITY_PAYLOAD");
			expect(String(error)).not.toContain(credential.credential);
		}
	});
});

// Synthetic stored material validates this helper's actual hash/row protocol;
// it does not prove an application issuer, recipient delivery or public Task API.
const appMaterial = `papi_${"B".repeat(43)}`;
async function seedApplicationCredential() {
	await client`insert into platform.platform_applications
		(id,name,responsible_user_id,status,authorization_revision)
		values (${userId},'controlled application',${userId},'active','application_1')`;
	await client`insert into platform.platform_api_credentials
		(id,principal_type,principal_id,credential_hash,scopes)
		values ('application_credential','application',${userId},
		${createHash("sha256").update(appMaterial).digest("hex")},${client.json(["agent:use"])})`;
	await client`insert into platform.agent_principal_grants
		(agent_id,principal_type,principal_id,grant_type,authorization_revision)
		values (${agentId},'application',${userId},'use','use_1')`;
}

describe("same-transaction typed application API policy", () => {
	it.each(["api", "api:application"] as const)(
		"resolves actual stored material and preserves %s",
		async (channelId) => {
			await seedApplicationCredential();
			await client`insert into platform.platform_user_disables(user_id) values (${userId})`;
			resolveUser = async () => {
				throw new Error("application must not inherit the same-ID user");
			};
			await client.begin(async (transaction) => {
				const authority = await resolvePersonalApiTaskAdmissionAuthorityV1(
					transaction,
					{ material: appMaterial, agentId, channelId },
					undefined,
				);
				expect(authority.principal).toEqual({
					kind: "application",
					id: userId,
				});
				expect(authority.credentialHash).toBe(
					createHash("sha256").update(appMaterial).digest("hex"),
				);
				const result = await requireCurrentPersonalApiTaskAdmissionV1(
					transaction,
					authority,
					{
						principal: authority.principal,
						actorId: userId,
						agentId,
						channelId,
					},
					undefined,
				);
				expect(result).toMatchObject({
					identityRevision: "application_1",
					useGrantRevision: "use_1",
					channelId,
				});
				expect(JSON.stringify(result)).not.toContain(authority.credentialHash);
			});
		},
	);
	it("rejects expired used material after final audit and rolls the original transaction back", async () => {
		await seedApplicationCredential();
		await expect(
			client.begin(async (transaction) => {
				const authority = await resolvePersonalApiTaskAdmissionAuthorityV1(
					transaction,
					{ material: appMaterial, agentId },
					undefined,
				);
				await transaction`insert into platform.audit_events
				(id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,request_id)
				values ('app_policy_audit','policy_trace','application',${userId},'policy.test','agent',${agentId},'succeeded','policy_request')`;
				await transaction`update platform.platform_api_credentials set expires_at=clock_timestamp() where id='application_credential'`;
				await requireCurrentPersonalApiTaskAdmissionV1(
					transaction,
					authority,
					{
						principal: authority.principal,
						actorId: userId,
						agentId,
						channelId: "api",
					},
					undefined,
				);
			}),
		).rejects.toMatchObject({ code: "authentication_required" });
		const audit =
			await client`select id from platform.audit_events where id='app_policy_audit'`;
		expect(audit).toHaveLength(0);
	});
	it("does not replace missing application use with its responsible user's valid use", async () => {
		await seedApplicationCredential();
		await client`delete from platform.agent_principal_grants where principal_type='application' and principal_id=${userId}`;
		await expect(
			client.begin((transaction) =>
				resolvePersonalApiTaskAdmissionAuthorityV1(
					transaction,
					{ material: appMaterial, agentId },
					undefined,
				),
			),
		).rejects.toMatchObject({ code: "not_found" });
	});
});
