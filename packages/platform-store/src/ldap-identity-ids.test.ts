import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	type CurrentPlatformUserV1,
	PostgresLdapIdentityIds,
	PostgresPlatformUserDisablesV1,
} from "./ldap-identity-ids.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

const administrator = "00000000-0000-4000-8000-000000000001";
const target = "00000000-0000-4000-8000-000000000002";
let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let store: PostgresPlatformUserDisablesV1;
let identities: PostgresLdapIdentityIds;

beforeAll(async () => {
	database = await startPostgresTestDatabase("1758-governance");
	client = postgres(database.databaseUrl);
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	identities = new PostgresLdapIdentityIds(database.databaseUrl);
	store = new PostgresPlatformUserDisablesV1(
		database.databaseUrl,
		async (userId) =>
			userId === administrator
				? { userId, accountStatus: "active", isSystemAdmin: true }
				: userId === target
					? { userId, accountStatus: "active", isSystemAdmin: false }
					: null,
	);
});

afterAll(async () => {
	await identities?.close();
	await store?.close();
	await client?.end();
	await database?.stop();
});

it("reads an existing LDAP mapping without rewriting its row version", async () => {
	const issuer = randomUUID();
	const uid = "existing-uid";
	const userId = randomUUID();
	expect(await identities.getOrCreate(issuer, uid, userId)).toBe(userId);
	const before = await client`
		select user_id, xmin::text as version, ctid::text as tuple
		from platform.ldap_identity_ids where issuer=${issuer} and uid=${uid}
	`;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		expect(await identities.getOrCreate(issuer, uid, randomUUID())).toBe(
			userId,
		);
	}
	const after = await client`
		select user_id, xmin::text as version, ctid::text as tuple
		from platform.ldap_identity_ids where issuer=${issuer} and uid=${uid}
	`;
	expect(after).toEqual(before);
});

it("reads an existing LDAP mapping while another transaction holds its row lock", async () => {
	const issuer = randomUUID();
	const uid = "locked-uid";
	const userId = await identities.getOrCreate(issuer, uid, randomUUID());
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const locked = client
		.begin(async (sql) => {
			await sql`
				select user_id from platform.ldap_identity_ids
				where issuer=${issuer} and uid=${uid} for update
			`;
			held.resolve();
			await release.promise;
		})
		.catch((error) => {
			held.reject(error);
			throw error;
		});
	await held.promise;
	const lookup = identities.getOrCreate(issuer, uid, randomUUID());
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			lookup,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 1_000);
			}),
		]);
		expect(result).toBe(userId);
	} finally {
		clearTimeout(timer);
		release.resolve();
		await locked;
		await lookup;
	}
});

it("atomically keeps one original ID for concurrent first LDAP bindings", async () => {
	const second = new PostgresLdapIdentityIds(database.databaseUrl);
	const issuer = randomUUID();
	const uid = "concurrent-uid";
	const candidates = Array.from({ length: 8 }, () => randomUUID());
	try {
		const results = await Promise.all(
			candidates.map((candidate, index) =>
				(index % 2 === 0 ? identities : second).getOrCreate(
					issuer,
					uid,
					candidate,
				),
			),
		);
		expect(new Set(results).size).toBe(1);
		expect(candidates).toContain(results[0]);
		expect(await second.findByUid(issuer, uid)).toBe(results[0]);
		expect(
			await client`
				select user_id from platform.ldap_identity_ids
				where issuer=${issuer} and uid=${uid}
			`,
		).toEqual([{ user_id: results[0] }]);
	} finally {
		await second.close();
	}
});

it("keeps LDAP issuer and UID mappings isolated", async () => {
	const issuer = randomUUID();
	const otherIssuer = randomUUID();
	const first = await identities.getOrCreate(issuer, "uid-a", randomUUID());
	const second = await identities.getOrCreate(issuer, "uid-b", randomUUID());
	const third = await identities.getOrCreate(
		otherIssuer,
		"uid-a",
		randomUUID(),
	);
	expect(new Set([first, second, third]).size).toBe(3);
	expect(await identities.findByUid(issuer, "missing-uid")).toBeNull();
	expect(await identities.findUidByUserId(otherIssuer, first)).toBeNull();
	await expect(
		identities.getOrCreate(otherIssuer, "collision", first),
	).rejects.toThrow("LDAP_IDENTITY_STORE_UNAVAILABLE");
	expect(await identities.findByUid(otherIssuer, "collision")).toBeNull();
});

it("validates every input even when an LDAP mapping already exists", async () => {
	const issuer = randomUUID();
	const uid = "validated-uid";
	const userId = await identities.getOrCreate(issuer, uid, randomUUID());
	for (const [inputIssuer, inputUid, candidate] of [
		[issuer, uid, "invalid-candidate"],
		[issuer, uid, "00000000-0000-1000-8000-000000000000"],
		["", uid, randomUUID()],
		[issuer, "", randomUUID()],
		[`${issuer}\n`, uid, randomUUID()],
		[issuer, "\ud800", randomUUID()],
	] as const) {
		await expect(
			identities.getOrCreate(inputIssuer, inputUid, candidate),
		).rejects.toThrow("LDAP_IDENTITY_STORE_UNAVAILABLE");
	}
	expect(await identities.findByUid(issuer, uid)).toBe(userId);
});

it("fails closed when the LDAP identity database client is unavailable", async () => {
	const closed = new PostgresLdapIdentityIds(database.databaseUrl);
	await closed.close();
	await expect(
		closed.getOrCreate(randomUUID(), "unavailable-uid", randomUUID()),
	).rejects.toThrow("LDAP_IDENTITY_STORE_UNAVAILABLE");
});

it("rejects a Platform-disabled administrator inside the governance transaction", async () => {
	await client`insert into platform.platform_user_disables(user_id) values (${administrator})`;
	await expect(
		store.setPlatformDisabled({
			actorUserId: administrator,
			targetUserId: target,
			disabled: true,
			traceId: "trace-disabled-admin",
		}),
	).rejects.toMatchObject({ code: "not_authorized" });
	expect(
		await client`select user_id from platform.platform_user_disables where user_id=${target}`,
	).toHaveLength(0);
	await client`delete from platform.platform_user_disables where user_id=${administrator}`;
});

it("reads opaque user IDs for current Platform gates", async () => {
	const userId = "legacy_opaque_user_01";
	await client`insert into platform.platform_user_disables(user_id) values (${userId})`;
	try {
		expect(await store.isPlatformDisabled(userId)).toBe(true);
	} finally {
		await client`delete from platform.platform_user_disables where user_id=${userId}`;
	}
});

it("rolls back the disable when its required audit cannot be written", async () => {
	await client`
		create function platform.fail_platform_user_disable_audit()
		returns trigger as $$
		begin
			if NEW.action = 'platform.user.disabled' then
				raise exception 'governance audit failure sentinel';
			end if;
			return NEW;
		end;
		$$ language plpgsql
	`;
	await client`
		create trigger fail_platform_user_disable_audit
		before insert on platform.audit_events
		for each row execute function platform.fail_platform_user_disable_audit()
	`;
	try {
		await expect(
			store.setPlatformDisabled({
				actorUserId: administrator,
				targetUserId: target,
				disabled: true,
				traceId: "trace-audit-failure",
			}),
		).rejects.toMatchObject({ code: "dependency_unavailable" });
	} finally {
		await client`
			drop trigger fail_platform_user_disable_audit on platform.audit_events
		`;
		await client`drop function platform.fail_platform_user_disable_audit()`;
	}
	expect(
		await client`select user_id from platform.platform_user_disables where user_id=${target}`,
	).toHaveLength(0);
	expect(
		await client`select id from platform.audit_events where trace_id='trace-audit-failure'`,
	).toHaveLength(0);
});

it("rechecks external administrator authority before committing", async () => {
	let actorReads = 0;
	const raceStore = new PostgresPlatformUserDisablesV1(
		database.databaseUrl,
		async (userId): Promise<CurrentPlatformUserV1 | null> => {
			if (userId === administrator) {
				actorReads += 1;
				return actorReads === 1
					? { userId, accountStatus: "active", isSystemAdmin: true }
					: null;
			}
			return userId === target
				? { userId, accountStatus: "active", isSystemAdmin: false }
				: null;
		},
	);
	try {
		await expect(
			raceStore.setPlatformDisabled({
				actorUserId: administrator,
				targetUserId: target,
				disabled: true,
				traceId: "trace-directory-revoked",
			}),
		).rejects.toMatchObject({ code: "not_authorized" });
	} finally {
		await raceStore.close();
	}
	expect(actorReads).toBe(2);
	expect(
		await client`select user_id from platform.platform_user_disables where user_id=${target}`,
	).toHaveLength(0);
});

it("bounds a hanging directory lookup and releases its transaction", async () => {
	const stalledStore = new PostgresPlatformUserDisablesV1(
		database.databaseUrl,
		async () => new Promise<CurrentPlatformUserV1>(() => {}),
	);
	const startedAt = Date.now();
	try {
		await expect(
			stalledStore.setPlatformDisabled({
				actorUserId: administrator,
				targetUserId: target,
				disabled: true,
				traceId: "trace-directory-timeout",
			}),
		).rejects.toMatchObject({ code: "dependency_unavailable" });
	} finally {
		await stalledStore.close();
	}
	expect(Date.now() - startedAt).toBeLessThan(4_000);
	expect(await client`select 1 as released`).toEqual([{ released: 1 }]);
});
