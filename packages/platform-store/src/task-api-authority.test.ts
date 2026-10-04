import { createHash } from "node:crypto";
import type { TaskUserDirectoryV1 } from "@agent-infra/platform-core";
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
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { seedSessionSandboxFixture } from "./session-sandbox.fixture.js";

let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
const stores: PostgresConversationExecutionTransactionV1[] = [];
const material = {
	user: `papi_${"U".repeat(43)}`,
	application: `papi_${"A".repeat(43)}`,
	replacement: `papi_${"B".repeat(43)}`,
};
const user = {
	schemaVersion: 1,
	userId: "same-id",
	accountStatus: "active",
	organizationIds: [],
	authorizationRevision: "user-1",
};
const directory: TaskUserDirectoryV1 = {
	async resolveUser() {
		return user;
	},
};
function store(userDirectory: TaskUserDirectoryV1 | undefined = directory) {
	const value = new PostgresConversationExecutionTransactionV1({
		databaseUrl: database.databaseUrl,
		userDirectory,
	});
	stores.push(value);
	return value;
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("task-api-authority");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
}, 120_000);
afterEach(async () => {
	for (const value of stores.splice(0)) await value.close();
});
afterAll(async () => {
	await client?.end();
	await database?.stop();
});
beforeEach(async () => {
	await client`truncate platform.platform_api_credentials, platform.platform_user_disables, platform.platform_applications, platform.agents, platform.conversations cascade`;
	await client`insert into platform.agents(id,authorization_revision) values('agent','agent-1')`;
	await client`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('same-id','Fixture','owner','app-1')`;
	for (const kind of ["user", "application"] as const) {
		await client`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision) values('agent',${kind},'same-id','use',${`use-${kind}`})`;
		await client`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values(${`credential-${kind}`},${kind},'same-id',${createHash("sha256").update(material[kind]).digest("hex")},${client.json(["agent:read", "agent:use"])})`;
		await client`insert into platform.conversations(id,agent_id,actor_id,principal_type,channel_id,status,session_generation,authorization_revision) values(${`conversation-${kind}`},'agent','same-id',${kind},'api','ready',1,'agent-1')`;
		await seedSessionSandboxFixture(client, `conversation-${kind}`);
	}
});
describe("original Store actual-Bearer Task API supplier", () => {
	it.each(["agent:read", "agent:use"] as const)(
		"conceals missing/revoked credentials and incompatible principal channels for %s",
		async (operation) => {
			const tx = store();
			for (const kind of ["user", "application"] as const) {
				await client`delete from platform.session_sandbox_allocations where conversation_id = ${`conversation-${kind}`}`;
				await client`update platform.conversations set channel_id = ${`api:${kind}`} where id = ${`conversation-${kind}`}`;
				await seedSessionSandboxFixture(client, `conversation-${kind}`);
			}
			for (const kind of ["user", "application"] as const) {
				const foreign = `conversation-${kind === "user" ? "application" : "user"}`;
				for (const conversationId of [foreign, "missing-conversation"]) {
					expect(
						await tx.authorizeTaskApi({
							material: material[kind],
							operation,
							conversationId,
						}),
					).toBeNull();
				}
				await client`update platform.platform_api_credentials set revoked_at = now() where id = ${`credential-${kind}`}`;
				for (const token of [material[kind], material.replacement]) {
					for (const conversationId of [
						`conversation-${kind}`,
						foreign,
						"missing-conversation",
					]) {
						expect(
							await tx.authorizeTaskApi({
								material: token,
								operation,
								conversationId,
							}),
						).toBeNull();
					}
				}
			}
		},
	);
	it("conceals authority lost during the final directory recheck like a missing Conversation", async () => {
		let reads = 0;
		const tx = store({
			resolveUser: async () => (++reads === 1 ? user : null),
		});
		expect(
			await tx.authorizeTaskApi({
				material: material.user,
				operation: "agent:read",
				conversationId: "conversation-user",
			}),
		).toBeNull();
		expect(
			await tx.authorizeTaskApi({
				material: material.user,
				operation: "agent:read",
				conversationId: "missing-conversation",
			}),
		).toBeNull();
	});
	it.each(["user", "application"] as const)(
		"binds %s to its C and refuses opposite kind with the same ID",
		async (kind) => {
			const tx = store();
			const allowed = await tx.authorizeTaskApi({
				material: material[kind],
				operation: "agent:read",
				conversationId: `conversation-${kind}`,
			});
			expect(allowed?.taskBoundary).toMatchObject({
				principal: { kind, id: "same-id" },
				channelId: "api",
				accessSources: [{ kind: "api-use", useGrantRevision: `use-${kind}` }],
			});
			expect(allowed?.personalApiAdmissionAuthority?.operation).toBe(
				"agent:read",
			);
			expect(JSON.stringify(allowed)).not.toContain(material[kind]);
			expect(
				await tx.authorizeTaskApi({
					material: material[kind],
					operation: "agent:read",
					conversationId: `conversation-${kind === "user" ? "application" : "user"}`,
				}),
			).toBeNull();
			expect(
				await tx.authorizeTaskApi({
					material: material[kind],
					operation: "agent:use",
					agentId: "other-agent",
					conversationId: `conversation-${kind}`,
				}),
			).toBeNull();
		},
	);
	it("application skips same-ID user disable/directory and preserves used credential access semantics", async () => {
		await client`insert into platform.platform_user_disables(user_id) values('same-id')`;
		const tx = store({
			async resolveUser() {
				throw new Error("Application must not call directory");
			},
		});
		expect(
			await tx.authorizeTaskApi({
				material: material.application,
				operation: "agent:use",
				agentId: "agent",
			}),
		).toMatchObject({
			actorId: "same-id",
			taskBoundary: { principal: { kind: "application" } },
		});
		await client`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values('replacement','application','same-id',${createHash("sha256").update(material.replacement).digest("hex")},${client.json(["agent:read", "agent:use"])})`;
		await client`update platform.platform_api_credentials set revoked_at=now() where id='credential-application'`;
		await expect(
			tx.authorizeTaskApi({
				material: material.application,
				operation: "agent:use",
				conversationId: "conversation-application",
			}),
		).resolves.toBeNull();
		expect(
			await tx.authorizeTaskApi({
				material: material.replacement,
				operation: "agent:read",
				conversationId: "conversation-application",
			}),
		).toMatchObject({
			personalApiAdmissionAuthority: { credentialId: "replacement" },
		});
		expect(
			await client`select id from platform.task_control_records`,
		).toHaveLength(0);
		expect(
			await client`select id from platform.conversations where id='conversation-application'`,
		).toHaveLength(1);
	});
	it("cannot elevate agent:read credential to submit/cancel use or use Owner as a grant", async () => {
		const tx = store();
		await client`update platform.platform_api_credentials set scopes=${client.json(["agent:read"])} where id='credential-user'`;
		expect(
			await tx.authorizeTaskApi({
				material: material.user,
				operation: "agent:read",
				conversationId: "conversation-user",
			}),
		).not.toBeNull();
		await expect(
			tx.authorizeTaskApi({
				material: material.user,
				operation: "agent:use",
				conversationId: "conversation-user",
			}),
		).resolves.toBeNull();
		await client`insert into platform.agent_owners(agent_id,owner_id,created_at) values('agent','same-id',now())`;
		await client`delete from platform.agent_principal_grants where principal_type='user'`;
		await expect(
			tx.authorizeTaskApi({
				material: material.user,
				operation: "agent:read",
				conversationId: "conversation-user",
			}),
		).resolves.toBeNull();
	});
	it("samples fresh DB clock after the final directory await rather than returning expired authority", async () => {
		let reads = 0;
		const tx = store({
			async resolveUser() {
				reads += 1;
				if (reads === 2) {
					// Wait against the actual stored expiry, rather than depending on a 150ms entry race.
					await client`select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp()))) + 0.05) from platform.platform_api_credentials where id='credential-user'`;
				}
				return user;
			},
		});
		await client`update platform.platform_api_credentials set expires_at=clock_timestamp()+interval '5 seconds' where id='credential-user'`;
		await expect(
			tx.authorizeTaskApi({
				material: material.user,
				operation: "agent:use",
				agentId: "agent",
			}),
		).rejects.toMatchObject({ code: "authentication_required" });
		expect(reads).toBe(2);
	}, 10_000);
	it("preserves legacy typed API channel and refuses missing current user directory", async () => {
		await client`delete from platform.session_sandbox_allocations where conversation_id = ${"conversation-application"}`;
		await client`update platform.conversations set channel_id='api:application' where id='conversation-application'`;
		await seedSessionSandboxFixture(client, "conversation-application");
		expect(
			await store().authorizeTaskApi({
				material: material.application,
				operation: "agent:read",
				conversationId: "conversation-application",
			}),
		).toMatchObject({ channelId: "api:application" });
		const unavailable = new PostgresConversationExecutionTransactionV1({
			databaseUrl: database.databaseUrl,
		});
		stores.push(unavailable);
		await expect(
			unavailable.authorizeTaskApi({
				material: material.user,
				operation: "agent:read",
				conversationId: "conversation-user",
			}),
		).resolves.toBeNull();
	});
});
