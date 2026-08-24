import { resolve } from "node:path";
import { migrateConnectionDatabase } from "@agent-infra/connection-store/migrations";

import { startConnectionApi } from "./index";
import { createConnectionRuntimeApp } from "./runtime-app";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
await migrateConnectionDatabase(
	databaseUrl,
	resolve(import.meta.dirname, "../../../migrations/connection"),
);
startConnectionApi({
	app: await createConnectionRuntimeApp(),
	hostname: "127.0.0.1",
});
