import { createHash } from "node:crypto";
import {
	createPersonalApiCredentialUseCaseV1,
	type PersonalApiCredentialRequestV1,
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
import { migratePlatformDatabase } from "./migrate.ts";
import { PostgresPersonalApiCredentialStoreV1 } from "./personal-api-credentials.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const context: PersonalApiCredentialRequestV1 = {
	userId: "user_alice",
	idempotencyKey: "issue.1",
	requestId: "request_1",
	traceId: "trace_1",
};
const command = { scopes: ["agent:read", "agent:use"], expiresAt: null };
const currentUser = (userId: string) => ({
	schemaVersion: 1,
	userId,
	accountStatus: "active",
	organizationIds: ["org_1"],
	authorizationRevision: "revision_1",
});
let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let resolveUser: TaskUserDirectoryV1["resolveUser"];
const stores: PostgresPersonalApiCredentialStoreV1[] = [];
function store(databaseUrl = database.databaseUrl) {
	const adapter = new PostgresPersonalApiCredentialStoreV1({
		databaseUrl,
	});
	stores.push(adapter);
	return {
		...createPersonalApiCredentialUseCaseV1({
			transaction: adapter,
			userDirectory: { resolveUser: (id) => resolveUser(id) },
		}),
		close: () => adapter.close(),
	};
}
const nextContext = (idempotencyKey: string, userId = context.userId) => ({
	...context,
	userId,
	idempotencyKey,
	requestId: `request_${idempotencyKey}`,
});
async function counts() {
	const [row] = await client`
		select (select count(*)::int from platform.platform_api_credentials) as credentials,
		(select count(*)::int from platform.idempotency_records) as idempotency,
		(select count(*)::int from platform.audit_events where outcome='succeeded') as succeeded`;
	return row;
}
async function armAuditFailure(deferred = false) {
	await client`create function platform.fail_personal_credential_audit() returns trigger language plpgsql as $$
		begin raise exception 'SECRET_SQL_SENTINEL'; end $$`;
	await client.unsafe(
		deferred
			? "create constraint trigger fail_personal_credential_audit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.fail_personal_credential_audit()"
			: "create trigger fail_personal_credential_audit before insert on platform.audit_events for each row execute function platform.fail_personal_credential_audit()",
	);
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("personal-api-credentials");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
});
beforeEach(async () => {
	resolveUser = async (id) => currentUser(id);
	await client`truncate platform.platform_api_credentials, platform.idempotency_records,
		platform.audit_events, platform.platform_user_disables`;
});
afterEach(async () => {
	await Promise.all(stores.splice(0).map((adapter) => adapter.close()));
	await client`drop trigger if exists fail_personal_credential_audit on platform.audit_events`;
	await client`drop function if exists platform.fail_personal_credential_audit()`;
	vi.restoreAllMocks();
});
afterAll(async () => {
	await client?.end();
	await database?.stop();
});

describe("PostgreSQL personal API credential governance", () => {
	it("lists metadata when PostgreSQL denies reading credential hashes", async () => {
		const issued = await store().issue(context, command);
		await client`create role personal_credential_metadata_reader login password 'fixture-reader'`;
		await client`grant usage on schema platform to personal_credential_metadata_reader`;
		await client`grant select (id, principal_type, principal_id, scopes, expires_at,
			revoked_at, created_at, last_used_at), update (id)
			on platform.platform_api_credentials to personal_credential_metadata_reader`;
		await client`grant select, update on platform.platform_user_disables to personal_credential_metadata_reader`;
		await client`grant insert on platform.audit_events to personal_credential_metadata_reader`;
		const url = new URL(database.databaseUrl);
		url.username = "personal_credential_metadata_reader";
		url.password = "fixture-reader";
		const reader = postgres(url.toString(), { max: 1 });
		const adapter = store(url.toString());
		try {
			await expect(
				reader`select credential_hash from platform.platform_api_credentials`,
			).rejects.toMatchObject({ code: "42501" });
			const page = await adapter.list(
				{
					userId: context.userId,
					requestId: "list.no-hash",
					traceId: "trace.no-hash",
				},
				{ limit: 2 },
			);
			expect(page.items).toEqual([issued.metadata]);
			const [audit] =
				await client`select count(*)::int as count from platform.audit_events
				where action='api.credential.metadata.read' and request_id='list.no-hash' and outcome='succeeded'`;
			expect(audit?.count).toBe(1);
		} finally {
			await reader.end();
			await adapter.close();
			await client`drop owned by personal_credential_metadata_reader`;
			await client`drop role personal_credential_metadata_reader`;
		}
	});

	it("pages only personal metadata, binds cursors, and persists necessary read audit", async () => {
		const adapter = store();
		const issued = await Promise.all(
			["page.1", "page.2", "page.3"].map((key) =>
				adapter.issue(nextContext(key), command),
			),
		);
		const foreign = await adapter.issue(
			nextContext("foreign", "user_bob"),
			command,
		);
		const readContext = {
			userId: context.userId,
			requestId: "read.page",
			traceId: "trace.page",
		};
		const first = await adapter.list(readContext, { limit: 2 });
		const second = await adapter.list(readContext, {
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(first.items).toHaveLength(2);
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		expect(
			[...first.items, ...second.items].map((item) => item.credentialId),
		).toEqual(issued.map((item) => item.metadata.credentialId).sort());
		for (const result of [...issued, foreign])
			expect(JSON.stringify([first, second])).not.toContain(result.credential);
		await expect(
			adapter.list(
				{ ...readContext, userId: "user_bob" },
				{ limit: 2, cursor: first.nextCursor },
			),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			adapter.list(readContext, { limit: 1, cursor: first.nextCursor }),
		).rejects.toMatchObject({ code: "invalid_input" });
		const reads =
			await client`select * from platform.audit_events where action='api.credential.metadata.read' and outcome='succeeded'`;
		expect(reads).toHaveLength(2);
		expect(reads.every((row) => row.actor_id === context.userId)).toBe(true);
		await adapter.close();
		expect((await store().list(readContext, { limit: 100 })).items).toEqual([
			...first.items,
			...second.items,
		]);
	});
	it.each([false, true])(
		"withholds metadata when required audit or commit fails (deferred=%s)",
		async (deferred) => {
			const adapter = store();
			const issued = await adapter.issue(context, command);
			await armAuditFailure(deferred);
			await expect(
				adapter.list(
					{
						userId: context.userId,
						requestId: "list.fault",
						traceId: context.traceId,
					},
					{},
				),
			).rejects.toMatchObject({ code: "unavailable" });
			const [row] =
				await client`select credential_hash, scopes from platform.platform_api_credentials where id=${issued.metadata.credentialId}`;
			expect(row?.credential_hash).toBe(
				createHash("sha256")
					.update(issued.credential ?? "")
					.digest("hex"),
			);
			expect(row?.scopes).toEqual(issued.metadata.scopes);
			const [audits] =
				await client`select count(*)::int as count from platform.audit_events where action='api.credential.metadata.read' and outcome='succeeded'`;
			expect(audits?.count).toBe(0);
		},
	);

	it("commits matching hash-only material once, survives restart, and never revives a revocation", async () => {
		const firstStore = store();
		const first = await firstStore.issue(context, command);
		expect(first.replayed).toBe(false);
		expect(first.credential).toMatch(/^papi_[A-Za-z0-9_-]{43}$/);
		const [persisted] =
			await client`select * from platform.platform_api_credentials`;
		const digest = createHash("sha256")
			.update(first.credential ?? "")
			.digest("hex");
		expect(persisted?.credential_hash).toBe(digest);
		expect(persisted?.id).toBe(first.metadata.credentialId);
		expect(persisted?.principal_id).toBe(context.userId);
		expect(JSON.stringify(first.metadata)).not.toContain(digest);
		expect(JSON.stringify(persisted)).not.toContain(first.credential);
		await firstStore.close();
		const restarted = store();
		const replay = await restarted.issue(context, command);
		expect(replay).toEqual({
			metadata: first.metadata,
			credential: null,
			replayed: true,
		});
		const revoked = await restarted.revoke(
			nextContext("revoke.1"),
			replay.metadata.credentialId,
		);
		expect(revoked.metadata.revokedAt).not.toBeNull();
		expect(await restarted.issue(context, command)).toEqual({
			metadata: revoked.metadata,
			credential: null,
			replayed: true,
		});
		expect(
			await restarted.revoke(
				nextContext("revoke.1"),
				replay.metadata.credentialId,
			),
		).toEqual({ metadata: revoked.metadata, replayed: true });
		const replacement = await restarted.issue(nextContext("issue.2"), command);
		expect(replacement.metadata.credentialId).not.toBe(
			first.metadata.credentialId,
		);
		expect(replacement.credential).not.toBe(first.credential);
		expect(await counts()).toEqual({
			credentials: 2,
			idempotency: 3,
			succeeded: 3,
		});
		const durable =
			await client`select result from platform.idempotency_records`;
		for (const row of durable)
			expect(Object.keys(row.result)).toEqual(["credentialId"]);
		const audits = await client`select * from platform.audit_events`;
		const serialized = JSON.stringify({ durable, audits });
		expect(serialized).not.toContain(first.credential);
		expect(serialized).not.toContain(digest);
		const [outbox] =
			await client`select count(*)::int as count from platform.outbox_items`;
		expect(outbox?.count).toBe(0);
	});

	it("serializes concurrent same-key requests across separate service instances", async () => {
		const instances = [store(), store(), store(), store()];
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, index) => {
				const adapter = instances[index % instances.length];
				if (!adapter) throw new Error("Missing test adapter");
				return adapter.issue(context, {
					...command,
					scopes: index % 2 ? ["agent:use", "agent:read"] : command.scopes,
				});
			}),
		);
		expect(results.filter((result) => result.credential !== null)).toHaveLength(
			1,
		);
		expect(results.filter((result) => result.replayed)).toHaveLength(7);
		expect(
			new Set(results.map((result) => result.metadata.credentialId)).size,
		).toBe(1);
		expect(await counts()).toEqual({
			credentials: 1,
			idempotency: 1,
			succeeded: 1,
		});
		await store().issue(
			nextContext(context.idempotencyKey, "user_bob"),
			command,
		);
		expect(await counts()).toEqual({
			credentials: 2,
			idempotency: 2,
			succeeded: 2,
		});
	});

	it("rejects issue and revoke key conflicts without changing the original credential", async () => {
		const adapter = store();
		const first = await adapter.issue(context, command);
		await expect(
			adapter.issue(context, { ...command, scopes: ["agent:read"] }),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		await expect(
			adapter.issue(context, { ...command, expiresAt: "2030-01-01T00:00:00Z" }),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		const second = await adapter.issue(nextContext("issue.2"), command);
		await adapter.revoke(nextContext("revoke.1"), first.metadata.credentialId);
		await expect(
			adapter.revoke(nextContext("revoke.1"), second.metadata.credentialId),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		const [row] =
			await client`select revoked_at from platform.platform_api_credentials where id=${second.metadata.credentialId}`;
		expect(row?.revoked_at).toBeNull();
		expect(await counts()).toEqual({
			credentials: 2,
			idempotency: 3,
			succeeded: 3,
		});
	});

	it("makes cross-person and missing revocations indistinguishable, with unknown audit targets", async () => {
		const adapter = store();
		const first = await adapter.issue(context, command);
		const other = nextContext("other.revoke", "user_bob");
		await expect(
			adapter.revoke(other, first.metadata.credentialId),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			adapter.revoke(
				{ ...other, idempotencyKey: "missing.revoke" },
				"CLAIMED_TARGET_SENTINEL",
			),
		).rejects.toMatchObject({ code: "not_found" });
		const denied =
			await client`select actor_type,actor_id,target_id,details from platform.audit_events where outcome='rejected'`;
		expect(denied).toHaveLength(2);
		for (const row of denied)
			expect(row).toEqual({
				actor_type: "user",
				actor_id: "user_bob",
				target_id: "unknown",
				details: { reason: "not_found" },
			});
		expect(JSON.stringify(denied)).not.toContain("CLAIMED_TARGET_SENTINEL");
		expect(await counts()).toEqual({
			credentials: 1,
			idempotency: 1,
			succeeded: 1,
		});
	});

	it.each(["disabled", "missing", "mismatched", "malformed", "error"])(
		"rejects %s current directory facts with sanitized durable reasons",
		async (mode) => {
			resolveUser = async (id) => {
				if (mode === "missing") return null;
				if (mode === "error") throw new Error("SECRET_IDENTITY_SENTINEL");
				return {
					...currentUser(id),
					...(mode === "disabled"
						? { accountStatus: "disabled" }
						: mode === "mismatched"
							? { userId: "untrusted_user" }
							: { schemaVersion: 2 }),
				};
			};
			const code = ["disabled", "missing"].includes(mode)
				? "forbidden"
				: "unavailable";
			await expect(store().issue(context, command)).rejects.toMatchObject({
				code,
				message: "Personal API credential operation failed",
			});
			expect(await counts()).toEqual({
				credentials: 0,
				idempotency: 0,
				succeeded: 0,
			});
			const [audit] = await client`select * from platform.audit_events`;
			expect(audit?.details).toEqual({ reason: code });
			expect(audit?.actor_type).toBe("user");
			expect(audit?.actor_id).toBe(context.userId);
			expect(JSON.stringify(audit)).not.toContain("SECRET_IDENTITY_SENTINEL");
			expect(JSON.stringify(audit)).not.toContain("untrusted_user");
		},
	);

	it("gives a committed Platform disable priority over an unavailable identity dependency", async () => {
		const adapter = store();
		const first = await adapter.issue(context, command);
		await client`insert into platform.platform_user_disables(user_id) values (${context.userId})`;
		const dependency = vi.fn(async () => {
			throw new Error("SECRET_IDENTITY_SENTINEL");
		});
		resolveUser = dependency;
		await expect(
			adapter.issue(nextContext("disabled.issue"), command),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			adapter.revoke(
				nextContext("disabled.revoke"),
				first.metadata.credentialId,
			),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(dependency).not.toHaveBeenCalled();
		const refused =
			await client`select actor_type,actor_id,target_id from platform.audit_events where outcome='rejected'`;
		expect(refused).toHaveLength(2);
		for (const audit of refused)
			expect(audit).toEqual({
				actor_type: "user",
				actor_id: context.userId,
				target_id: "unknown",
			});
		const [row] =
			await client`select revoked_at from platform.platform_api_credentials`;
		expect(row?.revoked_at).toBeNull();
	});

	it.each([false, true])(
		"rolls issuance and revocation back on audit failure (deferred=%s)",
		async (deferred) => {
			const adapter = store();
			const first = await adapter.issue(context, command);
			const signal = vi.spyOn(console, "error").mockImplementation(() => {});
			await armAuditFailure(deferred);
			await expect(
				adapter.issue(nextContext("failed.issue"), command),
			).rejects.toMatchObject({ code: "unavailable" });
			await expect(
				adapter.revoke(
					nextContext("failed.revoke"),
					first.metadata.credentialId,
				),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(await counts()).toEqual({
				credentials: 1,
				idempotency: 1,
				succeeded: 1,
			});
			const [row] =
				await client`select revoked_at from platform.platform_api_credentials`;
			expect(row?.revoked_at).toBeNull();
			expect(signal).toHaveBeenCalledWith(
				"personal_api_credential_audit_unavailable",
				expect.objectContaining({ traceId: context.traceId }),
			);
			expect(JSON.stringify(signal.mock.calls)).not.toContain(
				"SECRET_SQL_SENTINEL",
			);
			expect(JSON.stringify(signal.mock.calls)).not.toContain(first.credential);
			await expect(
				adapter.revoke(
					nextContext("denied.revoke", "user_bob"),
					first.metadata.credentialId,
				),
			).rejects.toMatchObject({ code: "not_found" });
		},
	);

	it("rolls back a changed current identity revision and a disabled final read", async () => {
		for (const disabled of [false, true]) {
			let reads = 0;
			resolveUser = async (id) => ({
				...currentUser(id),
				...(++reads > 1
					? disabled
						? { accountStatus: "disabled" }
						: { authorizationRevision: "revision_2" }
					: {}),
			});
			await expect(
				store().issue(nextContext(`race.${disabled}`), command),
			).rejects.toMatchObject({ code: disabled ? "forbidden" : "unavailable" });
			expect(reads).toBe(2);
		}
		expect(await counts()).toEqual({
			credentials: 0,
			idempotency: 0,
			succeeded: 0,
		});
	});

	it("rechecks database expiry after the last external identity call", async () => {
		const [clock] = await client`select clock_timestamp() as now`;
		const expiresAt = new Date(clock?.now.getTime() + 1500).toISOString();
		let reads = 0;
		resolveUser = async (id) => {
			if (++reads === 2) {
				for (;;) {
					const [time] =
						await client`select clock_timestamp() >= ${expiresAt}::timestamptz as expired`;
					if (time?.expired) break;
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
			return currentUser(id);
		};
		await expect(
			store().issue(context, { ...command, expiresAt }),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(reads).toBe(2);
		expect(await counts()).toEqual({
			credentials: 0,
			idempotency: 0,
			succeeded: 0,
		});
	});

	it("orders a concurrent disable INSERT even when no disable row existed", async () => {
		let release = () => {};
		let entered = () => {};
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let reads = 0;
		resolveUser = async (id) => {
			if (++reads === 1) {
				entered();
				await paused;
			}
			return currentUser(id);
		};
		const issuance = store().issue(context, command);
		await ready;
		const writer = postgres(database.databaseUrl, { max: 1 });
		const [backend] = await writer`select pg_backend_pid() as pid`;
		const disable = Promise.resolve(
			writer`insert into platform.platform_user_disables(user_id) values (${context.userId})`,
		);
		try {
			let blocked = false;
			for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
				const [activity] =
					await client`select wait_event_type from pg_stat_activity where pid=${backend?.pid}`;
				blocked = activity?.wait_event_type === "Lock";
				if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(blocked).toBe(true);
			release();
			expect((await issuance).credential).not.toBeNull();
			await disable;
			await expect(
				store().issue(nextContext("after.disable"), command),
			).rejects.toMatchObject({ code: "forbidden" });
		} finally {
			release();
			await Promise.allSettled([issuance, disable]);
			await writer.end();
		}
	});

	it("treats malformed persisted scopes as unavailable instead of client input", async () => {
		const adapter = store();
		await adapter.issue(context, command);
		await client`update platform.platform_api_credentials set scopes='[]'::jsonb`;
		await expect(adapter.issue(context, command)).rejects.toMatchObject({
			code: "unavailable",
		});
	});
});
