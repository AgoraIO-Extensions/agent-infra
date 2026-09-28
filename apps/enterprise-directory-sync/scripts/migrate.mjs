import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DIRECTORY_MIGRATION_DATABASE_URL;
if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
	throw new Error("DIRECTORY_MIGRATION_DATABASE_URL is required");
}
const sql = postgres(databaseUrl, { max: 1 });
try {
	const migration = await readFile(
		resolve(
			import.meta.dirname,
			"../migrations/enterprise-directory/0000_snapshot.sql",
		),
		"utf8",
	);
	await sql.unsafe(migration);
} finally {
	await sql.end();
}
