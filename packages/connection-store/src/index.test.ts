import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { assertIsolatedTestDatabaseUrl } from "./test-database";

describe("Connection integration database isolation", () => {
	it("rejects the runtime database even when credentials and query differ", () => {
		expect(() =>
			assertIsolatedTestDatabaseUrl(
				"postgresql://test:test@localhost/connection?sslmode=disable",
				"postgres://runtime:secret@127.0.0.1:5432/connection?sslmode=require",
			),
		).toThrow(
			"CONNECTION_TEST_DATABASE_URL must use a database separate from DATABASE_URL",
		);
	});

	it("allows a separate database on the same PostgreSQL server", () => {
		expect(() =>
			assertIsolatedTestDatabaseUrl(
				"postgresql://test:test@127.0.0.1:5432/connection_test",
				"postgresql://runtime:secret@127.0.0.1:5432/connection",
			),
		).not.toThrow();
	});
});

describe("Connection store migrations", () => {
	it("uses the formal Connection migration chain", async () => {
		const directory = resolve(
			import.meta.dirname,
			"../../../migrations/connection",
		);
		const journal = JSON.parse(
			await readFile(resolve(directory, "meta/_journal.json"), "utf8"),
		) as { entries: Array<{ tag: string }> };
		expect(journal.entries.map((entry) => entry.tag)).toEqual([
			"0000_connection",
			"0001_authorization_root_invariants",
			"0002_effect_state_invariants",
			"0003_reconciliation_lease",
			"0004_delegation_replay",
			"0005_connection_account_oauth",
			"0006_submission_started_uncertain",
			"0007_personal_access_tokens",
			"0008_consumer_instance_types",
			"0009_oauth_subject_recovery",
			"0010_connection_browser_sessions",
			"0011_legacy_principal_id_remap",
			"0012_legacy_principal_id_backfill",
			"0013_business_repository_invariants",
			"0014_authorization_preview_consent",
			"0015_consumer_declaration_authority",
			"0016_grant_pause_states",
			"0017_grant_status_transitions",
			"0018_connection_administrators",
			"0019_shared_github_connections",
			"0020_connection_owner_immutability",
			"0021_browser_command_idempotency",
			"0022_provider_scoped_consumer_declarations",
			"0023_consumer_declaration_provider_release_fk",
			"0024_provider_release_integrity",
			"0025_consumer_declaration_rolling_compatibility",
		]);
		for (const migration of journal.entries) {
			await access(resolve(directory, `${migration.tag}.sql`));
		}
	});

	it("runs migrations through Drizzle's PostgreSQL migrator", async () => {
		const source = await readFile(
			resolve(import.meta.dirname, "migrations.ts"),
			"utf8",
		);
		expect(source).toContain(
			'import { migrate } from "drizzle-orm/postgres-js/migrator"',
		);
		expect(source).toContain(
			"await migrate(drizzle(sql), { migrationsFolder: migrationsDirectory });",
		);
	});

	it("keeps authorization and effect invariants in forward migrations", async () => {
		const directory = resolve(
			import.meta.dirname,
			"../../../migrations/connection",
		);
		const authority = await readFile(
			resolve(directory, "0001_authorization_root_invariants.sql"),
			"utf8",
		);
		const effects = await readFile(
			resolve(directory, "0002_effect_state_invariants.sql"),
			"utf8",
		);
		const lease = await readFile(
			resolve(directory, "0003_reconciliation_lease.sql"),
			"utf8",
		);
		const replay = await readFile(
			resolve(directory, "0004_delegation_replay.sql"),
			"utf8",
		);
		const accounts = await readFile(
			resolve(directory, "0005_connection_account_oauth.sql"),
			"utf8",
		);
		const submission = await readFile(
			resolve(directory, "0006_submission_started_uncertain.sql"),
			"utf8",
		);
		const personalAccessTokens = await readFile(
			resolve(directory, "0007_personal_access_tokens.sql"),
			"utf8",
		);
		const consumerInstanceTypes = await readFile(
			resolve(directory, "0008_consumer_instance_types.sql"),
			"utf8",
		);
		const oauthSubjectRecovery = await readFile(
			resolve(directory, "0009_oauth_subject_recovery.sql"),
			"utf8",
		);
		const browserSessions = await readFile(
			resolve(directory, "0010_connection_browser_sessions.sql"),
			"utf8",
		);
		const principalIdRemap = await readFile(
			resolve(directory, "0011_legacy_principal_id_remap.sql"),
			"utf8",
		);
		const principalIdBackfill = await readFile(
			resolve(directory, "0012_legacy_principal_id_backfill.sql"),
			"utf8",
		);
		const grantPauseStates = await readFile(
			resolve(directory, "0016_grant_pause_states.sql"),
			"utf8",
		);
		expect(authority).toContain("DEFERRABLE INITIALLY DEFERRED");
		expect(effects).toContain("connection_enforce_status_transition");
		expect(lease).toContain("ADD COLUMN IF NOT EXISTS lease_id TEXT");
		expect(replay).toContain("connection_delegation_replay");
		expect(replay).toContain("connection_recovery_control");
		expect(accounts).toContain("connection_principal_identities");
		expect(accounts).toContain("connection_oauth_refresh_tokens");
		expect(accounts).toContain("COALESCE(actor_key, '')");
		const g08Gate = accounts.indexOf(
			"IF EXISTS (SELECT 1 FROM connection_authorization_roots)",
		);
		expect(g08Gate).toBeGreaterThanOrEqual(0);
		expect(accounts).toContain("OR EXISTS (SELECT 1 FROM connection_grants)");
		expect(accounts).toContain("RAISE EXCEPTION");
		expect(accounts).toContain(
			"G-08 blocks automatic migration of existing Connection authorization data",
		);
		expect(
			accounts.indexOf("ALTER TABLE connection_provider_releases"),
		).toBeGreaterThan(g08Gate);
		expect(submission).toContain(
			"OLD.status = 'SUBMISSION_STARTED' AND NEW.status IN ('SUCCEEDED', 'UNCERTAIN')",
		);
		expect(submission).not.toContain(
			"SUBMISSION_STARTED' AND NEW.status IN ('SUCCEEDED', 'FAILED'",
		);
		expect(personalAccessTokens).toContain("connection_personal_access_tokens");
		expect(personalAccessTokens).toContain("token_hash TEXT NOT NULL UNIQUE");
		expect(consumerInstanceTypes).toContain("'DEVICE', 'TOKEN', 'WORKLOAD'");
		expect(consumerInstanceTypes).toContain(
			"connection_personal_access_tokens_instance_subject_fkey",
		);
		expect(consumerInstanceTypes).toContain("SET kind = 'TOKEN'");
		expect(oauthSubjectRecovery).toContain("recovery_generation TEXT");
		expect(oauthSubjectRecovery).toContain(
			"connection_oauth_sessions_instance_subject_fkey",
		);
		expect(oauthSubjectRecovery).toContain("SET kind = 'TOKEN'");
		expect(browserSessions).toContain("connection_browser_sessions");
		expect(browserSessions).toContain("session_hash TEXT NOT NULL UNIQUE");
		expect(browserSessions).toContain(
			"connection_browser_sessions_identity_fkey",
		);
		expect(principalIdRemap).toContain("ON UPDATE CASCADE");
		expect(principalIdRemap).toContain(
			"connection_personal_access_tokens_instance_subject_fkey",
		);
		expect(principalIdBackfill).toContain("gen_random_uuid()::text");
		expect(principalIdBackfill).toContain(
			"WHERE id ~ '^principal-[0-9a-f]{64}$'",
		);
		expect(grantPauseStates).toContain("'PAUSED_CONNECTION'");
		expect(grantPauseStates).toContain("'PAUSED_CREDENTIAL'");
		expect(grantPauseStates).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
	});
});
