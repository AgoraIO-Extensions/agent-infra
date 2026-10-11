import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	type CurrentPlatformUserV1,
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

beforeAll(async () => {
	database = await startPostgresTestDatabase("1758-governance");
	client = postgres(database.databaseUrl);
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
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
	await store?.close();
	await client?.end();
	await database?.stop();
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
