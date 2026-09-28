import { resolve } from "node:path";
import { migrateDirectoryStore } from "@agent-infra/enterprise-directory-store";

const databaseUrl = process.env.DIRECTORY_MIGRATION_DATABASE_URL;
const runtimeRole = process.env.DIRECTORY_RUNTIME_DATABASE_ROLE;
if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
	throw new Error("DIRECTORY_MIGRATION_DATABASE_URL is required");
}
await migrateDirectoryStore(
	databaseUrl,
	resolve(import.meta.dirname, "../migrations/enterprise-directory"),
	runtimeRole,
);
