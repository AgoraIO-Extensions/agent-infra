import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

let database: PostgresTestDatabase | undefined;

beforeAll(async () => {
	database = await startPostgresTestDatabase("database-jit");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
}, 120_000);

afterAll(async () => {
	await database?.stop();
});

it("turns JIT off for every new Platform connection (#3456)", async () => {
	const client = postgres(database?.databaseUrl ?? "", { max: 1 });
	try {
		const [row] = await client<
			{ jit: string }[]
		>`select current_setting('jit') as jit`;
		expect(row?.jit).toBe("off");
	} finally {
		await client.end();
	}
});
