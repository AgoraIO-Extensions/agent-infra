import { describe, expect, it } from "vitest";

import { connectionDatabaseUrlFromEnvironment } from "./migrate.js";
import { connectionInfrastructureTables } from "./schema.js";

describe("Connection store boundary", () => {
	it("requires a PostgreSQL URL and never defaults to SQLite", () => {
		expect(() => connectionDatabaseUrlFromEnvironment({})).toThrow(
			/CONNECTION_DATABASE_URL is required/,
		);
		expect(() =>
			connectionDatabaseUrlFromEnvironment({
				CONNECTION_DATABASE_URL: "sqlite://local",
			}),
		).toThrow(/PostgreSQL URL/);
		expect(
			connectionDatabaseUrlFromEnvironment({
				CONNECTION_DATABASE_URL: "postgresql://localhost/connection",
			}),
		).toBe("postgresql://localhost/connection");
	});

	it("owns the complete Connection authority table set", () => {
		expect(
			connectionInfrastructureTables.map(
				(table) => table[Symbol.for("drizzle:Name") as never],
			),
		).toEqual([
			"principals",
			"browser_sessions",
			"login_throttle_attempts",
			"login_throttle_failures",
			"consumers",
			"consumer_instances",
			"actors",
			"providers",
			"provider_releases",
			"action_versions",
			"connections",
			"credential_versions",
			"grants",
			"grant_actions",
			"current_grant_actions",
			"action_calls",
			"effects",
			"dispatches",
			"audit_events",
		]);
	});
});
