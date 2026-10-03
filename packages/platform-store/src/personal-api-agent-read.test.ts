import { createHash } from "node:crypto";
import {
	type CurrentTaskUserV1,
	createPersonalApiAgentReadUseCaseV1,
	createPersonalApiCredentialUseCaseV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentConfigurationQueryV1 } from "./agent-configuration.query.ts";
import { PostgresAgentManagementQueryV1 } from "./agent-management.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import { PostgresPersonalApiCredentialStoreV1 } from "./personal-api-credentials.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const userId = "user_alice";
const metadata = { requestId: "request_read", traceId: "trace_read" };
const currentUser = (id: string): CurrentTaskUserV1 => ({
	schemaVersion: 1,
	userId: id,
	accountStatus: "active",
	organizationIds: ["org_1"],
	authorizationRevision: "identity_1",
});
let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let query: PostgresAgentManagementQueryV1;
let configuration: PostgresAgentConfigurationQueryV1;
let adapter: PostgresPersonalApiCredentialStoreV1;
let resolveUser: TaskUserDirectoryV1["resolveUser"];
const additionalAdapters: PostgresPersonalApiCredentialStoreV1[] = [];

function governance(store = adapter) {
	return createPersonalApiCredentialUseCaseV1({
		transaction: store,
		userDirectory: { resolveUser: (id) => resolveUser(id) },
	});
}
function reader() {
	return createPersonalApiAgentReadUseCaseV1({
		transaction: adapter,
		userDirectory: { resolveUser: (id) => resolveUser(id) },
	});
}
async function issue(key = "issue.1", scopes = ["agent:read"]) {
	const issued = await governance().issue(
		{ ...metadata, userId, idempotencyKey: key },
		{ scopes, expiresAt: null },
	);
	if (issued.credential === null) throw new Error("Missing initial material");
	return { ...issued, credential: issued.credential };
}
async function readGranted(user: CurrentTaskUserV1, limit = 100) {
	const page = await query.listAgents(
		{ kind: "api_user", userId: user.userId },
		{ limit },
	);
	for (const item of page.items) {
		expect(
			await configuration.read({
				agentId: item.agentId,
				actorId: user.userId,
				organizationIds: user.organizationIds,
				isAdministrator: false,
				intent: "api_metadata",
			}),
		).toMatchObject({ outcome: "found" });
	}
	return { result: page, returnedAgentIds: page.items.map((a) => a.agentId) };
}
async function read(material: string) {
	return reader().readAgents(metadata, material, readGranted);
}
async function grant(agentId: string, kind: "manage" | "use", id = userId) {
	await client`insert into platform.agent_principal_grants
		(agent_id,principal_type,principal_id,grant_type,authorization_revision)
		values (${agentId},'user',${id},${kind},'grant_1')`;
}
async function seedAgent(agentId: string) {
	const record = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId,
	};
	await client`insert into platform.agents(id,current_configuration_revision)
		values (${agentId},${record.revision})`;
	await client`insert into platform.agent_applications
		(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,
		management_revision,approval_revision,service_availability,desired_state,workload_revision,fence)
		values (${`application_${agentId}`},${agentId},${userId},'Agent','Description',
		'available','trace_seed','request_seed',clock_timestamp(),1,1,'ready','running',1,1)`;
	await client`insert into platform.agent_configuration_revisions
		(agent_id,revision,source_reference,configuration,created_at)
		values (${agentId},${record.revision},${record.source.kind === "standard" ? record.source.templateId : record.source.imageDigest},${client.json(record as never)},clock_timestamp())`;
	await client`insert into platform.agent_owners(agent_id,owner_id,created_at) values (${agentId},${userId},clock_timestamp())`;
	await client`insert into platform.agent_availability(agent_id,target_type,target_id)
		values (${agentId},'organization','org_1')`;
}
async function auditFailure(deferred: boolean) {
	await client`create function platform.fail_api_read_audit() returns trigger language plpgsql as $$
		begin raise exception 'SECRET_SQL_SENTINEL'; end $$`;
	await client.unsafe(
		deferred
			? "create constraint trigger fail_api_read_audit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.fail_api_read_audit()"
			: "create trigger fail_api_read_audit before insert on platform.audit_events for each row execute function platform.fail_api_read_audit()",
	);
}
async function waitForLock(pid: number) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const [activity] =
			await client`select wait_event_type from pg_stat_activity where pid=${pid}`;
		if (activity?.wait_event_type === "Lock") return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Expected concurrent PostgreSQL writer to wait for a lock");
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("personal-api-agent-read");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
	query = new PostgresAgentManagementQueryV1({
		databaseUrl: database.databaseUrl,
	});
	configuration = new PostgresAgentConfigurationQueryV1({
		databaseUrl: database.databaseUrl,
	});
	adapter = new PostgresPersonalApiCredentialStoreV1({
		databaseUrl: database.databaseUrl,
	});
});
beforeEach(async () => {
	resolveUser = async (id) => currentUser(id);
	await client`truncate platform.platform_api_credentials,platform.platform_user_disables,
		platform.idempotency_records,platform.audit_events,platform.agents cascade`;
	await seedAgent("agent_1");
});
afterEach(async () => {
	await client`drop trigger if exists fail_api_read_audit on platform.audit_events`;
	await client`drop function if exists platform.fail_api_read_audit()`;
	await Promise.all(additionalAdapters.splice(0).map((store) => store.close()));
	vi.restoreAllMocks();
});
afterAll(async () => {
	await Promise.all([
		adapter?.close(),
		query?.close(),
		configuration?.close(),
		client?.end(),
	]);
	await database?.stop();
});

describe("PostgreSQL exact personal Bearer Agent read", () => {
	it("uses the issued material, durably audits the read, and rejects that same material after revocation", async () => {
		await grant("agent_1", "use");
		const first = await issue();
		const digest = createHash("sha256").update(first.credential).digest("hex");
		expect((await read(first.credential)).items.map((a) => a.agentId)).toEqual([
			"agent_1",
		]);
		const [persisted] =
			await client`select credential_hash,last_used_at from platform.platform_api_credentials`;
		expect(persisted?.credential_hash).toBe(digest);
		expect(persisted?.last_used_at).toBeInstanceOf(Date);
		await issue("other.valid");
		await governance().revoke(
			{ ...metadata, userId, idempotencyKey: "revoke.1" },
			first.metadata.credentialId,
		);
		await expect(read(first.credential)).rejects.toMatchObject({
			code: "authentication_required",
		});
		const audits =
			await client`select actor_type,actor_id,target_id,request_id,trace_id,outcome,details
			from platform.audit_events where action='api.agent.metadata.read' order by occurred_at`;
		expect(audits).toMatchObject([
			{
				actor_type: "user",
				actor_id: userId,
				target_id: first.metadata.credentialId,
				request_id: metadata.requestId,
				trace_id: metadata.traceId,
				outcome: "succeeded",
				details: {
					returnedAgentIds: ["agent_1"],
					grantFilter: "manage_or_use",
				},
			},
			{
				actor_id: userId,
				target_id: first.metadata.credentialId,
				outcome: "rejected",
				details: { reason: "authentication_required" },
			},
		]);
		const durable =
			await client`select result from platform.idempotency_records`;
		const safe = JSON.stringify({ audits, durable });
		expect(safe).not.toContain(first.credential);
		expect(safe).not.toContain(digest);
		const [outbox] =
			await client`select count(*)::int as count from platform.outbox_items`;
		expect(outbox?.count).toBe(0);
	});

	it.each(
		(
			[[], ["manage"], ["use"], ["manage", "use"]] as ("manage" | "use")[][]
		).map((grants) => ({ grants })),
	)(
		"intersects actual grants %j and keeps browser Owner/discover semantics",
		async ({ grants }) => {
			for (const kind of grants) await grant("agent_1", kind);
			const first = await issue();
			const page = await read(first.credential);
			expect(page.items.map((a) => a.agentId)).toEqual(
				grants.length ? ["agent_1"] : [],
			);
			expect(page.nextAfterId).toBeNull();
			for (const isAdministrator of [false, true]) {
				expect(
					await configuration.read({
						agentId: "agent_1",
						actorId: userId,
						organizationIds: ["org_1"],
						isAdministrator,
						intent: "api_metadata",
					}),
				).toMatchObject({ outcome: grants.length ? "found" : "unavailable" });
			}
			for (const scope of [
				{ kind: "owner", ownerId: userId },
				{ kind: "user", userId, organizationIds: ["org_1"] },
				{ kind: "administrator" },
			] as const) {
				expect(
					(await query.listAgents(scope, { limit: 50 })).items,
				).toHaveLength(1);
			}
		},
	);

	it.each(["manage", "use"] as const)(
		"independently revokes %s and excludes the Agent only after both are revoked",
		async (firstKind) => {
			await grant("agent_1", "manage");
			await grant("agent_1", "use");
			const first = await issue();
			await client`update platform.agent_principal_grants set revoked_at=clock_timestamp()
			where agent_id='agent_1' and grant_type=${firstKind}`;
			expect((await read(first.credential)).items).toHaveLength(1);
			await client`update platform.agent_principal_grants set revoked_at=clock_timestamp() where agent_id='agent_1'`;
			expect((await read(first.credential)).items).toEqual([]);
			const [filtered] =
				await client`select details from platform.audit_events where action='api.agent.metadata.read' order by occurred_at desc limit 1`;
			expect(filtered?.details).toEqual({
				returnedAgentIds: [],
				grantFilter: "manage_or_use",
			});
		},
	);

	it("filters before pagination and never adopts another user's grants", async () => {
		await seedAgent("agent_2");
		await seedAgent("agent_3");
		await grant("agent_1", "use", "user_bob");
		await grant("agent_2", "manage");
		await grant("agent_3", "use");
		const first = await issue();
		const page = await reader().readAgents(metadata, first.credential, (user) =>
			readGranted(user, 1),
		);
		expect(page.items.map((a) => a.agentId)).toEqual(["agent_2"]);
		expect(page.nextAfterId).toBe("agent_2");
		const next = await query.listAgents(
			{ kind: "api_user", userId },
			{ limit: 1, afterId: page.nextAfterId ?? undefined },
		);
		expect(next.items.map((a) => a.agentId)).toEqual(["agent_3"]);
		expect(next.nextAfterId).toBeNull();
	});

	it.each([
		"expiry",
		"scope",
		"duplicate_hash",
		"application",
		"malformed_scopes",
	])(
		"rejects actual persisted %s without falling back to another credential",
		async (mode) => {
			const first = await issue();
			await issue("another.valid");
			if (mode === "expiry")
				await client`update platform.platform_api_credentials set expires_at=clock_timestamp() where id=${first.metadata.credentialId}`;
			if (mode === "scope")
				await client`update platform.platform_api_credentials set scopes='["agent:use"]'::jsonb where id=${first.metadata.credentialId}`;
			if (mode === "application")
				await client`update platform.platform_api_credentials set principal_type='application' where id=${first.metadata.credentialId}`;
			if (mode === "malformed_scopes")
				await client`update platform.platform_api_credentials set scopes='[]'::jsonb where id=${first.metadata.credentialId}`;
			if (mode === "duplicate_hash")
				await client`update platform.platform_api_credentials set credential_hash=(select credential_hash from platform.platform_api_credentials where id=${first.metadata.credentialId})`;
			const code =
				mode === "scope"
					? "forbidden"
					: ["duplicate_hash", "malformed_scopes"].includes(mode)
						? "unavailable"
						: "authentication_required";
			await expect(read(first.credential)).rejects.toMatchObject({ code });
			const [used] =
				await client`select count(*)::int as count from platform.platform_api_credentials where last_used_at is not null`;
			expect(used?.count).toBe(0);
		},
	);

	it("gives Platform disable priority over unavailable identity, and resolves only the used principal", async () => {
		const first = await issue();
		await client`insert into platform.platform_user_disables(user_id) values (${userId})`;
		const dependency = vi.fn(async () => {
			throw new Error("IDENTITY_SECRET_SENTINEL");
		});
		resolveUser = dependency;
		await expect(read(first.credential)).rejects.toMatchObject({
			code: "forbidden",
		});
		expect(dependency).not.toHaveBeenCalled();
	});

	it.each([
		"disabled",
		"missing",
		"mismatched",
		"malformed",
		"error",
		"revision",
	])(
		"fails closed on %s current identity facts and rolls back success audit/last-used",
		async (mode) => {
			await grant("agent_1", "use");
			const first = await issue();
			let reads = 0;
			resolveUser = async (id) => {
				expect(id).toBe(userId);
				reads++;
				if (mode === "error") throw new Error("IDENTITY_SECRET_SENTINEL");
				if (mode === "missing") return null;
				return {
					...currentUser(id),
					...(mode === "disabled"
						? { accountStatus: "disabled" }
						: mode === "mismatched"
							? { userId: "user_bob" }
							: mode === "malformed"
								? { schemaVersion: 2 }
								: mode === "revision" && reads === 2
									? { authorizationRevision: "identity_2" }
									: {}),
				};
			};
			await expect(read(first.credential)).rejects.toMatchObject({
				code: ["disabled", "missing"].includes(mode)
					? "forbidden"
					: "unavailable",
			});
			const [row] =
				await client`select last_used_at from platform.platform_api_credentials`;
			expect(row?.last_used_at).toBeNull();
			const audits =
				await client`select outcome,details from platform.audit_events where action='api.agent.metadata.read'`;
			expect(audits).toHaveLength(1);
			expect(audits[0]?.outcome).not.toBe("succeeded");
			expect(JSON.stringify(audits)).not.toContain("IDENTITY_SECRET_SENTINEL");
		},
	);

	it.each([false, true])(
		"withholds a lawful read on audit/commit failure and preserves refusal (deferred=%s)",
		async (deferred) => {
			await grant("agent_1", "use");
			const first = await issue();
			const signal = vi.spyOn(console, "error").mockImplementation(() => {});
			await auditFailure(deferred);
			await expect(read(first.credential)).rejects.toMatchObject({
				code: "unavailable",
			});
			await expect(read(`papi_${"x".repeat(43)}`)).rejects.toMatchObject({
				code: "authentication_required",
			});
			const [row] =
				await client`select last_used_at from platform.platform_api_credentials`;
			expect(row?.last_used_at).toBeNull();
			const [audits] =
				await client`select count(*)::int as count from platform.audit_events where action='api.agent.metadata.read'`;
			expect(audits?.count).toBe(0);
			expect(signal).toHaveBeenCalled();
			expect(JSON.stringify(signal.mock.calls)).not.toContain(first.credential);
			expect(JSON.stringify(signal.mock.calls)).not.toContain(
				"SECRET_SQL_SENTINEL",
			);
		},
	);

	it("rechecks database expiry after the final external identity read", async () => {
		const first = await issue();
		await client`update platform.platform_api_credentials set expires_at=clock_timestamp()+interval '1 second' where id=${first.metadata.credentialId}`;
		let reads = 0;
		resolveUser = async (id) => {
			if (++reads === 2) {
				for (;;) {
					const [row] =
						await client`select clock_timestamp()>=expires_at as expired from platform.platform_api_credentials where id=${first.metadata.credentialId}`;
					if (row?.expired) break;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
			return currentUser(id);
		};
		await expect(read(first.credential)).rejects.toMatchObject({
			code: "authentication_required",
		});
		expect(reads).toBe(2);
		const [row] =
			await client`select last_used_at from platform.platform_api_credentials`;
		expect(row?.last_used_at).toBeNull();
	});

	it.each([
		"grant_insert",
		"grant_revoke",
		"credential_revoke",
		"disable_insert",
	])(
		"orders concurrent %s after the in-progress exact credential read",
		async (write) => {
			const first = await issue();
			if (write !== "grant_insert") await grant("agent_1", "use");
			let entered = () => {};
			let release = () => {};
			const ready = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const pause = new Promise<void>((resolve) => {
				release = resolve;
			});
			const pendingRead = reader().readAgents(
				metadata,
				first.credential,
				async (user) => {
					entered();
					await pause;
					return readGranted(user);
				},
			);
			await ready;
			const writer = postgres(database.databaseUrl, { max: 1 });
			const [backend] = await writer`select pg_backend_pid() as pid`;
			let pendingWrite: Promise<unknown>;
			if (write === "grant_insert")
				pendingWrite = Promise.resolve(
					writer`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision) values ('agent_1','user',${userId},'use','grant_2')`,
				);
			else if (write === "grant_revoke")
				pendingWrite = Promise.resolve(
					writer`update platform.agent_principal_grants set revoked_at=clock_timestamp() where agent_id='agent_1'`,
				);
			else if (write === "disable_insert")
				pendingWrite = Promise.resolve(
					writer`insert into platform.platform_user_disables(user_id) values (${userId})`,
				);
			else {
				const separate = new PostgresPersonalApiCredentialStoreV1({
					databaseUrl: database.databaseUrl,
				});
				additionalAdapters.push(separate);
				pendingWrite = governance(separate).revoke(
					{ ...metadata, userId, idempotencyKey: "concurrent.revoke" },
					first.metadata.credentialId,
				);
			}
			try {
				if (write === "credential_revoke") {
					for (let attempt = 0; attempt < 100; attempt++) {
						const [blocked] =
							await client`select count(*)::int as count from pg_stat_activity where wait_event_type='Lock' and query ilike '%platform_api_credentials%'`;
						if (blocked?.count > 0) break;
						if (attempt === 99)
							throw new Error("Expected credential revocation to block");
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
				} else await waitForLock(backend?.pid);
			} finally {
				release();
			}
			try {
				expect((await pendingRead).items).toHaveLength(
					write === "grant_insert" ? 0 : 1,
				);
				await pendingWrite;
				if (write === "credential_revoke" || write === "disable_insert") {
					await expect(read(first.credential)).rejects.toMatchObject({
						code:
							write === "credential_revoke"
								? "authentication_required"
								: "forbidden",
					});
				} else
					expect((await read(first.credential)).items).toHaveLength(
						write === "grant_insert" ? 1 : 0,
					);
			} finally {
				await writer.end();
			}
		},
	);
});
