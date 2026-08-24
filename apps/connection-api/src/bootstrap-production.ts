import { migrateConnectionDatabase } from "@agent-infra/connection-store/migrations";

import { productionMigrationRuntimeConfig } from "./runtime-config";

const config = productionMigrationRuntimeConfig();
await migrateConnectionDatabase(config.databaseUrl, "migrations/connection");
// HLD G-01, G-02, and OC-01 prohibit publishing Direct MCP or a ProviderRelease
// before their external conformance evidence is accepted. This role only migrates.
