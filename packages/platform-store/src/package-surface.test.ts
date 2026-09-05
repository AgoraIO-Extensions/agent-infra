import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("platform-store package surface", () => {
	it("keeps migration configuration out of CLI failures", () => {
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("../dist/migrate-cli.mjs", import.meta.url))],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PLATFORM_DATABASE_URL: "https://user:secret@example.com/platform",
				},
			},
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("Platform migration failed\n");
	});

	it("publishes only Store adapters and packaged migrations", async () => {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/index.d.mts",
				import: "./dist/index.mjs",
			},
		});
		expect(manifest.files).toEqual(["dist"]);

		const surface = await import(
			new URL("../dist/index.mjs", import.meta.url).href
		);
		expect(Object.keys(surface).toSorted()).toEqual([
			"AgentConfigurationStoreError",
			"ApplicationRevisionStoreError",
			"OutboxStoreError",
			"PlatformAuditQueryError",
			"PostgresAgentConfigurationQueryV1",
			"PostgresAgentConfigurationTransactionV1",
			"PostgresAgentManagementQueryV1",
			"PostgresAgentManagementTransactionV1",
			"PostgresApplicationFoundationTransactionV1",
			"PostgresApplicationRevisionTransactionV1",
			"PostgresConversationEventTransactionV1",
			"PostgresConversationExecutionTransactionV1",
			"PostgresPlatformAuditQueryV1",
			"createPostgresOutboxStore",
			"migratePlatformDatabase",
			"openPostgresPlatformIdempotencyStore",
			"platformDatabaseUrlFromEnvironment",
		]);

		const pack = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
				cwd: packageRoot,
				encoding: "utf8",
			}),
		)[0];
		const packedFiles = pack.files.map((file: { path: string }) => file.path);
		expect(packedFiles).toEqual(
			expect.arrayContaining([
				"dist/index.d.mts",
				"dist/index.mjs",
				"dist/migrations/0000_platform_infrastructure.sql",
				"dist/migrations/0001_application_foundation.sql",
				"dist/migrations/0002_agent_persistence.sql",
				"dist/migrations/0003_secret_records.sql",
				"dist/migrations/0004_conversation_execution.sql",
				"dist/migrations/0005_conversation_events.sql",
				"dist/migrations/meta/0000_snapshot.json",
				"dist/migrations/meta/0001_snapshot.json",
				"dist/migrations/meta/0002_snapshot.json",
				"dist/migrations/meta/0003_snapshot.json",
				"dist/migrations/meta/0004_snapshot.json",
				"dist/migrations/meta/0005_snapshot.json",
				"dist/migrations/meta/_journal.json",
			]),
		);
		expect(
			packedFiles.some((path: string) =>
				/schema|postgres|drizzle|test/.test(path),
			),
		).toBe(false);
	});
});
