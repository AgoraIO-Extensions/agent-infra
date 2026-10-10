import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresPlatformUserDisablesV1 } from "./ldap-identity-ids.js";
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
});
